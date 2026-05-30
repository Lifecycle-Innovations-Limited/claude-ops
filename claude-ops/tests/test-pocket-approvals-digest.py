#!/usr/bin/env python3
"""test-pocket-approvals-digest.py — unit tests for the decision-digest and
choice-reply features added to ops-pocket-approvals.py.

Tests run without any external services (no email bridge, no gog).
Run with:  python3 tests/test-pocket-approvals-digest.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import types
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Locate scripts dir relative to this test file
# ---------------------------------------------------------------------------
TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"

pass_count = 0
fail_count = 0


def ok(label: str) -> None:
    global pass_count
    print(f"  PASS: {label}")
    pass_count += 1


def err(label: str, detail: str = "") -> None:
    global fail_count
    print(f"  FAIL: {label}" + (f" — {detail}" if detail else ""))
    fail_count += 1


# ---------------------------------------------------------------------------
# Load the module under test with STATE_DIR redirected to a tmp dir
# ---------------------------------------------------------------------------
def _load_approvals(tmp_dir: Path):
    """Import ops-pocket-approvals with POCKET_STATE_DIR pointing at tmp_dir."""
    os.environ["POCKET_STATE_DIR"] = str(tmp_dir)
    spec = importlib.util.spec_from_file_location(
        "approvals", SCRIPTS_DIR / "ops-pocket-approvals.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Synthetic ASK records
# ---------------------------------------------------------------------------

CHOICE_ASK = {
    "id": "ask-choice-001",
    "kind": "action_item",
    "title": "Choose deployment target for the upcoming release",
    "context": (
        "The team discussed three possible deployment targets in the planning session. "
        "Each has different cost and risk profiles. A decision is needed before the "
        "CI pipeline can be configured. The release is scheduled for next Monday."
    ),
    "action_preview": "Configures the CI pipeline to deploy to the chosen environment.",
    "decision_question": "Which environment should the release deploy to?",
    "options": [
        {"key": "a", "label": "Staging only — run integration tests, no prod traffic"},
        {"key": "b", "label": "Canary — 5% prod traffic alongside staging"},
        {"key": "c", "label": "Full production — immediate 100% rollout"},
    ],
    "triage": {
        "verdict": "ASK",
        "confidence": 0.9,
        "reasoning": "Multi-choice deployment decision requiring owner input.",
        "scoped": "",
        "concerns": [],
        "model": "claude-sonnet-4-6",
        "decided_at": "2026-05-30T00:00:00Z",
    },
}

YESNO_ASK = {
    "id": "ask-yesno-002",
    "kind": "action_item",
    "title": "Book assessment call with vendor",
    "context": (
        "Vendor reached out offering a 30-minute product assessment. Scheduling "
        "requires sending a calendar invite via the owner's Google Calendar."
    ),
    "action_preview": (
        "Books a 30-min assessment call with the vendor and sends the calendar invite."
    ),
    "triage": {
        "verdict": "ASK",
        "confidence": 0.85,
        "reasoning": "Outbound calendar action requires owner approval.",
        "scoped": "",
        "concerns": ["touches external calendar"],
        "model": "claude-sonnet-4-6",
        "decided_at": "2026-05-30T00:00:00Z",
    },
}


# ---------------------------------------------------------------------------
# Helper: write synthetic items to review.jsonl, build a codemap, return mod
# ---------------------------------------------------------------------------


def _setup_state(tmp: Path, items: list[dict]) -> tuple:
    """Write items to review.jsonl, return (mod, codemap_dict)."""
    review = tmp / "review.jsonl"
    with review.open("w") as f:
        for item in items:
            f.write(json.dumps(item) + "\n")

    mod = _load_approvals(tmp)

    # Build codemap the same way cmd_digest() would
    open_items = mod.open_items()
    codemap = {}
    a = 0
    for it in open_items:
        if it["bucket"] == "ASK":
            a += 1
            code = f"A{a}"
            codemap[code] = {
                "id": it["id"],
                "kind": it["kind"],
                "title": it["title"],
                "bucket": it["bucket"],
                "raw": it["raw"],
                "options": it["options"],
            }
    return mod, codemap, open_items


# ===========================================================================
# Test group 1: digest rendering
# ===========================================================================


def test_digest_rendering():
    import tempfile

    tmp = Path(tempfile.mkdtemp())

    mod, codemap, open_items = _setup_state(tmp, [CHOICE_ASK, YESNO_ASK])

    # Render item lines via _render_item
    a_item = next(it for it in open_items if it["id"] == "ask-choice-001")
    b_item = next(it for it in open_items if it["id"] == "ask-yesno-002")

    a_lines = mod._render_item("A1", a_item)
    b_lines = mod._render_item("A2", b_item)

    a_block = "\n".join(a_lines)
    b_block = "\n".join(b_lines)

    # --- Choice item assertions ---
    if "a) Staging only" in a_block:
        ok("choice item: option a listed")
    else:
        err("choice item: option a listed", f"block={a_block!r}")

    if "b) Canary" in a_block:
        ok("choice item: option b listed")
    else:
        err("choice item: option b listed", f"block={a_block!r}")

    if "c) Full production" in a_block:
        ok("choice item: option c listed")
    else:
        err("choice item: option c listed", f"block={a_block!r}")

    if "-> Approve =" in a_block and "Configures the CI pipeline" in a_block:
        ok("choice item: action_preview rendered")
    else:
        err("choice item: action_preview rendered", f"block={a_block!r}")

    if "A1 <letter>" in a_block or "Reply: A1" in a_block:
        ok("choice item: reply instruction shows <code> <letter>")
    else:
        err(
            "choice item: reply instruction shows <code> <letter>", f"block={a_block!r}"
        )

    if "Which environment" in a_block:
        ok("choice item: decision_question rendered")
    else:
        err("choice item: decision_question rendered", f"block={a_block!r}")

    # --- Yes/no item assertions ---
    if "-> Approve =" in b_block and "Books a 30-min" in b_block:
        ok("yes/no item: action_preview rendered")
    else:
        err("yes/no item: action_preview rendered", f"block={b_block!r}")

    if "APPROVE A2" in b_block and "REJECT A2" in b_block:
        ok("yes/no item: APPROVE/REJECT instruction present")
    else:
        err("yes/no item: APPROVE/REJECT instruction present", f"block={b_block!r}")

    # Choice block must NOT show plain APPROVE/REJECT as the primary instruction
    if "APPROVE A1" not in a_block or "Reply: A1" in a_block:
        ok("choice item: no plain APPROVE instruction (letter expected)")
    else:
        err(
            "choice item: no plain APPROVE instruction (letter expected)",
            f"block={a_block!r}",
        )

    # Context should appear
    if "deployment targets in the planning session" in a_block:
        ok("choice item: context shown in digest")
    else:
        err("choice item: context shown in digest", f"block={a_block!r}")


# ===========================================================================
# Test group 2: _truncate_words
# ===========================================================================


def test_truncate_words():
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    mod = _load_approvals(tmp)

    short = "Hello world"
    result = mod._truncate_words(short, 20)
    if result == short:
        ok("truncate_words: short string unchanged")
    else:
        err("truncate_words: short string unchanged", repr(result))

    long_text = "The quick brown fox jumped over the lazy dog and kept running."
    result = mod._truncate_words(long_text, 20)
    if result.endswith("...") and len(result) <= 23:  # room for "..."
        ok("truncate_words: long string truncated with ellipsis")
    else:
        err("truncate_words: long string truncated with ellipsis", repr(result))

    # Must not cut mid-word: the text before "..." must end with a complete word,
    # i.e. the last char before the ellipsis suffix is not in the middle of a word.
    # Strip the "..." suffix, then verify the remainder ends on a word boundary
    # (ends with an alphanumeric char that matches a word from the original).
    before_ellipsis = result[:-3] if result.endswith("...") else result
    last_word = before_ellipsis.split()[-1] if before_ellipsis.split() else ""
    if last_word and last_word in long_text.split():
        ok("truncate_words: cut on word boundary")
    else:
        err("truncate_words: cut on word boundary", repr(result))


# ===========================================================================
# Test group 3: reply parser — choice reply promotes with chosen_option
# ===========================================================================


def test_reply_parser_choice():
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    mod = _load_approvals(tmp)

    # Synthesize codemap with the choice item at A1
    codemap = {
        "A1": {
            "id": "ask-choice-001",
            "kind": "action_item",
            "title": "Choose deployment target",
            "bucket": "ASK",
            "raw": {
                "id": "ask-choice-001",
                "kind": "action_item",
                "title": "Choose deployment target",
            },
            "options": [
                {"key": "a", "label": "Staging only"},
                {"key": "b", "label": "Canary"},
                {"key": "c", "label": "Full production"},
            ],
        }
    }
    (tmp / "approval-codemap.json").write_text(json.dumps(codemap))
    (tmp / "email-config.json").write_text(
        json.dumps({"self_address": "owner@example.com"})
    )

    tasks_file = tmp / "tasks.jsonl"
    resolved_file = tmp / "approval-resolved.jsonl"

    # Mock gog to return one email with "A1 b"
    fake_msgs = [{"id": "msg-001", "from": "owner@example.com <owner@example.com>"}]
    fake_body = "A1 b"
    fake_subj = "Re: [Pocket] 2 item(s) need approval"

    with (
        patch.object(mod, "_gog_search_replies", return_value=fake_msgs),
        patch.object(mod, "_gog_body_and_subject", return_value=(fake_body, fake_subj)),
    ):
        mod.cmd_replies()

    # Verify task was written with chosen_option
    if tasks_file.exists():
        task_line = tasks_file.read_text().strip()
        if task_line:
            task = json.loads(task_line)
            if task.get("chosen_option") == "b":
                ok("choice reply: chosen_option='b' written to tasks.jsonl")
            else:
                err("choice reply: chosen_option='b'", f"task={task}")
            if task.get("chosen_option_label") == "Canary":
                ok("choice reply: chosen_option_label='Canary' written")
            else:
                err("choice reply: chosen_option_label", f"task={task}")
        else:
            err("choice reply: tasks.jsonl written but empty")
    else:
        err("choice reply: tasks.jsonl not created")

    # Verify resolved record
    if resolved_file.exists():
        rec = json.loads(resolved_file.read_text().strip())
        if rec.get("decision") == "CHOOSE" and rec.get("chosen") == "b":
            ok("choice reply: resolved record decision=CHOOSE chosen=b")
        else:
            err("choice reply: resolved record", f"rec={rec}")
    else:
        err("choice reply: approval-resolved.jsonl not created")


# ===========================================================================
# Test group 4: reply parser — invalid choice letter is rejected
# ===========================================================================


def test_reply_parser_invalid_letter():
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    mod = _load_approvals(tmp)

    codemap = {
        "A1": {
            "id": "ask-choice-001",
            "kind": "action_item",
            "title": "Choose something",
            "bucket": "ASK",
            "raw": {"id": "ask-choice-001"},
            "options": [
                {"key": "a", "label": "Option A"},
                {"key": "b", "label": "Option B"},
            ],
        }
    }
    (tmp / "approval-codemap.json").write_text(json.dumps(codemap))
    (tmp / "email-config.json").write_text(
        json.dumps({"self_address": "owner@example.com"})
    )

    fake_msgs = [{"id": "msg-002", "from": "owner@example.com"}]
    with (
        patch.object(mod, "_gog_search_replies", return_value=fake_msgs),
        patch.object(
            mod,
            "_gog_body_and_subject",
            return_value=("A1 z", "Re: [Pocket] 1 item(s) need approval"),
        ),
    ):
        mod.cmd_replies()

    tasks_file = tmp / "tasks.jsonl"
    if not tasks_file.exists() or not tasks_file.read_text().strip():
        ok("invalid letter: task NOT promoted (correctly rejected)")
    else:
        err("invalid letter: task should not be promoted", tasks_file.read_text())


# ===========================================================================
# Test group 5: reply parser — plain APPROVE on choice item is ambiguous
# ===========================================================================


def test_reply_parser_approve_on_choice_is_ambiguous():
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    mod = _load_approvals(tmp)

    codemap = {
        "A1": {
            "id": "ask-choice-001",
            "kind": "action_item",
            "title": "Choose something",
            "bucket": "ASK",
            "raw": {"id": "ask-choice-001"},
            "options": [
                {"key": "a", "label": "Option A"},
                {"key": "b", "label": "Option B"},
            ],
        }
    }
    (tmp / "approval-codemap.json").write_text(json.dumps(codemap))
    (tmp / "email-config.json").write_text(
        json.dumps({"self_address": "owner@example.com"})
    )

    fake_msgs = [{"id": "msg-003", "from": "owner@example.com"}]
    with (
        patch.object(mod, "_gog_search_replies", return_value=fake_msgs),
        patch.object(
            mod,
            "_gog_body_and_subject",
            return_value=("APPROVE A1", "Re: [Pocket] 1 item(s) need approval"),
        ),
    ):
        mod.cmd_replies()

    tasks_file = tmp / "tasks.jsonl"
    if not tasks_file.exists() or not tasks_file.read_text().strip():
        ok("bare APPROVE on choice item: left unresolved (ambiguous)")
    else:
        err(
            "bare APPROVE on choice item: should be ambiguous, not promoted",
            tasks_file.read_text(),
        )


# ===========================================================================
# Test group 6: reply parser — plain APPROVE on yes/no item still works
# ===========================================================================


def test_reply_parser_approve_yesno():
    import tempfile

    tmp = Path(tempfile.mkdtemp())
    mod = _load_approvals(tmp)

    codemap = {
        "A2": {
            "id": "ask-yesno-002",
            "kind": "action_item",
            "title": "Book vendor call",
            "bucket": "ASK",
            "raw": {
                "id": "ask-yesno-002",
                "kind": "action_item",
                "title": "Book vendor call",
            },
            "options": [],
        }
    }
    (tmp / "approval-codemap.json").write_text(json.dumps(codemap))
    (tmp / "email-config.json").write_text(
        json.dumps({"self_address": "owner@example.com"})
    )

    fake_msgs = [{"id": "msg-004", "from": "owner@example.com"}]
    with (
        patch.object(mod, "_gog_search_replies", return_value=fake_msgs),
        patch.object(
            mod,
            "_gog_body_and_subject",
            return_value=("APPROVE A2", "Re: [Pocket] 2 item(s) need approval"),
        ),
    ):
        mod.cmd_replies()

    tasks_file = tmp / "tasks.jsonl"
    if tasks_file.exists() and tasks_file.read_text().strip():
        task = json.loads(tasks_file.read_text().strip())
        if task.get("id") == "ask-yesno-002":
            ok("yes/no APPROVE: task promoted to tasks.jsonl")
        else:
            err("yes/no APPROVE: wrong id in task", str(task))
        if "chosen_option" not in task:
            ok("yes/no APPROVE: no chosen_option field (correct)")
        else:
            err("yes/no APPROVE: should not have chosen_option", str(task))
    else:
        err("yes/no APPROVE: tasks.jsonl not created or empty")


# ===========================================================================
# Run all tests
# ===========================================================================

if __name__ == "__main__":
    print("Testing ops-pocket-approvals digest + choice-reply features")
    print("")

    print("--- Digest rendering ---")
    test_digest_rendering()
    print("")

    print("--- _truncate_words ---")
    test_truncate_words()
    print("")

    print("--- Reply parser: choice reply ---")
    test_reply_parser_choice()
    print("")

    print("--- Reply parser: invalid letter rejected ---")
    test_reply_parser_invalid_letter()
    print("")

    print("--- Reply parser: bare APPROVE on choice item is ambiguous ---")
    test_reply_parser_approve_on_choice_is_ambiguous()
    print("")

    print("--- Reply parser: APPROVE on yes/no item still works ---")
    test_reply_parser_approve_yesno()
    print("")

    print("---")
    print(f"Results: {pass_count} passed, {fail_count} failed")
    sys.exit(0 if fail_count == 0 else 1)
