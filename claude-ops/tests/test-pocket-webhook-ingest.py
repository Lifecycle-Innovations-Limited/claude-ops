#!/usr/bin/env python3
"""Test ops-pocket-webhook-ingest: a summary.completed payload yields correctly
shaped pending-triage rows; a memory-only event yields none.

Hermetic: sets POCKET_STATE_DIR to a temp dir and POCKET_WEBHOOK_INFER=0 so no
Anthropic/network call happens (relies on HeyPocket's pre-extracted action
items only). Run: python3 tests/test-pocket-webhook-ingest.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
INGEST = SCRIPTS / "ops-pocket-webhook-ingest.py"

REQUIRED_FIELDS = {
    "id", "kind", "title", "context", "priority",
    "due", "recording_id", "source", "confidence", "captured_at",
}

SUMMARY_COMPLETED = {
    "ts": "2026-05-25T10:00:00Z",
    "event": "summary.completed",
    "payload": {
        "event": "summary.completed",
        "recording": {"id": "rec_test_001", "title": "Standup", "duration": 120,
                       "createdAt": "2026-05-25T09:58:00Z"},
        "summarizations": {
            "sum_1": {"v2": {
                "summary": {"title": "Standup", "markdown": "## Notes\nShip v2.",
                            "bulletPoints": ["Ship v2 by Friday"]},
                "actionItems": {"actionItems": [
                    {"title": "Ship v2 by Friday", "dueDate": "2026-05-29",
                     "status": "TODO", "isCompleted": False},
                    {"title": "Archive old logs", "status": "DONE", "isCompleted": True},
                ]},
            }},
        },
        "transcript": [{"speaker": "A", "text": "Let's ship.", "start": 0, "end": 2}],
    },
}

MEMORY_ONLY = {
    "ts": "2026-05-25T10:01:00Z",
    "event": "transcription.completed",
    "payload": {"event": "transcription.completed",
                "recording": {"id": "rec_test_002", "title": "x"}},
}


def run(envelope: dict, state_dir: Path) -> Path:
    env = dict(os.environ)
    env["POCKET_STATE_DIR"] = str(state_dir)
    env["POCKET_WEBHOOK_INFER"] = "0"  # no LLM/network
    env["GIGA_SYNC"] = "0"
    proc = subprocess.run(
        [sys.executable, str(INGEST)],
        input=json.dumps(envelope), capture_output=True, text=True, env=env, timeout=60,
    )
    assert proc.returncode == 0, f"ingest exited {proc.returncode}: {proc.stderr}"
    return state_dir / "pending-triage.jsonl"


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        sd = Path(td)

        # 1) summary.completed → exactly ONE row (the pending item; DONE skipped).
        pending = run(SUMMARY_COMPLETED, sd)
        assert pending.exists(), "pending-triage.jsonl was not created"
        rows = [json.loads(l) for l in pending.read_text().splitlines() if l.strip()]
        assert len(rows) == 1, f"expected 1 pending row, got {len(rows)}: {rows}"
        r = rows[0]
        assert REQUIRED_FIELDS.issubset(r.keys()), f"missing fields: {REQUIRED_FIELDS - set(r.keys())}"
        assert r["recording_id"] == "rec_test_001"
        assert r["id"] == "pocket-action-rec_test_001-0-ship_v2_by_friday"
        assert r["title"] == "Ship v2 by Friday"
        assert r["source"] == "pocket-webhook"
        assert r["due"] == "2026-05-29"
        assert r["confidence"] == 1.0
        print("PASS: summary.completed → 1 correctly-shaped pending row (DONE item skipped)")

        # 2) idempotency — same delivery again adds no new rows.
        run(SUMMARY_COMPLETED, sd)
        rows2 = [l for l in pending.read_text().splitlines() if l.strip()]
        assert len(rows2) == 1, f"idempotency broken: {len(rows2)} rows after replay"
        print("PASS: replayed delivery is idempotent (no duplicate row)")

        # 3) memory-only event → no rows.
        with tempfile.TemporaryDirectory() as td2:
            sd2 = Path(td2)
            pending2 = run(MEMORY_ONLY, sd2)
            n = len(pending2.read_text().splitlines()) if pending2.exists() else 0
            assert n == 0, f"memory-only event produced {n} rows (expected 0)"
            print("PASS: memory-only event (transcription.completed) → 0 triage rows")

        # 4) invalid JSON envelope → non-zero exit (caller can retry).
        with tempfile.TemporaryDirectory() as td3:
            bad_path = Path(td3) / "bad.json"
            bad_path.write_text("{not json")
            env_bad = dict(os.environ)
            env_bad["POCKET_STATE_DIR"] = str(Path(td3) / "state")
            env_bad["POCKET_WEBHOOK_INFER"] = "0"
            env_bad["GIGA_SYNC"] = "0"
            proc_bad = subprocess.run(
                [sys.executable, str(INGEST), str(bad_path)],
                capture_output=True, text=True, env=env_bad, timeout=60,
            )
            assert proc_bad.returncode == 1, f"expected exit 1 for bad JSON, got {proc_bad.returncode}"
        print("PASS: malformed JSON envelope exits 1")

    print("\nALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
