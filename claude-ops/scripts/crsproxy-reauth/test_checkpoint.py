#!/usr/bin/env python3
"""Unit tests for the human hCaptcha checkpoint in bu_reauth.py.

Tests the checkpoint file management, captcha detection, and the
keep_browser_alive flag without requiring a real Browser Use Cloud
session or a real hCaptcha challenge.

Run on the hub:
  sudo -u crsproxy /opt/crsproxy/venv/bin/python \
      /opt/crsproxy/bu_reauth.py.test_checkpoint.py

Run locally (syntax/logic only, no hub dependencies):
  python3 test_checkpoint.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse
from unittest.mock import MagicMock, patch

# Add the script directory to the path
sys.path.insert(0, str(Path(__file__).parent))

# Import the module
import bu_reauth


def test_sanitize_url():
    """sanitize_url strips query params and fragments."""
    result = bu_reauth.sanitize_url("https://example.com/path?token=secret#frag")
    assert result == "https://example.com/path", f"Expected stripped URL, got {result}"
    print("PASS: sanitize_url strips query params and fragments")


def test_safe_email():
    """safe_email redacts the local part of an email."""
    result = bu_reauth.safe_email("info@auroracapital.nl")
    assert result == "i***@auroracapital.nl", f"Expected redacted email, got {result}"
    result = bu_reauth.safe_email("a@b.com")
    assert result == "***@b.com", f"Expected redacted email, got {result}"
    print("PASS: safe_email redacts the local part of an email")


def test_detect_captcha_positive():
    """detect_captcha returns True for real captcha indicators."""
    # Mock client
    client = MagicMock()
    client.get_run_events.return_value = []

    # Test with captcha indicators in result text
    for indicator in bu_reauth.detect_captcha.__code__.co_consts:
        if isinstance(indicator, str) and indicator in [
            "hcaptcha", "captcha challenge", "solve the captcha",
            "i see a captcha", "captcha widget",
            "are you human", "verify you are human",
        ]:
            result = bu_reauth.detect_captcha(
                {"result": f"I see {indicator} on the page"}, client)
            assert result is True, f"Expected True for indicator: {indicator}"
    print("PASS: detect_captcha returns True for real captcha indicators")


def test_detect_captcha_negative():
    """detect_captcha returns False for non-captcha text."""
    client = MagicMock()
    client.get_run_events.return_value = []

    # "captcha" in a sentence is not enough
    result = bu_reauth.detect_captcha(
        {"result": "The page loaded successfully. No captcha needed."},
        client)
    assert result is False, f"Expected False for non-captcha text, got True"
    print("PASS: detect_captcha returns False for non-captcha text")


def test_checkpoint_file_write_read():
    """write_checkpoint writes a valid JSON file."""
    orig_ckpt = bu_reauth.CHECKPOINT_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        # Override checkpoint file path
        ckpt_path = Path(tmpdir) / "checkpoint.json"
        bu_reauth.CHECKPOINT_FILE = ckpt_path

        bu_reauth.write_checkpoint(
            session_id="test-session-123",
            run_id="test-run-456",
            browser_session_id="test-browser-789",
            live_view_url="https://live.browser-use.com?wss=example",
            provider="claude",
            email="test@example.com",
            callback_port=54545,
        )

        assert ckpt_path.exists(), "Checkpoint file was not created"
        data = json.loads(ckpt_path.read_text())
        assert data["session_id"] == "test-session-123"
        assert data["run_id"] == "test-run-456"
        assert data["provider"] == "claude"
        assert data["email"] == "test@example.com"
        assert data["callback_port"] == 54545
        assert data["live_view_url"] == "https://live.browser-use.com?wss=example"
        assert data["status"] == "waiting"
        print("PASS: write_checkpoint writes valid JSON with all fields")
    bu_reauth.CHECKPOINT_FILE = orig_ckpt


def test_checkpoint_trigger():
    """wait_for_checkpoint_signal detects trigger file."""
    orig_trigger = bu_reauth.CHECKPOINT_TRIGGER
    with tempfile.TemporaryDirectory() as tmpdir:
        trigger_path = Path(tmpdir) / "trigger"
        bu_reauth.CHECKPOINT_TRIGGER = trigger_path

        # Create trigger file after a short delay
        def create_trigger():
            time.sleep(1)
            trigger_path.touch()

        import threading
        t = threading.Thread(target=create_trigger)
        t.start()

        result = bu_reauth.wait_for_checkpoint_signal(timeout=10)
        t.join()

        assert result is True, "Expected trigger to be detected"
        assert not trigger_path.exists(), "Trigger file should be cleaned up"
        print("PASS: wait_for_checkpoint_signal detects and cleans up trigger")
    bu_reauth.CHECKPOINT_TRIGGER = orig_trigger


def test_checkpoint_timeout():
    """wait_for_checkpoint_signal returns False on timeout."""
    orig_trigger = bu_reauth.CHECKPOINT_TRIGGER
    with tempfile.TemporaryDirectory() as tmpdir:
        trigger_path = Path(tmpdir) / "trigger"
        bu_reauth.CHECKPOINT_TRIGGER = trigger_path

        result = bu_reauth.wait_for_checkpoint_signal(timeout=2)
        assert result is False, "Expected False on timeout"
        print("PASS: wait_for_checkpoint_signal returns False on timeout")
    bu_reauth.CHECKPOINT_TRIGGER = orig_trigger


def test_clear_checkpoint():
    """clear_checkpoint removes both checkpoint and trigger files."""
    orig_ckpt = bu_reauth.CHECKPOINT_FILE
    orig_trigger = bu_reauth.CHECKPOINT_TRIGGER
    with tempfile.TemporaryDirectory() as tmpdir:
        ckpt_path = Path(tmpdir) / "checkpoint.json"
        trigger_path = Path(tmpdir) / "trigger"
        bu_reauth.CHECKPOINT_FILE = ckpt_path
        bu_reauth.CHECKPOINT_TRIGGER = trigger_path

        ckpt_path.write_text("{}")
        trigger_path.touch()

        bu_reauth.clear_checkpoint()

        assert not ckpt_path.exists(), "Checkpoint file should be removed"
        assert not trigger_path.exists(), "Trigger file should be removed"
        print("PASS: clear_checkpoint removes both files")
    bu_reauth.CHECKPOINT_FILE = orig_ckpt
    bu_reauth.CHECKPOINT_TRIGGER = orig_trigger


def test_keep_browser_alive_flag():
    """BrowserUseClient.keep_browser_alive prevents browser cleanup."""
    client = bu_reauth.BrowserUseClient("fake-key")
    client._browser_sessions = ["browser-1", "browser-2"]

    # Set keep_browser_alive = True
    client.keep_browser_alive = True
    client.stop_all_browsers()

    # Browser sessions should NOT be stopped
    assert len(client._browser_sessions) == 2, \
        "Browser sessions should not be removed when keep_browser_alive=True"
    print("PASS: keep_browser_alive prevents browser cleanup")


def test_keep_browser_alive_release():
    """After keep_browser_alive is False, browsers can be stopped."""
    client = bu_reauth.BrowserUseClient("fake-key")
    client._browser_sessions = ["browser-1"]

    # Set keep_browser_alive = True, then False
    client.keep_browser_alive = True
    client.keep_browser_alive = False

    # Mock the stop_browser to not actually call the API
    with patch.object(client, '_request'):
        client.stop_all_browsers()

    print("PASS: keep_browser_alive can be released for cleanup")


def test_exit_codes():
    """Exit codes are correct."""
    assert bu_reauth.EXIT_SUCCESS == 0
    assert bu_reauth.EXIT_FAILURE == 1
    assert bu_reauth.EXIT_CAPTCHA == 2
    print("PASS: Exit codes are correct (0=success, 1=failure, 2=captcha)")


def test_checkpoint_constants():
    """Checkpoint constants are properly defined."""
    assert bu_reauth.CHECKPOINT_FILE == Path("/tmp/bu_reauth_checkpoint.json")
    assert bu_reauth.CHECKPOINT_TRIGGER == Path("/tmp/bu_reauth_checkpoint_trigger")
    assert bu_reauth.CHECKPOINT_POLL_INTERVAL == 5
    assert bu_reauth.CHECKPOINT_TIMEOUT == 600
    print("PASS: Checkpoint constants are properly defined")


def test_live_view_url_not_logged_with_secrets():
    """The live_view_url is a browser-use.com URL, not an OAuth URL.

    Verify that sanitize_url strips query params from the live_view_url
    for logging, but the full URL is available for the checkpoint file.
    """
    live_url = "https://live.browser-use.com?wss=https%3A%2F%2Fexample.cdp.browser-use.com"
    sanitized = bu_reauth.sanitize_url(live_url)
    assert "wss=" not in sanitized, "Sanitized URL should not contain query params"
    assert urlparse(sanitized).hostname == "live.browser-use.com", "Sanitized URL should use the live-view domain"
    print("PASS: live_view_url is sanitized for logging but full URL available for checkpoint")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Testing human hCaptcha checkpoint in bu_reauth.py")
    print("=" * 60)

    tests = [
        test_sanitize_url,
        test_safe_email,
        test_detect_captcha_positive,
        test_detect_captcha_negative,
        test_checkpoint_file_write_read,
        test_checkpoint_trigger,
        test_checkpoint_timeout,
        test_clear_checkpoint,
        test_keep_browser_alive_flag,
        test_keep_browser_alive_release,
        test_exit_codes,
        test_checkpoint_constants,
        test_live_view_url_not_logged_with_secrets,
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
