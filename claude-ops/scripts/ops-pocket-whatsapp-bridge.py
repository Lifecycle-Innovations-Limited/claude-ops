#!/usr/bin/env python3
"""ops-pocket-whatsapp-bridge — WhatsApp ↔ supervisor question/reply bridge.

Inbound: polls the Baileys bridge SQLite DB for new messages in the
designated "pocket" chat. Each new message from the owner is passed to `claude -p`
along with the list of currently-open supervisor questions. Claude figures
out which question the owner is replying to (if any) and extracts the answer in
natural language. The structured result is appended to supervisor-replies.jsonl
so the supervisor relays back to the asking worker on its next wake.

This means the owner can reply naturally:
  "just do report only, don't auto-archive"
  "skip the kitchen one, audit gmail though"
  "yeah go ahead with option 2"
The LLM handles disambiguation, multi-question resolution, and intent
extraction.

Outbound: not handled here. The supervisor itself fires WhatsApp notifications
via mcp__whatsapp__send_message (Claude Code MCP) — that path lives in the
supervisor prompt.

Config (~/.claude/state/pocket/whatsapp-config.json):
  {
    "chat_jid": "31612345678@s.whatsapp.net",       # required
    "last_processed_id": "BAE12345...",             # auto-managed
    "enabled": true,
    "parser_model": "claude-sonnet-4-6"             # optional override
  }

Cron: every 1min.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-pocket-whatsapp-bridge]"
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
BRIDGE_DB = Path(os.environ.get(
    "POCKET_WHATSAPP_DB",
    str(HOME / ".local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db"),
))
CONFIG = STATE_DIR / "whatsapp-config.json"
REPLIES = STATE_DIR / "supervisor-replies.jsonl"
QUESTIONS = STATE_DIR / "supervisor-questions.jsonl"
LOG_FILE = STATE_DIR / "whatsapp-bridge.log"
HEALTH = STATE_DIR / ".whatsapp-bridge-health"

QID_RE = re.compile(r"\b(q-[a-zA-Z0-9_-]{4,})\b")


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
    except OSError as e:
        log(f"health write failed: {e}")


def load_config() -> dict:
    if not CONFIG.exists():
        return {"enabled": False}
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, json.JSONDecodeError) as e:
        log(f"config unreadable: {e}")
        return {"enabled": False}


def save_config(cfg: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, indent=2))
    except OSError as e:
        log(f"config save failed: {e}")


def open_questions() -> list[dict]:
    """Returns the list of open question objects (full payload, not just ids)."""
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
            except json.JSONDecodeError:
                continue
            if not isinstance(q, dict):
                continue
            if q.get("status") != "open":
                continue
            if not q.get("id"):
                log(f"skipping malformed open question (no id): {str(q)[:120]}")
                continue
            out.append(q)
    except OSError:
        pass
    return out


def parse_with_llm(body: str, opens: list[dict], parser_model: str) -> list[dict]:
    """Use `claude -p` to interpret the owner's natural-language reply against the
    list of currently-open questions. Returns a list of {qid, answer, confidence}
    items (may be empty if Claude judged this message is not a reply at all).
    """
    body = body.strip()
    if not body:
        return []
    if not opens:
        return []

    open_descriptions = "\n".join(
        f"- {q.get('id','?')} | worker={q.get('from_worker','?')} | options={q.get('options') or []}\n"
        f"  Q: {q.get('question','')[:300]}\n"
        f"  context: {(q.get('context') or '')[:200]}"
        for q in opens
    )

    prompt = f"""You are the inbound-reply parser for {_OWNER_NAME}'s Pocket supervisor.

{_OWNER_NAME} just sent a WhatsApp message. Your job: figure out which of the currently-open supervisor questions they're replying to (it may be one, several, or none), and extract the answer in a form the worker can use.

Currently-open questions:
{open_descriptions}

{_OWNER_NAME}'s WhatsApp message:
\"\"\"{body}\"\"\"

Rules:
- If {_OWNER_NAME}'s message is clearly not a reply to any open question (chit-chat, unrelated request, ambiguous noise), return an empty array.
- If {_OWNER_NAME} addresses one specific question, return one item.
- If {_OWNER_NAME} addresses multiple in one message ("skip both kitchen ones, do the gmail one"), return multiple items.
- The 'answer' field should be in {_OWNER_NAME}'s voice and natural — the worker reads it as a direct instruction.
- 'confidence' is your honest 0.0-1.0 estimate that you correctly identified the question + intent.
- Output STRICT JSON, no markdown fences, no prose. Just the array.

Schema:
[
  {{"qid": "q-...", "answer": "<rewritten as imperative instruction>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}}
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
    # Validate each item
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


def main() -> int:
    write_health("running", "tick")
    cfg = load_config()
    if not cfg.get("enabled"):
        log("WhatsApp bridge disabled (no chat_jid configured) — see `pocket whatsapp-setup`")
        write_health("disabled", "no chat_jid configured")
        return 0

    chat_jid = cfg.get("chat_jid")
    if not chat_jid:
        log("config missing chat_jid")
        write_health("error", "missing chat_jid")
        return 1
    last_id = cfg.get("last_processed_id", "")

    if not BRIDGE_DB.exists():
        log(f"bridge db missing at {BRIDGE_DB}")
        write_health("error", "bridge db missing")
        return 2

    try:
        conn = sqlite3.connect(f"file:{BRIDGE_DB}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as e:
        log(f"sqlite open failed: {e}")
        write_health("error", f"sqlite: {e}")
        return 3

    # Only inbound messages from this chat after the last_processed cursor.
    # `is_from_me=1` are the owner's own replies (this bridge only listens to those).
    # We accept both ID-based and timestamp-based cursors.
    try:
        if last_id:
            cur = conn.execute("""
                SELECT id, timestamp, content
                FROM messages
                WHERE chat_jid = ? AND is_from_me = 1
                  AND timestamp > (SELECT timestamp FROM messages WHERE id = ? AND chat_jid = ?)
                ORDER BY timestamp ASC
                LIMIT 200
            """, (chat_jid, last_id, chat_jid))
        else:
            # First run — take only the last 60 minutes to avoid replaying history
            cur = conn.execute("""
                SELECT id, timestamp, content
                FROM messages
                WHERE chat_jid = ? AND is_from_me = 1
                  AND timestamp >= datetime('now', '-60 minutes')
                ORDER BY timestamp ASC
                LIMIT 200
            """, (chat_jid,))
        rows = cur.fetchall()
    except sqlite3.Error as e:
        log(f"sqlite query failed: {e}")
        write_health("error", f"sqlite query: {e}")
        return 4

    opens = open_questions()
    parser_model = cfg.get("parser_model", "claude-sonnet-4-6")
    processed = 0
    matched = 0
    new_last_id = last_id

    for row in rows:
        new_last_id = row["id"]
        processed += 1
        body = row["content"] or ""
        if not body.strip():
            continue
        # No open questions → nothing to route. Skip the LLM call to save tokens.
        if not opens:
            continue
        results = parse_with_llm(body, opens, parser_model)
        if not results:
            log(f"msg {row['id']}: parser found no actionable reply in '{body[:80]}...'")
            continue
        for r in results:
            qid = r["qid"]
            try:
                REPLIES.parent.mkdir(parents=True, exist_ok=True)
                with REPLIES.open("a") as f:
                    f.write(json.dumps({
                        "id": qid,
                        "ts": now_iso(),
                        "answer": r["answer"],
                        "via": "whatsapp",
                        "source_msg_id": row["id"],
                        "source_body": body[:500],
                        "parser_confidence": r["confidence"],
                        "parser_reasoning": r["reasoning"],
                        "parser_model": parser_model,
                    }) + "\n")
                matched += 1
                log(f"routed reply for {qid} (conf={r['confidence']:.2f}): {r['answer'][:60]}")
                # Remove from open set so a follow-up message doesn't double-match the same Q
                opens = [q for q in opens if q["id"] != qid]
            except OSError as e:
                log(f"reply write failed: {e}")

    cfg["last_processed_id"] = new_last_id or last_id
    save_config(cfg)

    write_health("ok", f"scanned={processed} routed={matched}", extra={
        "scanned": processed, "routed": matched, "open_questions": len(opens),
        "chat_jid": chat_jid,
    })
    log(f"done scanned={processed} routed={matched}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
