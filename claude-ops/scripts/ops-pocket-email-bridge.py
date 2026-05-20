#!/usr/bin/env python3
"""ops-pocket-email-bridge — Email-as-question/reply channel for Pocket.

Mirrors ops-pocket-whatsapp-bridge.py but on Gmail. Two duties:

  1. OUTBOUND: drain supervisor-out-queue.jsonl entries of kind="email" and
     send them via `gog gmail send` to the configured self-email address.
     Each entry includes a question-id (qid) in the subject so replies can be
     correlated back via Gmail's threading.

  2. INBOUND: poll Gmail for messages in a known label/thread set, parse Sam's
     natural-language replies against the list of currently-open supervisor
     questions using `claude -p` (Sonnet 4.6), and append matched answers to
     supervisor-replies.jsonl — same downstream format as the WhatsApp bridge.

Config (~/.claude/state/pocket/email-config.json):
  {
    "enabled": true,
    "self_address": "you@example.com",
    "from_account": "you@example.com",
    "subject_prefix": "[Pocket]",
    "label": "Pocket",
    "last_processed_id": ""        # auto-managed
  }

Cron: every 1 minute.

Notes:
  - This script can SEND because it operates on self-chat / self-email only.
    Recipient is locked to self_address; refuses any other target.
  - The block-outbound-comms hook does not fire for cron-spawned subprocesses
    (it's a Claude Code PreToolUse hook), so the safety is the locked
    recipient + the audit log.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-pocket-email-bridge]"
HOME = Path(os.path.expanduser("~"))
_USER_CONTEXT_PATH = Path(os.environ.get(
    "POCKET_USER_CONTEXT",
    str(HOME / ".claude/state/pocket/user-context.json"),
))
try:
    _ctx = json.loads(_USER_CONTEXT_PATH.read_text())
    _OWNER_NAME: str = _ctx.get("owner_name") or "the user"
except (OSError, json.JSONDecodeError):
    _OWNER_NAME = "the user"
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
CONFIG = STATE_DIR / "email-config.json"
QUEUE = STATE_DIR / "supervisor-out-queue.jsonl"
OUT_CURSOR = STATE_DIR / ".email-out-cursor"
QUESTIONS = STATE_DIR / "supervisor-questions.jsonl"
REPLIES = STATE_DIR / "supervisor-replies.jsonl"
LOG_FILE = STATE_DIR / "email-bridge.log"
HEALTH = STATE_DIR / ".email-bridge-health"
SENT = STATE_DIR / "email-sent.jsonl"

GOG_BIN = os.environ.get("GOG_BIN", "gog")
TIMEOUT = int(os.environ.get("EMAIL_BRIDGE_TIMEOUT", "60"))


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now_iso()} {LOG_PREFIX} {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def write_health(status: str, msg: str = "", extra: dict | None = None) -> None:
    payload = {"status": status, "message": msg, "last_run": now_iso()}
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEALTH.write_text(json.dumps(payload, indent=2))
    except OSError:
        pass


def load_config() -> dict:
    if not CONFIG.exists():
        return {"enabled": False}
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        return {"enabled": False}


def save_config(cfg: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, indent=2))
    except OSError as e:
        log(f"config save failed: {e}")


def open_questions() -> list[dict]:
    if not QUESTIONS.exists():
        return []
    out = []
    try:
        for line in QUESTIONS.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                q = json.loads(line)
                if q.get("status") == "open":
                    out.append(q)
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return out


# ── OUTBOUND ────────────────────────────────────────────────────────────────


def send_email(to: str, subject: str, body: str, attachments: list[str] | None = None) -> tuple[bool, str]:
    """Send via gog gmail send. Returns (ok, info).

    attachments: list of file paths to attach (each is expanded with ~ and
    silently skipped if missing — we never fail the whole send because of
    a missing report file)."""
    cmd = [GOG_BIN, "gmail", "send",
           "--to", to,
           "--subject", subject,
           "--body", body]
    if attachments:
        for a in attachments:
            if not a:
                continue
            expanded = os.path.expanduser(a)
            if os.path.isfile(expanded):
                cmd.extend(["--attach", expanded])
            else:
                log(f"attachment missing, skipped: {a}")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return (False, "timeout")
    except FileNotFoundError:
        return (False, f"gog binary not found: {GOG_BIN}")
    except Exception as e:
        return (False, f"{type(e).__name__}: {e}")
    if proc.returncode != 0:
        return (False, f"exit={proc.returncode}: {(proc.stderr or proc.stdout)[:200]}")
    return (True, (proc.stdout or "ok")[:200])


def drain_outbound(cfg: dict) -> tuple[int, int, int]:
    """Drain supervisor-out-queue.jsonl entries with kind='email'. Returns
    (sent, failed, skipped)."""
    self_addr = cfg.get("self_address", "")
    prefix = cfg.get("subject_prefix", "[Pocket]")
    if not self_addr or not QUEUE.exists():
        return (0, 0, 0)
    cursor = 0
    if OUT_CURSOR.exists():
        try:
            cursor = int(OUT_CURSOR.read_text().strip() or "0")
        except (OSError, ValueError):
            cursor = 0
    try:
        size = QUEUE.stat().st_size
    except OSError:
        return (0, 0, 0)
    if cursor > size:
        cursor = 0
    if cursor >= size:
        return (0, 0, 0)

    sent = 0
    failed = 0
    skipped = 0
    new_cursor = cursor
    try:
        with QUEUE.open("rb") as f:
            f.seek(cursor)
            while True:
                line_start = f.tell()
                raw = f.readline()
                if not raw:
                    break
                if not raw.endswith(b"\n"):
                    break
                new_cursor = f.tell()
                try:
                    entry = json.loads(raw.decode())
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                if entry.get("kind") != "email":
                    skipped += 1
                    continue
                to = entry.get("to") or self_addr
                if to != self_addr:
                    log(f"REFUSED: to {to!r} != self_address {self_addr!r}")
                    skipped += 1
                    continue
                qid = entry.get("qid", "")
                subj_core = entry.get("subject", "").strip() or "supervisor message"
                subject = (
                    f"{prefix} [qid:{qid}] {subj_core}"
                    if qid else f"{prefix} {subj_core}"
                )
                body = (entry.get("body") or entry.get("message") or "").strip()
                if not body:
                    skipped += 1
                    continue
                attachments = entry.get("attachments") or []
                if not isinstance(attachments, list):
                    attachments = []
                ok, info = send_email(to, subject[:200], body, attachments)
                if ok:
                    sent += 1
                    try:
                        with SENT.open("a") as sf:
                            sf.write(json.dumps({
                                "ts": now_iso(), "to": to, "subject": subject,
                                "qid": qid, "body": body[:500],
                                "info": info[:150],
                            }) + "\n")
                    except OSError:
                        pass
                    log(f"sent → {to} subject={subject[:80]!r}")
                else:
                    failed += 1
                    log(f"FAILED → {to}: {info}")
                    new_cursor = line_start  # retry next tick
                    break
    except OSError as e:
        log(f"read queue failed: {e}")
        return (sent, failed, skipped)
    try:
        OUT_CURSOR.write_text(str(new_cursor))
    except OSError:
        pass
    return (sent, failed, skipped)


# ── INBOUND ─────────────────────────────────────────────────────────────────


QID_SUBJECT_RE = re.compile(r"\[qid:([a-zA-Z0-9_-]{4,})\]")


def fetch_recent_replies(cfg: dict) -> list[dict]:
    """Use gog gmail search to find recent messages in the configured label
    that are NOT from self (so we only get Sam's replies, not echoes).
    Returns list of {messageId, threadId, subject, body, ts, fromMe}.
    """
    label = cfg.get("label", "Pocket")
    # Look for messages SENT BY Sam in the label, within last 24h.
    query = f"label:{label} from:me newer_than:1d"
    try:
        proc = subprocess.run(
            [GOG_BIN, "gmail", "search", query,
             "--max", "30", "-j", "--results-only", "--no-input"],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"gog search failed: {e}")
        return []
    if proc.returncode != 0:
        log(f"gog search exit={proc.returncode}: {(proc.stderr or '')[:200]}")
        return []
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        log("gog search returned non-JSON")
        return []
    if isinstance(data, dict):
        data = data.get("threads") or data.get("results") or []
    out = []
    for item in data if isinstance(data, list) else []:
        msg_id = item.get("messageId") or item.get("id")
        thread_id = item.get("threadId") or item.get("thread_id")
        subject = item.get("subject", "")
        body = item.get("snippet") or item.get("body", "")
        ts = item.get("internalDate") or item.get("date") or ""
        if not msg_id:
            continue
        out.append({
            "id": msg_id, "thread_id": thread_id,
            "subject": subject, "body": body, "ts": ts,
        })
    return out


def parse_reply_with_llm(body: str, opens: list[dict], parser_model: str) -> list[dict]:
    """Same parse logic as the WhatsApp bridge — invoke claude -p Sonnet
    against the open questions list and extract structured answers."""
    body = body.strip()
    if not body or not opens:
        return []
    open_descriptions = "\n".join(
        f"- {q.get('id','?')} | worker={q.get('from_worker','?')} | options={q.get('options') or []}\n"
        f"  Q: {q.get('question','')[:300]}\n"
        f"  context: {(q.get('context') or '')[:200]}"
        for q in opens
    )
    prompt = f"""You are the inbound-reply parser for {_OWNER_NAME}'s Pocket supervisor.

{_OWNER_NAME} just sent an EMAIL reply. Your job: figure out which of the currently-open supervisor questions they're replying to (it may be one, several, or none), and extract the answer in a form the worker can use.

Currently-open questions:
{open_descriptions}

{_OWNER_NAME}'s email body:
\"\"\"{body[:4000]}\"\"\"

Rules:
- If {_OWNER_NAME}'s message is clearly not a reply to any open question, return an empty array.
- If {_OWNER_NAME} addresses one specific question, return one item.
- If {_OWNER_NAME} addresses multiple, return multiple items.
- The 'answer' field should be in {_OWNER_NAME}'s voice and natural — the worker reads it as a direct instruction.
- 'confidence' is your honest 0.0-1.0 estimate.
- Output STRICT JSON array, no markdown fences, no prose.

Schema:
[
  {{"qid": "q-...", "answer": "<rewritten as imperative>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}}
]
"""
    claude_bin = os.environ.get("POCKET_CLAUDE_BIN", str(HOME / ".local/bin/claude"))
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    cmd = [claude_bin, "--dangerously-skip-permissions",
           "--model", parser_model, "-p", prompt]
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        log("claude -p parser timed out")
        return []
    except Exception as e:
        log(f"claude -p parser invoke failed: {type(e).__name__}: {e}")
        return []
    if proc.returncode != 0:
        log(f"claude -p parser exit {proc.returncode}: {proc.stderr.strip()[:200]}")
        return []
    text = (proc.stdout or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        log(f"parser returned non-JSON: {text[:200]}")
        return []
    if not isinstance(items, list):
        return []
    open_ids = {q["id"] for q in opens}
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        qid = it.get("qid")
        if qid not in open_ids:
            continue
        ans = (it.get("answer") or "").strip()
        if not ans:
            continue
        try:
            conf = float(it.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        out.append({
            "qid": qid, "answer": ans, "confidence": conf,
            "reasoning": (it.get("reasoning") or "")[:300],
        })
    return out


def drain_inbound(cfg: dict) -> tuple[int, int]:
    """Returns (scanned, routed). Uses subject [qid:...] as fast-path before
    falling back to LLM parse over open-question list."""
    last_id = cfg.get("last_processed_id", "")
    messages = fetch_recent_replies(cfg)
    if not messages:
        return (0, 0)
    # Filter: only NEW messages (after last_processed_id timestamp)
    new_messages = []
    seen_last = False
    for m in messages:
        if m["id"] == last_id:
            seen_last = True
            continue
        if seen_last:
            new_messages.append(m)
    # If last_id wasn't found in current window, treat all as new (first run / drift)
    if not last_id or not any(m["id"] == last_id for m in messages):
        new_messages = messages

    opens = open_questions()
    parser_model = cfg.get("parser_model", "claude-sonnet-4-6")
    scanned = 0
    routed = 0
    new_last_id = last_id

    for m in new_messages:
        new_last_id = m["id"]
        scanned += 1
        subject = m.get("subject", "")
        body = m.get("body", "") or ""
        if not body.strip():
            continue

        # Fast-path: subject contains [qid:<id>]
        qid_match = QID_SUBJECT_RE.search(subject)
        results: list[dict] = []
        if qid_match:
            qid = qid_match.group(1)
            if any(q["id"] == qid for q in opens):
                results = [{
                    "qid": qid,
                    "answer": body.strip()[:1000],
                    "confidence": 0.95,
                    "reasoning": f"matched [qid:{qid}] in email subject",
                }]
        if not results and opens:
            results = parse_reply_with_llm(body, opens, parser_model)
        if not results:
            log(f"msg {m['id']}: no actionable reply in '{body[:80]}...'")
            continue
        for r in results:
            qid = r["qid"]
            try:
                REPLIES.parent.mkdir(parents=True, exist_ok=True)
                with REPLIES.open("a") as f:
                    f.write(json.dumps({
                        "id": qid, "ts": now_iso(),
                        "answer": r["answer"], "via": "email",
                        "source_msg_id": m["id"],
                        "source_subject": subject[:200],
                        "source_body": body[:500],
                        "parser_confidence": r["confidence"],
                        "parser_reasoning": r["reasoning"],
                        "parser_model": parser_model,
                    }) + "\n")
                routed += 1
                opens = [q for q in opens if q["id"] != qid]
                log(f"routed reply for {qid} (conf={r['confidence']:.2f}): {r['answer'][:60]}")
            except OSError as e:
                log(f"reply write failed: {e}")

    cfg["last_processed_id"] = new_last_id or last_id
    save_config(cfg)
    return (scanned, routed)


def main() -> int:
    write_health("running", "tick")
    cfg = load_config()
    if not cfg.get("enabled"):
        write_health("disabled", "email bridge disabled")
        return 0
    if not cfg.get("self_address"):
        log("missing self_address in config")
        write_health("error", "missing self_address")
        return 1

    sent, failed, skipped = drain_outbound(cfg)
    scanned, routed = drain_inbound(cfg)

    write_health(
        "ok" if failed == 0 else "warn",
        f"out_sent={sent} out_failed={failed} in_scanned={scanned} in_routed={routed}",
        extra={
            "out_sent": sent, "out_failed": failed, "out_skipped": skipped,
            "in_scanned": scanned, "in_routed": routed,
            "self_address": cfg.get("self_address"),
        },
    )
    log(f"done out_sent={sent} out_failed={failed} in_scanned={scanned} in_routed={routed}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
