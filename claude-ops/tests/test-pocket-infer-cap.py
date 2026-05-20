#!/usr/bin/env python3
"""test-pocket-infer-cap.py — POCKET_MAX_INFER_PER_RUN guard test.

Asserts the money-leak guardrail in scripts/ops-cron-pocket-watcher.py works:
when 50 unseen recordings are fed in with POCKET_MAX_INFER_PER_RUN=10, the
watcher fires EXACTLY 10 Haiku inference calls and seen.json contains EXACTLY
10 new entries. The other 40 recordings stay unseen for the next run.

Also covers:
  - Cap of 0 disables capping (all 50 fire — used as the "without guard"
    counter-factual).
  - Cursor is NOT advanced when the cap is hit (otherwise next run would
    skip the deferred recordings and lose them forever).

stdlib only. Imports the watcher as a module after setting env vars.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"


def _load_watcher(state_dir: Path, memory_dir: Path, max_cap: str) -> object:
    """Reload the watcher module under controlled env."""
    os.environ["POCKET_STATE_DIR"] = str(state_dir)
    os.environ["POCKET_MEMORY_DIR"] = str(memory_dir)
    os.environ["POCKET_TASK_QUEUE"] = str(state_dir / "tasks.jsonl")
    os.environ["POCKET_DRAFT_QUEUE"] = str(state_dir / "drafts.jsonl")
    os.environ["POCKET_PENDING_TRIAGE"] = str(state_dir / "pending-triage.jsonl")
    os.environ["POCKET_MAX_INFER_PER_RUN"] = max_cap
    os.environ["POCKET_INFER_TASKS"] = "1"
    os.environ["POCKET_INFER_MIN_SECS"] = "60"
    os.environ["POCKET_INFER_CONFIDENCE"] = "0.0"
    os.environ["GIGA_SYNC"] = "0"
    os.environ["POCKET_API_KEY"] = "pk_test"
    os.environ["POCKET_LOOKBACK_HOURS"] = "24"
    # Force re-import so module-level env reads pick up new values.
    sys.path.insert(0, str(SCRIPTS))
    mod_name = "ops_cron_pocket_watcher"
    if mod_name in sys.modules:
        del sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(
        mod_name, SCRIPTS / "ops-cron-pocket-watcher.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_recordings(n: int) -> list[dict]:
    """N fake recordings, each substantive enough to trigger Haiku inference."""
    transcript = "Speaker: " + ("This is a long enough sentence for the inference gate. " * 30)
    return [
        {
            "id": f"rec-{i:04d}",
            "recordingDate": "2026-05-20T10:00:00Z",
            "durationSec": 120,
            "transcript": transcript,
            "summary": {"text": "test summary"},
        }
        for i in range(n)
    ]


class PocketInferCapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.tmp.name) / "state"
        self.memory_dir = Path(self.tmp.name) / "memory"
        self.state_dir.mkdir(parents=True)
        self.memory_dir.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()
        # Clean env so other tests aren't polluted.
        for k in list(os.environ):
            if k.startswith("POCKET_") or k in ("GIGA_SYNC",):
                del os.environ[k]

    def _run_watcher_with_cap(self, n_recordings: int, cap: str) -> tuple[int, int, str]:
        """Invoke watcher.main() with N mocked recordings + cap. Returns
        (haiku_call_count, seen_count, final_cursor)."""
        mod = _load_watcher(self.state_dir, self.memory_dir, cap)
        recordings = _make_recordings(n_recordings)

        haiku_calls = {"n": 0}

        def fake_infer(rec):
            haiku_calls["n"] += 1
            return []  # no inferred tasks; we only care about call count

        def fake_call_tool(self_, tool_name, args, timeout=30):
            if tool_name == "search_pocket_conversations_timerange":
                return ({"data": {"results": recordings, "meta": {}}}, None)
            if tool_name == "search_pocket_actionitems":
                return ({"data": {"results": []}}, None)
            return ({}, None)

        with mock.patch.object(mod.MCPClient, "initialize", return_value=True), \
                mock.patch.object(mod.MCPClient, "call_tool", new=fake_call_tool), \
                mock.patch.object(mod, "infer_tasks_from_recording", new=fake_infer), \
                mock.patch.object(mod, "write_memory", new=lambda rec, giga=None: None), \
                mock.patch.object(mod, "resolve_api_key", return_value="pk_test"):
            rc = mod.main()
        self.assertEqual(rc, 0, "watcher main() should exit 0")

        seen_path = self.state_dir / "seen.json"
        seen = json.loads(seen_path.read_text()) if seen_path.exists() else []
        cursor_path = self.state_dir / "cursor.txt"
        cursor = cursor_path.read_text().strip() if cursor_path.exists() else ""
        return haiku_calls["n"], len(seen), cursor

    def test_cap_respected_under_50_recordings(self):
        """50 unseen recordings × cap=10 → exactly 10 Haiku calls, 10 seen."""
        n_calls, n_seen, cursor = self._run_watcher_with_cap(50, "10")
        self.assertEqual(n_calls, 10, f"Haiku should fire exactly 10 times under cap=10, got {n_calls}")
        self.assertEqual(n_seen, 10, f"seen.json should have exactly 10 entries, got {n_seen}")

    def test_cap_zero_disables_cap(self):
        """cap=0 → all 50 fire (counter-factual: without guard, money leaks)."""
        n_calls, n_seen, _ = self._run_watcher_with_cap(50, "0")
        self.assertEqual(n_calls, 50, f"cap=0 should disable cap; expected 50 calls, got {n_calls}")
        self.assertEqual(n_seen, 50)

    def test_cap_hit_holds_cursor(self):
        """When cap is hit, cursor must NOT advance — else deferred recordings
        are lost forever (the money-leak the cap is meant to prevent)."""
        mod = _load_watcher(self.state_dir, self.memory_dir, "10")
        old_cursor = "2026-05-19T00:00:00Z"
        (self.state_dir / "cursor.txt").write_text(old_cursor)

        recordings = _make_recordings(50)

        def fake_call_tool(self_, tool_name, args, timeout=30):
            if tool_name == "search_pocket_conversations_timerange":
                return ({"data": {"results": recordings, "meta": {}}}, None)
            if tool_name == "search_pocket_actionitems":
                return ({"data": {"results": []}}, None)
            return ({}, None)

        with mock.patch.object(mod.MCPClient, "initialize", return_value=True), \
                mock.patch.object(mod.MCPClient, "call_tool", new=fake_call_tool), \
                mock.patch.object(mod, "infer_tasks_from_recording", new=lambda r: []), \
                mock.patch.object(mod, "write_memory", new=lambda rec, giga=None: None), \
                mock.patch.object(mod, "resolve_api_key", return_value="pk_test"):
            rc = mod.main()
        self.assertEqual(rc, 0)
        final_cursor = (self.state_dir / "cursor.txt").read_text().strip()
        self.assertEqual(
            final_cursor, old_cursor,
            f"cursor must stay at {old_cursor} when cap hit, got {final_cursor}",
        )

    def test_cap_not_hit_advances_cursor(self):
        """When cap is NOT hit (fewer recordings than cap), cursor advances normally."""
        mod = _load_watcher(self.state_dir, self.memory_dir, "10")
        old_cursor = "2026-05-19T00:00:00Z"
        (self.state_dir / "cursor.txt").write_text(old_cursor)
        recordings = _make_recordings(5)

        def fake_call_tool(self_, tool_name, args, timeout=30):
            if tool_name == "search_pocket_conversations_timerange":
                return ({"data": {"results": recordings, "meta": {}}}, None)
            if tool_name == "search_pocket_actionitems":
                return ({"data": {"results": []}}, None)
            return ({}, None)

        with mock.patch.object(mod.MCPClient, "initialize", return_value=True), \
                mock.patch.object(mod.MCPClient, "call_tool", new=fake_call_tool), \
                mock.patch.object(mod, "infer_tasks_from_recording", new=lambda r: []), \
                mock.patch.object(mod, "write_memory", new=lambda rec, giga=None: None), \
                mock.patch.object(mod, "resolve_api_key", return_value="pk_test"):
            mod.main()
        final_cursor = (self.state_dir / "cursor.txt").read_text().strip()
        self.assertNotEqual(final_cursor, old_cursor, "cursor should advance when cap not hit")


if __name__ == "__main__":
    unittest.main(verbosity=2)
