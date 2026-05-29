from __future__ import annotations
#!/usr/bin/env python3
"""ops-pocket-decisions — append-only decision log for the Pocket pipeline.

Every classification decision (triage ACT/DRAFT/DROP/ASK, and every
ingest-time event-seen-but-no-triage) lands here so Sam can audit what
Pocket reviewed even when it decided not to act.

Path: <POCKET_STATE_DIR>/decisions/YYYY-MM-DD.jsonl
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", "/var/lib/pocket-pipeline"))
DECISIONS_DIR = STATE_DIR / "decisions"


def write_decision(d: dict) -> None:
    DECISIONS_DIR.mkdir(parents=True, exist_ok=True)
    ts = d.get("ts") or datetime.now(timezone.utc).astimezone().isoformat()
    d["ts"] = ts
    date = ts[:10]
    with open(DECISIONS_DIR / f"{date}.jsonl", "a") as f:
        f.write(json.dumps(d) + "\n")


def make(event_type: str, recording_id: str = "", title: str = "",
         summary_excerpt: str = "", classification: str = "REVIEWED",
         confidence: float = 1.0, reasoning: str = "",
         action_taken: str | None = None, downstream_agent_id: str | None = None,
         notion_page_id: str | None = None, notion_page_url: str | None = None,
         is_long: bool = False, model: str = "", payload_bytes: int = 0) -> dict:
    return {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(),
        "recording_id": recording_id,
        "event_type": event_type,
        "title": title,
        "summary_excerpt": summary_excerpt[:280],
        "classification": classification,
        "confidence": confidence,
        "reasoning": reasoning,
        "action_taken": action_taken,
        "downstream_agent_id": downstream_agent_id,
        "notion_page_id": notion_page_id,
        "notion_page_url": notion_page_url,
        "is_long": is_long,
        "model": model,
        "payload_bytes": payload_bytes,
    }
