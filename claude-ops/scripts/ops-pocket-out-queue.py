#!/usr/bin/env python3
"""ops-pocket-out-queue — Drain supervisor-out-queue.jsonl to WhatsApp.

Reads new entries from ~/.claude/state/pocket/supervisor-out-queue.jsonl,
posts each to the Baileys bridge HTTP API (POST localhost:8080/api/send),
tracks cursor to avoid replays. Self-chat alerts only — recipient is fixed
to whatsapp-config.json's chat_jid (Sam's self-chat). Per-message; no batch.

Cron: every 1 minute.

Safety:
  - Recipient JID is locked to the configured self-chat. We refuse any
    queue entry whose chat_jid differs from the configured value.
  - Each entry sent individually; failed sends remain at cursor for retry.
  - Idempotency: cursor advances only on 200 OK from bridge.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LOG_PREFIX = "[ops-pocket-out-queue]"
HOME = Path(os.path.expanduser("~"))
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
QUEUE = STATE_DIR / "supervisor-out-queue.jsonl"
CURSOR = STATE_DIR / ".out-queue-cursor"
CONFIG = STATE_DIR / "whatsapp-config.json"
LOG_FILE = STATE_DIR / "out-queue.log"
HEALTH = STATE_DIR / ".out-queue-health"
SENT = STATE_DIR / "out-queue-sent.jsonl"

BRIDGE_URL = os.environ.get("WHATSAPP_BRIDGE_URL", "http://localhost:8080/api/send")
TIMEOUT = int(os.environ.get("OUT_QUEUE_TIMEOUT", "15"))


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


def load_config() -> dict:
    if not CONFIG.exists():
        return {"enabled": False}
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        return {"enabled": False}


def post_send(recipient: str, message: str, media_path: str = "") -> tuple[bool, str]:
    payload = {"recipient": recipient, "message": message}
    if media_path:
        payload["media_path"] = media_path
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        BRIDGE_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            text = resp.read().decode(errors="replace")[:300]
            return (200 <= resp.status < 300, f"{resp.status}: {text}")
    except urllib.error.HTTPError as e:
        err = ""
        try:
            err = e.read().decode(errors="replace")[:200]
        except Exception:
            pass
        return (False, f"http_{e.code}: {err}")
    except Exception as e:
        return (False, f"{type(e).__name__}: {e}")


def main() -> int:
    write_health("running", "tick")

    cfg = load_config()
    if not cfg.get("enabled") or not cfg.get("chat_jid"):
        write_health("disabled", "no chat_jid configured")
        return 0
    expected_jid = cfg["chat_jid"]

    if not QUEUE.exists():
        write_health("ok", "no queue file", {"sent": 0, "skipped": 0})
        return 0

    # Cursor = byte offset into QUEUE
    cursor = 0
    if CURSOR.exists():
        try:
            cursor = int(CURSOR.read_text().strip() or "0")
        except (OSError, ValueError):
            cursor = 0

    try:
        size = QUEUE.stat().st_size
    except OSError as e:
        log(f"stat queue failed: {e}")
        write_health("error", f"stat: {e}")
        return 1

    if cursor > size:
        log(f"cursor {cursor} > size {size} (queue truncated); resetting to 0")
        cursor = 0

    if cursor >= size:
        write_health("ok", "no new entries", {"cursor": cursor, "size": size})
        return 0

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
                # Only process complete lines (must end with \n)
                if not raw.endswith(b"\n"):
                    # Partial write — stop at last-good cursor
                    break
                new_cursor = f.tell()
                try:
                    entry = json.loads(raw.decode())
                except json.JSONDecodeError as e:
                    log(f"skip malformed @offset={line_start}: {e}")
                    skipped += 1
                    continue
                if entry.get("kind") != "whatsapp":
                    skipped += 1
                    continue
                jid = entry.get("chat_jid", "")
                msg = (entry.get("message") or "").strip()
                if not msg:
                    skipped += 1
                    continue
                if jid != expected_jid:
                    log(f"REFUSED: jid {jid!r} != configured {expected_jid!r}")
                    skipped += 1
                    continue
                media_path = (entry.get("media_path") or "").strip()
                if media_path:
                    # Expand ~ and validate the file exists; if missing,
                    # send text-only rather than failing the whole entry.
                    expanded = os.path.expanduser(media_path)
                    if os.path.isfile(expanded):
                        media_path = expanded
                    else:
                        log(f"media_path missing, sending text-only: {media_path}")
                        media_path = ""
                ok, info = post_send(jid, msg, media_path)
                if ok:
                    sent += 1
                    try:
                        with SENT.open("a") as sf:
                            sf.write(json.dumps({
                                "ts": now_iso(),
                                "chat_jid": jid,
                                "message": msg[:500],
                                "source_ts": entry.get("ts"),
                                "bridge_response": info[:150],
                            }) + "\n")
                    except OSError:
                        pass
                    log(f"sent → {jid[:24]}... msg='{msg[:60]}...'")
                else:
                    failed += 1
                    log(f"FAILED → {jid[:24]}... err={info}")
                    # Rewind cursor so we retry next tick
                    new_cursor = line_start
                    break
                # Small pacing between sends (avoid bridge rate-limit)
                time.sleep(0.5)
    except OSError as e:
        log(f"read queue failed: {e}")
        write_health("error", f"read: {e}")
        return 2

    # Persist cursor
    try:
        CURSOR.write_text(str(new_cursor))
    except OSError as e:
        log(f"cursor write failed: {e}")

    write_health(
        "ok" if failed == 0 else "warn",
        f"sent={sent} failed={failed} skipped={skipped}",
        {"sent": sent, "failed": failed, "skipped": skipped,
         "cursor": new_cursor, "queue_size": size},
    )
    log(f"done sent={sent} failed={failed} skipped={skipped} cursor={new_cursor}/{size}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
