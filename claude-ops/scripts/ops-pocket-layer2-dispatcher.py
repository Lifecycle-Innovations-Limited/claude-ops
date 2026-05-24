#!/usr/bin/env python3
"""ops-pocket-layer2-dispatcher — Local queue consumer for Layer 2.

Reads new rows from $POCKET_QUEUE_PATH (JSONL written by the Render webhook
receiver, synced to this machine), dispatches a Claude subagent per task, then
stages a WhatsApp/email notification draft for Sam's approval.

Designed to run from cron (every 5 min) or on-demand.  Uses the same
once.sh-style lock pattern to prevent stacking.

Env vars:
  POCKET_QUEUE_PATH      Path to pocket_queue.jsonl (required)
  POCKET_DISPATCHER_CURSOR  Cursor file path (default: alongside queue file)
  POCKET_DISPATCHER_LOCK    Exclusive lock file (default: cursor path + ".lock")
  POCKET_NOTIFY_CHANNEL  "whatsapp" | "email" | "both" (default: whatsapp)
  POCKET_WA_JID          WhatsApp JID for self-chat notifications
  POCKET_EMAIL_TO        Email address for notifications
  ANTHROPIC_API_KEY      For subagent dispatch (auto from keychain if unset)
  POCKET_DRY_RUN=1       Log dispatch intent without actually spawning agents
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("pocket-dispatcher")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

QUEUE_PATH = Path(os.environ.get("POCKET_QUEUE_PATH", str(Path.home() / ".claude/state/pocket/pocket_queue.jsonl")))
CURSOR_PATH = Path(os.environ.get("POCKET_DISPATCHER_CURSOR", str(QUEUE_PATH.parent / "pocket_queue.cursor")))
LOCK_PATH = Path(os.environ.get("POCKET_DISPATCHER_LOCK", str(CURSOR_PATH) + ".lock"))
NOTIFY_CHANNEL = os.environ.get("POCKET_NOTIFY_CHANNEL", "whatsapp")
WA_JID = os.environ.get("POCKET_WA_JID", "")
EMAIL_TO = os.environ.get("POCKET_EMAIL_TO", "")
DRY_RUN = os.environ.get("POCKET_DRY_RUN", "0") == "1"

# ---------------------------------------------------------------------------
# Skill tags → subagent prompt templates
# ---------------------------------------------------------------------------

SKILL_PROMPTS: dict[str, str] = {
    "calendar": (
        "You are handling a calendar/scheduling task from a Pocket voice memo. "
        "Parse the action items, create or update calendar events as needed, "
        "then write a concise completion report to stdout."
    ),
    "code": (
        "You are handling a code/engineering task from a Pocket voice memo. "
        "Implement the requested change, run tests, open a PR if appropriate, "
        "then write a concise completion report to stdout."
    ),
    "research": (
        "You are handling a research task from a Pocket voice memo. "
        "Use Tavily + Context7 to gather the requested information, "
        "then write a concise summary report to stdout."
    ),
    "general": (
        "You are handling a general task from a Pocket voice memo. "
        "Complete the requested action and write a concise completion report to stdout."
    ),
}

# ---------------------------------------------------------------------------
# Cursor — byte-offset into JSONL so we never re-process
# ---------------------------------------------------------------------------

def _read_cursor() -> int:
    try:
        return int(CURSOR_PATH.read_text().strip())
    except (FileNotFoundError, ValueError):
        return 0


def _write_cursor(offset: int) -> None:
    CURSOR_PATH.write_text(str(offset))


# ---------------------------------------------------------------------------
# Subagent dispatch
# ---------------------------------------------------------------------------

def _dispatch_subagent(task: dict) -> str | None:
    """Spawn a background claude subagent. Returns task_id or None on error."""
    if DRY_RUN:
        log.info("[DRY_RUN] would dispatch skill=%s recording_id=%s", task["skill"], task["recording_id"])
        return task["recording_id"]

    skill = task.get("skill", "general")
    system_prompt = SKILL_PROMPTS.get(skill, SKILL_PROMPTS["general"])

    action_items_text = "\n".join(f"- {ai}" for ai in task.get("action_items", []))
    user_prompt = (
        f"<task>\n"
        f"Recording ID: {task['recording_id']}\n"
        f"Title: {task.get('title', 'Untitled')}\n"
        f"Summary: {task.get('summary', '')}\n"
        f"Action items:\n{action_items_text or '(none extracted)'}\n"
        f"Transcript snippet: {task.get('transcript_snippet', '')}\n"
        f"</task>\n\n"
        f"Complete the task above and report back."
    )

    # Write prompt to temp file, invoke claude --bg
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(user_prompt)
        prompt_file = f.name

    tag = f"pocket-{task['recording_id'][:12]}"
    cmd = [
        "claude", "--bg",
        "--system", system_prompt,
        "--print", prompt_file,
        "--output-format", "text",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log.error("claude --bg failed: %s", result.stderr[:500])
            return None
        log.info("dispatched subagent tag=%s recording_id=%s", tag, task["recording_id"])
        return task["recording_id"]
    except subprocess.TimeoutExpired:
        log.error("claude --bg timed out for recording_id=%s", task["recording_id"])
        return None
    except FileNotFoundError:
        log.error("claude binary not found — is Claude Code on PATH?")
        return None
    finally:
        Path(prompt_file).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Notification draft (respects outbound-comms guardrail — staged, not sent)
# ---------------------------------------------------------------------------

def _stage_notification(task: dict, dispatched: bool) -> None:
    """Write a staged notification draft to the out-queue; does NOT send."""
    status_word = "dispatched" if dispatched else "FAILED to dispatch"
    body = (
        f"[Pocket] {status_word}: {task.get('title', task['recording_id'])}\n"
        f"Skill: {task.get('skill', 'general')}\n"
        f"Event: {task.get('event', '')}\n"
        f"Recording: {task['recording_id']}"
    )

    staged_at = datetime.now(timezone.utc).isoformat()

    def _draft_row(kind: str, to_addr: str) -> dict:
        return {
            "kind": kind,
            "to": to_addr,
            "body": body,
            "recording_id": task["recording_id"],
            "staged_at": staged_at,
            "requires_approval": True,  # outbound-comms guardrail
        }

    if NOTIFY_CHANNEL == "email":
        rows = [_draft_row("email", EMAIL_TO)]
    elif NOTIFY_CHANNEL == "both":
        rows = [_draft_row("whatsapp", WA_JID), _draft_row("email", EMAIL_TO)]
    else:
        rows = [_draft_row("whatsapp", WA_JID)]

    draft_path = QUEUE_PATH.parent / "pocket_notify_drafts.jsonl"
    with draft_path.open("a") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    log.info(
        "staged %d notification draft(s) for recording_id=%s",
        len(rows),
        task["recording_id"],
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = LOCK_PATH.open("a+")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.info("lock held — another dispatcher is running, exiting")
        lock_file.close()
        return 0

    try:
        return _dispatch_main()
    finally:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


def _dispatch_main() -> int:
    if not QUEUE_PATH.exists():
        log.info("queue not found at %s — nothing to process", QUEUE_PATH)
        return 0

    cursor = _read_cursor()
    new_cursor = cursor
    processed = 0
    errors = 0

    try:
        size = QUEUE_PATH.stat().st_size
    except OSError as exc:
        log.error("stat queue failed: %s", exc)
        return 1

    if cursor > size:
        log.warning(
            "cursor %d > queue size %d (queue truncated or replaced); resetting cursor to 0",
            cursor,
            size,
        )
        cursor = 0
        new_cursor = 0

    if cursor >= size:
        log.info("cursor at EOF — nothing new (cursor=%d size=%d)", cursor, size)
        return 0

    with QUEUE_PATH.open("rb") as f:
        f.seek(cursor)
        while True:
            line_start = f.tell()
            raw = f.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break
            line_end = f.tell()
            line = raw.decode().strip()
            if not line:
                new_cursor = line_end
                continue
            try:
                task = json.loads(line)
            except json.JSONDecodeError as exc:
                log.warning("bad JSONL line @offset=%d: %s", line_start, exc)
                new_cursor = line_end
                continue

            log.info(
                "processing recording_id=%s event=%s skill=%s",
                task.get("recording_id", "?"),
                task.get("event", "?"),
                task.get("skill", "?"),
            )

            task_id = _dispatch_subagent(task)
            dispatched = task_id is not None
            if dispatched:
                processed += 1
            else:
                errors += 1

            _stage_notification(task, dispatched)
            if dispatched:
                new_cursor = line_end
            else:
                # Rewind so transient claude --bg failures retry on the next run (see ops-pocket-out-queue.py).
                new_cursor = line_start
                break

    if new_cursor != cursor:
        _write_cursor(new_cursor)

    log.info("done — processed=%d errors=%d new_cursor=%d", processed, errors, new_cursor)
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
