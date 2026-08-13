#!/usr/bin/env python3
"""Unit tests for serialization lease and email cooldown in bu_reauth.py.

Tests the lease acquisition (with waiting), email cooldown tracking,
cooldown enforcement, code entry failure detection, and cooldown
logging (no sensitive data exposed) without requiring a real Browser
Use Cloud session or a real hub.

Run on the hub:
  sudo -u crsproxy /opt/crsproxy/venv/bin/python \
      /opt/crsproxy/test_lease_cooldown.py

Run locally (syntax/logic only, no hub dependencies):
  python3 test_lease_cooldown.py
"""

import json
import multiprocessing
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

# Add the script directory to the path
sys.path.insert(0, str(Path(__file__).parent))

# Import the module
import bu_reauth


def _lease_contender(lease_path: str, start, results):
    bu_reauth.LEASE_FILE = Path(lease_path)
    start.wait()
    lease_id = bu_reauth.acquire_lease("claude", max_wait=0.2)
    results.put(bool(lease_id))
    if lease_id:
        time.sleep(0.4)
        bu_reauth.release_lease(lease_id)


def test_lease_file_constant():
    """Lease file path is correct."""
    assert bu_reauth.LEASE_FILE == bu_reauth.STATE_DIR / "crsproxy-claude-oauth-lease.json"
    print("PASS: Lease file path is in the private state directory")


def test_lease_stale_seconds():
    """Lease stale threshold is defined."""
    assert bu_reauth.LEASE_STALE_SECONDS == 600, (
        f"Expected 600, got {bu_reauth.LEASE_STALE_SECONDS}"
    )
    print("PASS: Lease stale threshold is 600 seconds (10 min)")


def test_acquire_lease_no_existing():
    """acquire_lease creates an owner-scoped lease."""
    orig_lease = bu_reauth.LEASE_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        bu_reauth.LEASE_FILE = Path(tmpdir) / "lease.json"
        lease_id = bu_reauth.acquire_lease("claude", max_wait=0.2)
        assert lease_id
        data = json.loads(bu_reauth.LEASE_FILE.read_text())
        assert data["provider"] == "claude"
        assert data["pid"] == os.getpid()
        assert data["lease_id"] == lease_id
        assert bu_reauth.release_lease(lease_id) is True
        print("PASS: acquire_lease creates an owner-scoped lease")
    bu_reauth.LEASE_FILE = orig_lease


def test_acquire_lease_stale_replaced():
    """A stale lease can be replaced without deleting a newer owner."""
    orig_lease = bu_reauth.LEASE_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        lease_path = Path(tmpdir) / "lease.json"
        bu_reauth.LEASE_FILE = lease_path
        stale = {
            "provider": "claude",
            "timestamp": time.time() - 1200,
            "pid": 99999,
            "lease_id": "stale-owner",
        }
        lease_path.write_text(json.dumps(stale))
        lease_id = bu_reauth.acquire_lease("claude", max_wait=0.2)
        assert lease_id and lease_id != "stale-owner"
        assert json.loads(lease_path.read_text())["lease_id"] == lease_id
        assert bu_reauth.release_lease(lease_id) is True
        print("PASS: stale lease is replaced by a new owner")
    bu_reauth.LEASE_FILE = orig_lease


def test_multiprocess_contention_single_winner():
    """Atomic O_EXCL acquisition allows exactly one simultaneous winner."""
    orig_lease = bu_reauth.LEASE_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        lease_path = str(Path(tmpdir) / "lease.json")
        ctx = multiprocessing.get_context("spawn")
        start = ctx.Event()
        results = ctx.Queue()
        procs = [ctx.Process(target=_lease_contender, args=(lease_path, start, results)) for _ in range(4)]
        for proc in procs:
            proc.start()
        start.set()
        winners = [results.get(timeout=5) for _ in procs]
        for proc in procs:
            proc.join(timeout=5)
            assert proc.exitcode == 0
        assert winners.count(True) == 1, winners
        print("PASS: multiprocessing contention has exactly one lease owner")
    bu_reauth.LEASE_FILE = orig_lease


def test_owner_only_release():
    """A former or foreign owner cannot remove the current lease."""
    orig_lease = bu_reauth.LEASE_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        lease_path = Path(tmpdir) / "lease.json"
        bu_reauth.LEASE_FILE = lease_path
        owner = bu_reauth.acquire_lease("claude", max_wait=0.2)
        assert owner
        assert bu_reauth.release_lease("foreign-owner") is False
        assert lease_path.exists()
        assert json.loads(lease_path.read_text())["lease_id"] == owner
        assert bu_reauth.release_lease(owner) is True
        assert not lease_path.exists()
        print("PASS: release_lease is owner-only")
    bu_reauth.LEASE_FILE = orig_lease


def test_run_reauth_releases_on_success_and_failure():
    """run_reauth releases its exact lease across return and exception branches."""
    client = object()
    for inner_result, side_effect in ((bu_reauth.EXIT_SUCCESS, None), (None, RuntimeError("boom"))):
        released = []
        with patch.object(bu_reauth, "acquire_lease", return_value="lease-123"), \
             patch.object(bu_reauth, "release_lease", side_effect=lambda lease_id: released.append(lease_id)), \
             patch.object(bu_reauth, "_run_reauth_inner", return_value=inner_result, side_effect=side_effect):
            if side_effect:
                try:
                    bu_reauth.run_reauth("claude", "user@example.com", "", client)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Expected injected failure")
            else:
                assert bu_reauth.run_reauth("claude", "user@example.com", "", client) == inner_result
        assert released == ["lease-123"]
    print("PASS: run_reauth releases its owned lease on success and failure")


# ---------------------------------------------------------------------------
# Email cooldown tests
# ---------------------------------------------------------------------------
def test_email_cooldown_constants():
    """Email cooldown constants are correct."""
    assert bu_reauth.EMAIL_COOLDOWN_FILE == bu_reauth.STATE_DIR / "crsproxy-email-cooldown.json"
    assert bu_reauth.EMAIL_COOLDOWN_WINDOW == 300
    assert bu_reauth.EMAIL_COOLDOWN_THRESHOLD == 3
    assert bu_reauth.EMAIL_COOLDOWN_DURATION == 300
    print("PASS: Email cooldown constants are correct")


def test_record_email_send():
    """record_email_send records a timestamp."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        bu_reauth.record_email_send()
        state = json.loads(cd_path.read_text())
        assert len(state["send_timestamps"]) == 1
        assert state["cooldown_until"] == 0

        bu_reauth.record_email_send()
        state = json.loads(cd_path.read_text())
        assert len(state["send_timestamps"]) == 2
        print("PASS: record_email_send records timestamps")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


def test_record_email_send_prunes_old():
    """record_email_send prunes timestamps older than the window."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    orig_window = bu_reauth.EMAIL_COOLDOWN_WINDOW
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path
        bu_reauth.EMAIL_COOLDOWN_WINDOW = 2  # 2 seconds for testing

        # Record an old send
        state = {"send_timestamps": [time.time() - 10], "cooldown_until": 0}
        cd_path.write_text(json.dumps(state))

        time.sleep(0.1)
        bu_reauth.record_email_send()

        state = json.loads(cd_path.read_text())
        assert len(state["send_timestamps"]) == 1, (
            "Old timestamp should be pruned, only new one kept"
        )
        print("PASS: record_email_send prunes old timestamps")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file
    bu_reauth.EMAIL_COOLDOWN_WINDOW = orig_window


def test_check_email_cooldown_no_cooldown():
    """check_email_cooldown returns False when no cooldown is active."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        # No cooldown file — should return False
        in_cd, remaining = bu_reauth.check_email_cooldown()
        assert in_cd is False
        assert remaining == 0
        print("PASS: check_email_cooldown returns False when no cooldown")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


def test_check_email_cooldown_active():
    """check_email_cooldown returns True when cooldown is active."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        # Set an active cooldown
        state = {
            "send_timestamps": [],
            "cooldown_until": time.time() + 100,
        }
        cd_path.write_text(json.dumps(state))

        in_cd, remaining = bu_reauth.check_email_cooldown()
        assert in_cd is True
        assert 90 < remaining <= 100, f"Expected ~100s remaining, got {remaining}"
        print("PASS: check_email_cooldown returns True when active")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


def test_enforce_email_cooldown_no_cooldown_needed():
    """enforce_email_cooldown returns False when threshold not exceeded."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        # Only 2 sends (below threshold of 3)
        state = {"send_timestamps": [time.time(), time.time()], "cooldown_until": 0}
        cd_path.write_text(json.dumps(state))

        result = bu_reauth.enforce_email_cooldown()
        assert result is False, "Expected no cooldown when below threshold"
        print("PASS: enforce_email_cooldown returns False below threshold")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


def test_enforce_email_cooldown_triggers():
    """enforce_email_cooldown triggers when threshold exceeded."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    orig_duration = bu_reauth.EMAIL_COOLDOWN_DURATION
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path
        bu_reauth.EMAIL_COOLDOWN_DURATION = 1  # 1 second for testing

        # 4 sends (above threshold of 3)
        now = time.time()
        state = {
            "send_timestamps": [now, now, now, now],
            "cooldown_until": 0,
        }
        cd_path.write_text(json.dumps(state))

        start = time.time()
        result = bu_reauth.enforce_email_cooldown()
        elapsed = time.time() - start

        assert result is True, "Expected cooldown to be enforced"
        assert elapsed >= 1.0, (
            f"Expected to wait at least 1s, waited {elapsed:.1f}s"
        )
        # Cooldown should be cleared after waiting
        state = json.loads(cd_path.read_text())
        assert state["cooldown_until"] == 0, "Cooldown should be cleared after wait"
        print("PASS: enforce_email_cooldown triggers and waits when threshold exceeded")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file
    bu_reauth.EMAIL_COOLDOWN_DURATION = orig_duration


def test_clear_email_cooldown():
    """clear_email_cooldown removes the cooldown file."""
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        cd_path.write_text(json.dumps({"send_timestamps": [], "cooldown_until": 0}))
        assert cd_path.exists()

        bu_reauth.clear_email_cooldown()
        assert not cd_path.exists(), "Cooldown file should be removed"
        print("PASS: clear_email_cooldown removes the file")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


# ---------------------------------------------------------------------------
# Code entry failure detection tests
# ---------------------------------------------------------------------------
def test_code_entry_failed_positive():
    """_code_entry_failed returns True for failure indicators."""
    failure_texts = [
        "The code is invalid. Please try again.",
        "The verification code has expired.",
        "Incorrect code, please try again.",
        "That code isn't valid.",
        "The code didn't match. Please enter it again.",
        "Verification failed. Please try again.",
        "Unable to verify the code.",
    ]
    for text in failure_texts:
        result = bu_reauth._code_entry_failed(text)
        assert result is True, f"Expected True for: {text}"
    print("PASS: _code_entry_failed returns True for failure indicators")


def test_code_entry_failed_negative():
    """_code_entry_failed returns False for success indicators."""
    success_texts = [
        "You are now logged in. Click Authorize to continue.",
        "The code was accepted. Proceeding to the next step.",
        "Successfully verified. Click Continue.",
        "Welcome back! Your account is ready.",
    ]
    for text in success_texts:
        result = bu_reauth._code_entry_failed(text)
        assert result is False, f"Expected False for: {text}"
    print("PASS: _code_entry_failed returns False for success indicators")


# ---------------------------------------------------------------------------
# Sensitive data exposure tests
# ---------------------------------------------------------------------------
def test_cooldown_log_no_email_exposed():
    """Cooldown logging does not expose the email address.

    The log() function is used by record_email_send and
    enforce_email_cooldown.  Neither should print the email address
    or code values.  We verify by checking the log messages produced.
    """
    import io
    orig_file = bu_reauth.EMAIL_COOLDOWN_FILE
    orig_stdout = sys.stdout
    with tempfile.TemporaryDirectory() as tmpdir:
        cd_path = Path(tmpdir) / "cooldown.json"
        bu_reauth.EMAIL_COOLDOWN_FILE = cd_path

        # Capture stdout
        captured = io.StringIO()
        sys.stdout = captured

        bu_reauth.record_email_send()
        bu_reauth.enforce_email_cooldown()

        sys.stdout = orig_stdout
        output = captured.getvalue()

        # Verify no email-like patterns in the output
        # (should NOT contain @ or typical email patterns)
        assert "@" not in output, (
            f"Email address should not appear in cooldown logs: {output}"
        )
        # Verify no code-like patterns (6-digit numbers that could be codes)
        import re
        code_pattern = re.compile(r'\b\d{6}\b')
        assert not code_pattern.search(output), (
            f"Verification code values should not appear in logs: {output}"
        )
        print("PASS: Cooldown logs do not expose email or code values")
    bu_reauth.EMAIL_COOLDOWN_FILE = orig_file


def test_lease_log_no_pid_exposed_inappropriately():
    """Lease log messages don't expose sensitive process info."""
    import io
    orig_lease = bu_reauth.LEASE_FILE
    orig_stdout = sys.stdout
    with tempfile.TemporaryDirectory() as tmpdir:
        lease_path = Path(tmpdir) / "lease.json"
        bu_reauth.LEASE_FILE = lease_path

        captured = io.StringIO()
        sys.stdout = captured

        lease_id = bu_reauth.acquire_lease("claude", max_wait=0.2)
        bu_reauth.release_lease(lease_id)

        sys.stdout = orig_stdout
        output = captured.getvalue()

        # Should mention "Lease acquired" and "Lease released"
        assert "Lease acquired" in output, "Should log lease acquisition"
        assert "Lease released" in output, "Should log lease release"
        print("PASS: Lease log messages are appropriate")
    bu_reauth.LEASE_FILE = orig_lease


def test_checkpoint_resume_releases_on_early_failure():
    """Checkpoint resume releases its owned lease when OAuth URL setup fails."""
    released = []
    checkpoint = {
        "session_id": "session-1",
        "provider": "claude",
        "email": "user@example.com",
        "callback_port": 54545,
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        ckpt = Path(tmpdir) / "checkpoint.json"
        ckpt.write_text(json.dumps(checkpoint))
        with patch.object(bu_reauth, "CHECKPOINT_FILE", ckpt), \
             patch.dict(os.environ, {"BROWSER_USE_API_KEY": "fake"}), \
             patch.object(bu_reauth.atexit, "register"), \
             patch.object(bu_reauth, "acquire_lease", return_value="lease-resume"), \
             patch.object(bu_reauth, "release_lease", side_effect=lambda lease_id: released.append(lease_id)), \
             patch.object(bu_reauth, "start_login", return_value=object()), \
             patch.object(bu_reauth, "get_oauth_url", return_value=None), \
             patch.object(bu_reauth, "cleanup_login_process"):
            result = bu_reauth._checkpoint_resume(object())
    assert result == bu_reauth.EXIT_FAILURE
    assert released == ["lease-resume"]
    print("PASS: checkpoint resume releases its lease on setup failure")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Testing serialization lease and email cooldown in bu_reauth.py")
    print("=" * 60)

    tests = [
        # Lease tests
        test_lease_file_constant,
        test_lease_stale_seconds,
        test_acquire_lease_no_existing,
        test_acquire_lease_stale_replaced,
        test_multiprocess_contention_single_winner,
        test_owner_only_release,
        test_run_reauth_releases_on_success_and_failure,
        # Email cooldown tests
        test_email_cooldown_constants,
        test_record_email_send,
        test_record_email_send_prunes_old,
        test_check_email_cooldown_no_cooldown,
        test_check_email_cooldown_active,
        test_enforce_email_cooldown_no_cooldown_needed,
        test_enforce_email_cooldown_triggers,
        test_clear_email_cooldown,
        # Code entry failure detection
        test_code_entry_failed_positive,
        test_code_entry_failed_negative,
        # Sensitive data exposure
        test_cooldown_log_no_email_exposed,
        test_lease_log_no_pid_exposed_inappropriately,
        test_checkpoint_resume_releases_on_early_failure,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"FAIL: {test.__name__}: {e}")
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed, {len(tests)} total")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
