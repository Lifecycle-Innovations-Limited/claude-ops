#!/usr/bin/env python3
"""ops-pocket-activity-notifier — Notify Sam on WhatsApp when pocket agents
pick up work and when they complete it.

Watches two signals under ~/.claude/state/pocket/:
  1. spawn-ledger.jsonl   — appended when supervisor dispatches a worker
                            to a pocket-derived task (START event)
  2. executor-results/*.{done,completed}.json — created when a worker
                            finishes (COMPLETE event)

For each new event, append a {"kind":"whatsapp", ...} entry to
supervisor-out-queue.jsonl. ops-pocket-out-queue (existing cron) drains
that queue to the Baileys bridge.

Idempotency:
  - spawn-ledger.jsonl is tailed via byte cursor at .activity-notifier.spawn-cursor
  - executor-results files are tracked via .activity-notifier.seen-results (set of basenames)

Filters:
  - Only notify on tasks sourced from pocket (id prefix "inferred-" OR
    "pocket_task_id" present in the ledger entry / result file).
  - Smoketests (id starting with "smoketest-" or "tasklist-verify-") are skipped.

Cron: every 1 minute.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-pocket-activity-notifier]"
HOME = Path(os.path.expanduser("~"))
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))

WHATSAPP_CONFIG = STATE_DIR / "whatsapp-config.json"
EMAIL_CONFIG = STATE_DIR / "email-config.json"
TASKS = STATE_DIR / "tasks.jsonl"
SPAWN_LEDGER = STATE_DIR / "spawn-ledger.jsonl"
RESULTS_DIR = STATE_DIR / "executor-results"
OUT_QUEUE = STATE_DIR / "supervisor-out-queue.jsonl"

SPAWN_CURSOR = STATE_DIR / ".activity-notifier.spawn-cursor"
SEEN_RESULTS = STATE_DIR / ".activity-notifier.seen-results"
LOG_FILE = STATE_DIR / "activity-notifier.log"
HEALTH = STATE_DIR / ".activity-notifier-health"

SKIP_PREFIXES = ("smoketest-", "tasklist-verify-", "teams-smoketest-")


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


def write_health(status: str, msg: str, extra: dict | None = None) -> None:
    payload = {"status": status, "message": msg, "last_run": now_iso()}
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEALTH.write_text(json.dumps(payload, indent=2))
    except OSError:
        pass


def load_chat_jid() -> str | None:
    if not WHATSAPP_CONFIG.exists():
        return None
    try:
        cfg = json.loads(WHATSAPP_CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not cfg.get("enabled"):
        return None
    return cfg.get("chat_jid")


def load_email_target() -> str | None:
    """Return self-address if email channel is enabled, else None."""
    if not EMAIL_CONFIG.exists():
        return None
    try:
        cfg = json.loads(EMAIL_CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not cfg.get("enabled"):
        return None
    return cfg.get("self_address") or None


def load_task_titles() -> dict:
    """Return {task_id: title} from tasks.jsonl."""
    titles = {}
    if not TASKS.exists():
        return titles
    try:
        with TASKS.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    t = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                tid = t.get("id")
                if tid:
                    titles[tid] = t.get("title", "")
    except OSError:
        pass
    return titles


def should_skip(task_id: str | None) -> bool:
    if not task_id:
        return True
    return any(task_id.startswith(p) for p in SKIP_PREFIXES)


def enqueue_whatsapp(chat_jid: str, message: str, media_path: str = "") -> None:
    entry = {
        "ts": now_iso(),
        "kind": "whatsapp",
        "chat_jid": chat_jid,
        "message": message,
    }
    if media_path:
        entry["media_path"] = media_path
    with OUT_QUEUE.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def enqueue_email(to: str, subject: str, body: str, attachments: list | None = None) -> None:
    entry = {
        "ts": now_iso(),
        "kind": "email",
        "to": to,
        "subject": subject,
        "body": body,
    }
    if attachments:
        entry["attachments"] = list(attachments)
    with OUT_QUEUE.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _resolve_attachment(p: str) -> str:
    """Expand ~ and return absolute path if file exists, else empty."""
    if not p:
        return ""
    expanded = os.path.expanduser(p)
    return expanded if os.path.isfile(expanded) else ""


def process_spawns(chat_jid: str | None, email_to: str | None, titles: dict) -> int:
    """Tail spawn-ledger.jsonl from cursor; enqueue START events to all
    configured channels. Returns number of source-events processed."""
    if not SPAWN_LEDGER.exists():
        return 0
    cursor = 0
    if SPAWN_CURSOR.exists():
        try:
            cursor = int(SPAWN_CURSOR.read_text().strip() or "0")
        except (OSError, ValueError):
            cursor = 0
    try:
        size = SPAWN_LEDGER.stat().st_size
    except OSError:
        return 0
    if cursor > size:
        cursor = 0
    if cursor >= size:
        return 0

    sent = 0
    new_cursor = cursor
    with SPAWN_LEDGER.open("rb") as f:
        f.seek(cursor)
        while True:
            line_start = f.tell()
            raw = f.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break  # partial write, retry next tick
            new_cursor = f.tell()
            try:
                entry = json.loads(raw.decode())
            except json.JSONDecodeError:
                continue
            task_id = entry.get("pocket_task_id") or entry.get("task_id")
            if should_skip(task_id):
                continue
            title = entry.get("title") or titles.get(task_id, "")
            worker = entry.get("worker", "worker")
            wa_msg = (
                f"pocket-agent START\n"
                f"task: {task_id}\n"
                f"title: {title[:200]}\n"
                f"worker: {worker}"
            )
            email_body = (
                f"A pocket agent has started work on a task derived from a "
                f"voice memo.\n\n"
                f"task id: {task_id}\n"
                f"title:   {title}\n"
                f"worker:  {worker}\n\n"
                f"You will receive a DONE notification with the report "
                f"attached when this completes.\n"
            )
            email_subject = f"START — {(title or task_id)[:80]}"
            enqueue_errors: list[str] = []
            if chat_jid:
                try:
                    enqueue_whatsapp(chat_jid, wa_msg)
                except OSError as e:
                    log(f"enqueue START whatsapp failed: {e}")
                    enqueue_errors.append("whatsapp")
            if email_to:
                try:
                    enqueue_email(email_to, email_subject, email_body)
                except OSError as e:
                    log(f"enqueue START email failed: {e}")
                    enqueue_errors.append("email")
            channels_configured = (1 if chat_jid else 0) + (1 if email_to else 0)
            if channels_configured and len(enqueue_errors) == channels_configured:
                log("enqueue START all channels failed; retry next tick")
                new_cursor = line_start
                break
            sent += 1
    try:
        SPAWN_CURSOR.write_text(str(new_cursor))
    except OSError as e:
        log(f"cursor write failed: {e}")
    return sent


def load_seen_results() -> set[str]:
    if not SEEN_RESULTS.exists():
        return set()
    try:
        data = json.loads(SEEN_RESULTS.read_text())
        return set(data) if isinstance(data, list) else set()
    except (OSError, json.JSONDecodeError):
        return set()


def save_seen_results(seen: set[str]) -> None:
    try:
        SEEN_RESULTS.write_text(json.dumps(sorted(seen)))
    except OSError as e:
        log(f"save seen-results failed: {e}")


def process_completions(chat_jid: str | None, email_to: str | None, titles: dict) -> int:
    """Scan executor-results/ for new .done.json / .completed.json files;
    enqueue DONE events to all configured channels with the report file
    attached (WhatsApp media_path + email attachments)."""
    if not RESULTS_DIR.exists():
        return 0
    seen = load_seen_results()
    sent = 0
    new_seen = set(seen)

    for path in sorted(RESULTS_DIR.iterdir()):
        name = path.name
        if name in seen:
            continue
        if not (name.endswith(".done.json") or name.endswith(".completed.json")):
            continue
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            log(f"skip unreadable {name}: {e}")
            new_seen.add(name)
            continue

        task_id = (
            payload.get("pocket_task_id")
            or payload.get("task_id")
            or _infer_task_id_from_filename(name)
        )
        if should_skip(task_id):
            new_seen.add(name)
            continue

        summary = (payload.get("summary") or payload.get("text") or "").strip()
        worker = payload.get("worker", "worker")
        title = titles.get(task_id, "")
        output_file = payload.get("output_file", "")
        attachment = _resolve_attachment(output_file)

        # Cap WhatsApp summary length
        wa_summary = summary[:797] + "..." if len(summary) > 800 else summary

        wa_parts = ["pocket-agent DONE", f"task: {task_id}"]
        if title:
            wa_parts.append(f"title: {title[:200]}")
        wa_parts.append(f"worker: {worker}")
        if wa_summary:
            wa_parts.append(f"summary: {wa_summary}")
        if attachment:
            wa_parts.append(f"report: attached ({os.path.basename(attachment)})")
        elif output_file:
            wa_parts.append(f"report: {output_file} (file missing on disk)")
        wa_msg = "\n".join(wa_parts)

        email_body_parts = [
            "A pocket agent has completed work on a task derived from a voice memo.",
            "",
            f"task id: {task_id}",
            f"title:   {title or '(no title)'}",
            f"worker:  {worker}",
            "",
            "Summary:",
            summary or "(no summary provided)",
            "",
        ]
        if attachment:
            email_body_parts.append(
                f"Report attached: {os.path.basename(attachment)}"
            )
        elif output_file:
            email_body_parts.append(
                f"Report file referenced but not found on disk: {output_file}"
            )
        email_body = "\n".join(email_body_parts)
        email_subject = f"DONE — {(title or task_id)[:80]}"

        enqueue_errors: list[str] = []
        if chat_jid:
            try:
                enqueue_whatsapp(chat_jid, wa_msg, media_path=attachment)
            except OSError as e:
                log(f"enqueue DONE whatsapp failed for {name}: {e}")
                enqueue_errors.append("whatsapp")
        if email_to:
            try:
                attachments = [attachment] if attachment else []
                enqueue_email(email_to, email_subject, email_body, attachments)
            except OSError as e:
                log(f"enqueue DONE email failed for {name}: {e}")
                enqueue_errors.append("email")
        channels_configured = (1 if chat_jid else 0) + (1 if email_to else 0)
        if channels_configured and len(enqueue_errors) == channels_configured:
            log(f"enqueue DONE all channels failed for {name}; retry next tick")
            break
        sent += 1
        new_seen.add(name)

    if new_seen != seen:
        save_seen_results(new_seen)
    return sent


def _infer_task_id_from_filename(name: str) -> str | None:
    # e.g. "inferred-7f5fc681-85c-0.done.json" → "inferred-7f5fc681-85c-0"
    for suffix in (".done.json", ".completed.json"):
        if name.endswith(suffix):
            stem = name[: -len(suffix)]
            # Strip executor-reaper prefix like "2026-05-20T125411_74__worker-..."
            if "__worker-" in stem:
                return None
            return stem
    return None


def main() -> int:
    write_health("running", "tick")

    chat_jid = load_chat_jid()
    email_to = load_email_target()

    if not chat_jid and not email_to:
        write_health("disabled", "no whatsapp or email channel configured")
        return 0

    titles = load_task_titles()
    starts = process_spawns(chat_jid, email_to, titles)
    dones = process_completions(chat_jid, email_to, titles)

    channels = []
    if chat_jid: channels.append("whatsapp")
    if email_to: channels.append("email")
    write_health(
        "ok",
        f"starts={starts} dones={dones} channels={','.join(channels)}",
        {"starts_enqueued": starts, "dones_enqueued": dones, "channels": channels},
    )
    log(f"done starts={starts} dones={dones} channels={channels}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
