#!/usr/bin/env python3
"""
ops-pocket Layer 2 — Webhook receiver (FastAPI)

Receives HeyPocket webhook events, deduplicates, and enqueues subagent tasks.

Events handled:
  - summary.completed
  - action_items.regenerated
  - recording.created

Env vars (required):
  POCKET_HMAC_SECRET     HMAC-SHA256 signing secret from HeyPocket dashboard
  POCKET_WEBHOOK_URL     Public URL of this service (for self-reference in logs)

Env vars (optional):
  POCKET_DB_PATH         SQLite path (default: /data/pocket_events.db)
  POCKET_QUEUE_PATH      JSONL task queue path (default: /data/pocket_queue.jsonl)
  POCKET_REPLAY_WINDOW   Replay attack window in seconds (default: 300)
  LOG_LEVEL              default: INFO
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HMAC_SECRET: str = os.environ["POCKET_HMAC_SECRET"]
DB_PATH: Path = Path(os.environ.get("POCKET_DB_PATH", "/data/pocket_events.db"))
QUEUE_PATH: Path = Path(os.environ.get("POCKET_QUEUE_PATH", "/data/pocket_queue.jsonl"))
REPLAY_WINDOW: int = int(os.environ.get("POCKET_REPLAY_WINDOW", "300"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("pocket-webhook")

# ---------------------------------------------------------------------------
# Database — deduplication store
# ---------------------------------------------------------------------------

def _init_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id          TEXT NOT NULL,
            event_type  TEXT NOT NULL,
            received_at TEXT NOT NULL,
            payload     TEXT NOT NULL,
            PRIMARY KEY (id, event_type)
        )
    """)
    conn.commit()


def _get_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    _init_db(conn)
    return conn


# ---------------------------------------------------------------------------
# HMAC verification
# ---------------------------------------------------------------------------

def _verify_signature(body: bytes, signature_header: str | None, ts_header: str | None) -> None:
    """Raises HTTPException 401 if signature invalid or timestamp outside replay window."""
    if not signature_header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")

    # Timestamp guard
    if ts_header:
        try:
            ts = int(ts_header)
            age = abs(time.time() - ts)
            if age > REPLAY_WINDOW:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=f"Timestamp outside replay window ({int(age)}s > {REPLAY_WINDOW}s)",
                )
        except ValueError:
            pass  # Non-integer timestamp — skip age check, HMAC still validates

    expected = hmac.new(
        HMAC_SECRET.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()

    sig = signature_header.removeprefix("sha256=")
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")


# ---------------------------------------------------------------------------
# Routing — decide which subagent skill to tag the task with
# ---------------------------------------------------------------------------

_CALENDAR_KEYWORDS = frozenset([
    "calendar", "meeting", "schedule", "appointment", "standup", "call",
    "zoom", "teams", "remind", "reminder", "due date", "deadline",
])
_CODE_KEYWORDS = frozenset([
    "code", "bug", "fix", "pr", "pull request", "deploy", "build",
    "test", "script", "function", "api", "endpoint", "database", "db",
])
_RESEARCH_KEYWORDS = frozenset([
    "research", "look up", "find out", "investigate", "check", "analyse",
    "analyze", "compare", "summarize", "summarise", "report",
])


def _route_skill(text: str) -> str:
    """Return the skill tag to dispatch based on memory content."""
    lower = text.lower()
    tokens = set(lower.split())

    if tokens & _CALENDAR_KEYWORDS:
        return "calendar"
    if tokens & _CODE_KEYWORDS:
        return "code"
    if tokens & _RESEARCH_KEYWORDS:
        return "research"
    return "general"


# ---------------------------------------------------------------------------
# Queue writer
# ---------------------------------------------------------------------------

def _enqueue(task: dict[str, Any]) -> None:
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with QUEUE_PATH.open("a") as f:
        f.write(json.dumps(task) + "\n")
    log.info("enqueued task recording_id=%s skill=%s", task["recording_id"], task["skill"])


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("pocket-webhook Layer 2 starting up — DB=%s QUEUE=%s", DB_PATH, QUEUE_PATH)
    yield
    log.info("pocket-webhook shutting down")


app = FastAPI(title="pocket-webhook-layer2", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "ts": datetime.now(timezone.utc).isoformat()})


@app.post("/webhook")
async def webhook(
    request: Request,
    x_heypocket_signature: str | None = Header(default=None),
    x_heypocket_timestamp: str | None = Header(default=None),
) -> JSONResponse:
    body = await request.body()

    # 1. Verify HMAC
    _verify_signature(body, x_heypocket_signature, x_heypocket_timestamp)

    # 2. Parse payload
    try:
        payload: dict[str, Any] = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid JSON: {exc}")

    event_type: str = payload.get("event", "")
    recording: dict[str, Any] = payload.get("recording", {})
    recording_id: str = str(recording.get("id", ""))

    if not recording_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing recording.id")

    handled_events = {"summary.completed", "action_items.regenerated", "recording.created"}
    if event_type not in handled_events:
        log.info("ignoring event_type=%s recording_id=%s", event_type, recording_id)
        return JSONResponse({"status": "ignored", "event": event_type})

    transcript: str = recording.get("transcript", "") or ""
    summary: str = recording.get("summary", "") or ""
    action_items: list[str] = [
        ai.get("text", "") for ai in payload.get("actionItems", []) if ai.get("text")
    ]
    text_for_routing = " ".join([transcript, summary] + action_items)
    skill = _route_skill(text_for_routing)

    task = {
        "recording_id": recording_id,
        "event": event_type,
        "skill": skill,
        "title": recording.get("title", ""),
        "summary": summary,
        "action_items": action_items,
        "transcript_snippet": transcript[:500] if transcript else "",
        "received_at": datetime.now(timezone.utc).isoformat(),
    }

    conn = _get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute(
                "INSERT OR IGNORE INTO events (id, event_type, received_at, payload) VALUES (?,?,?,?)",
                (
                    recording_id,
                    event_type,
                    datetime.now(timezone.utc).isoformat(),
                    json.dumps(payload),
                ),
            )
            if cur.rowcount == 0:
                conn.rollback()
                log.info("duplicate recording_id=%s event=%s — skipping", recording_id, event_type)
                return JSONResponse({"status": "duplicate"})
            _enqueue(task)
        except Exception:
            conn.rollback()
            raise
        conn.commit()
    finally:
        conn.close()

    return JSONResponse({"status": "accepted", "skill": skill, "recording_id": recording_id})
