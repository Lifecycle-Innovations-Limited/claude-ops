#!/usr/bin/env python3
"""ops-pocket-webhook-ingest — real-time push entrypoint for the Pocket pipeline.

The cron watcher (`ops-cron-pocket-watcher.py`) polls the Pocket MCP every few
minutes and writes `pending-triage.jsonl` rows for the Opus triage gate. This
script does the same thing, but driven by a HeyPocket **webhook** delivery —
so a recording is triaged seconds after it finishes processing instead of on
the next poll. It is an *alternate trigger*, not a replacement: the watcher
stays as the catch-up/backstop path.

Input: a webhook envelope on stdin (or a file arg), shaped like the receiver's
journal rows:

    {"ts": "...", "event": "summary.completed", "payload": { <HeyPocket body> }}

The HeyPocket body (see their webhook docs) carries the recording, the
pre-extracted action items, and the transcript:

    payload.recording        = {id, title, duration, language, createdAt}
    payload.summarizations.*  = {v2: {summary:{markdown,bulletPoints,title},
                                       actionItems:{actionItems:[{title,dueDate,
                                                    status,isCompleted}]}}}
    payload.transcript        = [{speaker, text, start, end}]

Output: appends canonical rows to `pending-triage.jsonl` — exactly the schema
`ops-pocket-triage.py` consumes — one row per *pending* (not-completed) action
item HeyPocket pre-extracted, plus (optionally) implicit tasks inferred from the
transcript via the watcher's existing Haiku gate. The Opus triage gate still
classifies every row (ACT / DRAFT / DROP / ASK); nothing reaches the supervisor
without a verdict.

Idempotency: webhooks are at-least-once (HeyPocket retries 3×). Every emitted
row carries a deterministic id and is deduped against `seen.json`, so repeated
deliveries of the same recording never double-queue.

Cost: pre-extracted action items cost zero LLM calls. The optional implicit-task
pass reuses the watcher's Haiku gate (skips transcripts < 200 chars) and the
same POCKET_MAX_INFER_PER_RUN budget as a rolling per-UTC-hour cap (see
.webhook_infer_hourly.json), so webhook bursts cannot exceed that Haiku rate.

Env:
  POCKET_STATE_DIR            default ~/.claude/state/pocket (shared with watcher)
  POCKET_WEBHOOK_INFER        "1" (default) to also run the Haiku implicit-task
                              pass; "0" to rely only on HeyPocket's pre-extracted
                              action items (cheapest).
  POCKET_DRY_RUN=1            log what would be written, write nothing.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
LOG_PREFIX = "[ops-pocket-webhook-ingest]"

# Events that carry actionable content worth triaging. Everything else
# (transcription.completed, mind_map.completed, speakers.labeled,
# recording.deleted/merged, translation.completed) is memory-only — the watcher
# already persists those; the webhook path does not re-queue them for triage.
ACTIONABLE_EVENTS = {
    "summary.completed",
    "summary.regenerated",
    "action_items.regenerated",
    "action_items.updated",
    "recording.created",
}

INFER = os.environ.get("POCKET_WEBHOOK_INFER", "1") != "0"
DRY_RUN = os.environ.get("POCKET_DRY_RUN") == "1"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr)


@contextmanager
def _pocket_state_lock(w):
    """Serialize webhook ingest against itself and the watcher's seen/pending writes."""
    with w.pocket_state_lock():
        yield


def _infer_budget_read(w) -> tuple[str, int]:
    """Current UTC hour bucket and Haiku infer count for that bucket."""
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    path = w.STATE_DIR / ".webhook_infer_hourly.json"
    rec: dict = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text())
            if isinstance(raw, dict):
                rec = raw
        except json.JSONDecodeError:
            rec = {}
    if rec.get("hour") != hour:
        return hour, 0
    return hour, int(rec.get("n", 0))


def _infer_budget_room(w) -> bool:
    """True if another Haiku infer call is allowed this UTC hour.

    Caller must hold ``pocket_state_lock`` when this races with ingest commits.
    """
    if DRY_RUN or w.MAX_INFER_PER_RUN <= 0:
        return True
    _hour, n = _infer_budget_read(w)
    return n < w.MAX_INFER_PER_RUN


def _infer_budget_commit(w) -> None:
    """Record one successful Haiku infer call for the current UTC hour.

    Caller must hold ``pocket_state_lock`` — this mutates the hourly budget file
    alongside seen.json / pending-triage.jsonl in the same critical section.
    """
    if DRY_RUN or w.MAX_INFER_PER_RUN <= 0:
        return
    path = w.STATE_DIR / ".webhook_infer_hourly.json"
    hour, n = _infer_budget_read(w)
    path.write_text(json.dumps({"hour": hour, "n": n + 1}))


def _would_infer_haiku(w, recording: dict) -> bool:
    """Same preconditions as the watcher's would_infer (no network)."""
    duration = recording.get("durationSec") or recording.get("duration") or 0
    gate = w._transcript_for_infer_length_gate(recording)
    if not w.INFER_TASKS:
        return False
    if duration and duration < w.INFER_MIN_SECS:
        return False
    return len(gate) >= 200


def _load_watcher():
    """Import the sibling watcher module (hyphenated name → importlib by path)
    so we reuse its exact row sink, dedup set, id/slug helpers, and the Haiku
    implicit-task gate. The watcher has a `__main__` guard, so importing it runs
    only module-level constant assignments (no polling, no side effects)."""
    path = SCRIPT_DIR / "ops-cron-pocket-watcher.py"
    spec = importlib.util.spec_from_file_location("ops_cron_pocket_watcher", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load watcher module at {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_envelope() -> dict | None:
    raw = ""
    if len(sys.argv) > 1 and sys.argv[1] not in ("-", "--stdin"):
        raw = Path(sys.argv[1]).read_text()
    else:
        raw = sys.stdin.read()
    try:
        env = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        log(f"bad JSON envelope: {e}")
        return None
    # Accept either the {ts,event,payload} journal envelope or a bare body.
    if isinstance(env, dict) and "payload" in env and "event" in env:
        return {"event": env.get("event", "unknown"), "payload": env.get("payload") or {}}
    if isinstance(env, dict):
        return {"event": env.get("event", "unknown"), "payload": env}
    return {}


def _first_summarization(payload: dict) -> dict:
    sums = payload.get("summarizations") or {}
    if isinstance(sums, dict) and sums:
        return next(iter(sums.values())) or {}
    return {}


def _to_recording(payload: dict) -> dict:
    """Map a HeyPocket webhook body onto the recording dict the watcher's
    helpers (infer_tasks_from_recording, write_memory) already understand."""
    rec = payload.get("recording") or {}
    s = _first_summarization(payload)
    v2 = s.get("v2") or {}
    summary = v2.get("summary") or {}
    segs = [
        {"speaker": seg.get("speaker"), "text": seg.get("text", "")}
        for seg in (payload.get("transcript") or [])
        if seg.get("text")
    ]
    transcript_text = "\n".join(
        f"{seg['speaker'] or 'Speaker'}: {seg['text'].strip()}" for seg in segs
    )
    return {
        "id": rec.get("id") or rec.get("recordingId") or "",
        "title": rec.get("title") or summary.get("title") or "",
        "summary": {"text": summary.get("markdown") or ""},
        "transcript": transcript_text,
        "transcriptSegments": segs,
        "durationSec": rec.get("duration") or 0,
        "createdAt": rec.get("createdAt") or "",
        "_bullets": summary.get("bulletPoints") or [],
    }


def _pending_action_items(payload: dict) -> list[dict]:
    s = _first_summarization(payload)
    items = ((s.get("v2") or {}).get("actionItems") or {}).get("actionItems") or []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        if it.get("isCompleted") or it.get("is_completed") or it.get("status") == "DONE":
            continue
        title = (it.get("title") or "").strip()
        if not title:
            continue
        aid = it.get("id") or it.get("actionItemId")
        aid_s = str(aid).strip() if aid else ""
        out.append({
            "title": title,
            "due": it.get("dueDate"),
            "status": it.get("status"),
            "action_item_id": aid_s or None,
        })
    return out


def main() -> int:
    env = _read_envelope()
    if env is None:
        return 1
    event = env.get("event", "unknown")
    payload = env.get("payload") or {}

    if event not in ACTIONABLE_EVENTS:
        log(f"memory-only event '{event}' — no triage rows (watcher persists memory)")
        return 0

    w = _load_watcher()
    recording = _to_recording(payload)
    rid = recording["id"]
    if not rid:
        log("no recording id in payload — nothing to queue")
        return 0

    pending = w.PENDING_TRIAGE
    context_md = (recording["summary"].get("text") or "").strip()
    bullets = recording.get("_bullets") or []
    context_base = context_md or ("; ".join(bullets) if bullets else recording["title"])

    rows: list[tuple[dict, str | None]] = []
    wh_infer = f"wh-infer:{rid}"
    infer_claimed = False

    with _pocket_state_lock(w):
        seen = w.load_seen()

        emitted_action_ids: set[str] = set()

        # 1) HeyPocket pre-extracted action items — zero LLM cost.
        for idx, ai in enumerate(_pending_action_items(payload)):
            aid = ai.get("action_item_id")
            if aid:
                row_id = f"pocket-action-{aid}"
                watcher_key = f"action:{aid}"
            else:
                row_id = f"pocket-action-{rid[:16]}-{idx}-{w.slugify(ai['title'], 40)}"
                watcher_key = f"action-todo:{rid}:{w.slugify(ai['title'], 40)}"
            if watcher_key in seen:
                continue
            if row_id in seen or row_id in emitted_action_ids:
                continue
            emitted_action_ids.add(row_id)
            rows.append((
                {
                    "id": row_id,
                    "kind": "action_item",
                    "title": ai["title"],
                    "context": (context_base or "")[:500],
                    "priority": "medium",
                    "due": ai.get("due"),
                    "recording_id": rid,
                    "source": "pocket-webhook",
                    "confidence": 1.0,  # HeyPocket explicitly extracted it
                    "captured_at": w.now_iso(),
                },
                watcher_key,
            ))

        # 2) Optional implicit-task pass — claim wh-infer under lock before Haiku so
        # webhook and watcher cannot both pay for the same recording.
        if INFER and (not DRY_RUN) and _would_infer_haiku(w, recording):
            if wh_infer not in seen:
                if not _infer_budget_room(w):
                    log(
                        "implicit-task inference skipped (hourly Haiku cap: "
                        f"{w.MAX_INFER_PER_RUN}, POCKET_MAX_INFER_PER_RUN)"
                    )
                else:
                    w._seen_add(seen, wh_infer)
                    w.save_seen(seen)
                    infer_claimed = True

    inferred_list: list[dict] = []
    infer_api_ok = False
    if infer_claimed:
        try:
            inferred_list, infer_api_ok = w.infer_tasks_from_recording(recording)
        except Exception as e:  # noqa: BLE001 — inference must never block ingest
            log(f"implicit-task inference skipped ({type(e).__name__}: {e})")

    if infer_api_ok:
        for idx, t in enumerate(inferred_list):
            row_id = f"inferred-{rid[:12]}-{idx}"
            rows.append((
                {
                    "id": row_id,
                    "kind": "inferred",
                    "title": t["title"],
                    "context": t.get("context", ""),
                    "priority": t.get("priority", "low"),
                    "due": None,
                    "recording_id": rid,
                    "source": "pocket-webhook-inferred",
                    "confidence": t.get("confidence", 0.0),
                    "captured_at": w.now_iso(),
                },
                None,
            ))

    if not rows:
        log(f"event={event} rid={rid}: no new pending action items to queue")
        return 0

    if DRY_RUN:
        for r, _wk in rows:
            log(
                f"(dry-run) would queue [{r['kind']}] "
                f"{r['title'][:60]} (conf={r['confidence']})"
            )
        return 0

    with _pocket_state_lock(w):
        seen = w.load_seen()
        if infer_claimed and not infer_api_ok:
            seen.pop(wh_infer, None)
        to_write: list[tuple[dict, str | None]] = []
        for r, wk in rows:
            if r["id"] in seen:
                continue
            to_write.append((r, wk))

        if not to_write:
            log(f"event={event} rid={rid}: no new pending action items to queue")
            return 0

        pending.parent.mkdir(parents=True, exist_ok=True)
        with pending.open("a") as f:
            for r, _wk in to_write:
                f.write(json.dumps(r) + "\n")

        if infer_claimed and infer_api_ok:
            _infer_budget_commit(w)

        for r, wk in to_write:
            w._seen_add(seen, r["id"])
            if wk:
                w._seen_add(seen, wk)

        w.save_seen(seen)

    log(f"event={event} rid={rid}: queued {len(to_write)} row(s) for triage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
