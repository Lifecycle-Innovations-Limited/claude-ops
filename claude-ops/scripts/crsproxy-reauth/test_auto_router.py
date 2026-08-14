#!/usr/bin/env python3
"""test_auto_router.py — Unit tests for crsproxy_auto_router.py.

Tests routing logic, account selection, retry, and email masking.
Uses unittest (stdlib) — no external dependencies required.

Run: python3 test_auto_router.py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

# Add parent directory to path so we can import the module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crsproxy_auto_router as router


class TestModelToProvider(unittest.TestCase):
    """Test model name to provider mapping."""

    def test_claude_prefix(self):
        self.assertEqual(router.model_to_provider("claude-sonnet-5"), "claude")
        self.assertEqual(router.model_to_provider("claude-opus-5"), "claude")
        self.assertEqual(router.model_to_provider("claude-3-haiku"), "claude")

    def test_grok_prefix(self):
        self.assertEqual(router.model_to_provider("grok-4.5"), "xai")
        self.assertEqual(router.model_to_provider("grok-2"), "xai")

    def test_gpt_prefix(self):
        self.assertEqual(router.model_to_provider("gpt-5.4"), "codex")
        self.assertEqual(router.model_to_provider("gpt-4o"), "codex")
        self.assertEqual(router.model_to_provider("gpt-4o-mini"), "codex")

    def test_kimi_prefix(self):
        self.assertEqual(router.model_to_provider("kimi-k3"), "kimi")
        self.assertEqual(router.model_to_provider("kimi-for-coding"), "kimi")

    def test_minimax_prefix(self):
        self.assertEqual(router.model_to_provider("minimax-m3"), "minimax")
        self.assertEqual(router.model_to_provider("MiniMax-M3"), "minimax")
        self.assertEqual(router.model_to_provider("MiniMax-M2.5"), "minimax")

    def test_gemini_prefix(self):
        self.assertEqual(router.model_to_provider("gemini-2.5-flash"), "gemini")
        self.assertEqual(
            router.model_to_provider("gemini-3.1-pro-preview"), "gemini"
        )

    def test_custom_prefix(self):
        self.assertEqual(router.model_to_provider("custom/claude-opus-5"), "claude")
        self.assertEqual(router.model_to_provider("custom/grok-4.5"), "xai")

    def test_suffix_brackets(self):
        self.assertEqual(router.model_to_provider("claude-sonnet-5[1m]"), "claude")
        self.assertEqual(router.model_to_provider("claude-opus-5[1m]"), "claude")

    def test_unknown_model(self):
        self.assertEqual(router.model_to_provider("unknown-model"), "unknown")
        self.assertEqual(router.model_to_provider(""), "unknown")
        self.assertEqual(router.model_to_provider(None), "unknown")

    def test_case_insensitive(self):
        self.assertEqual(router.model_to_provider("CLAUDE-SONNET-5"), "claude")
        self.assertEqual(router.model_to_provider("Grok-4.5"), "xai")


class TestMaskEmail(unittest.TestCase):
    """Test email masking for logs."""

    def test_normal_email(self):
        self.assertEqual(router.mask_email("adam@healify.ai"), "ad**@healify.ai")
        self.assertEqual(
            router.mask_email("info@auroracapital.nl"), "in**@auroracapital.nl"
        )

    def test_short_email(self):
        result = router.mask_email("ab@test.com")
        self.assertIn("@test.com", result)
        self.assertNotEqual(result, "ab@test.com")

    def test_single_char_local(self):
        result = router.mask_email("a@test.com")
        self.assertIn("@test.com", result)
        self.assertNotEqual(result, "a@test.com")

    def test_no_email(self):
        self.assertEqual(router.mask_email(""), "[no-email]")
        self.assertEqual(router.mask_email(None), "[no-email]")
        self.assertEqual(router.mask_email("notanemail"), "[no-email]")

    def test_no_token_leak(self):
        """Masked email must not contain the full local part."""
        email = "verylongname@domain.com"
        masked = router.mask_email(email)
        self.assertNotIn("verylongname", masked)
        self.assertIn("@domain.com", masked)

    def test_domain_preserved(self):
        """Domain should be visible for debugging."""
        masked = router.mask_email("user@example.com")
        self.assertIn("@example.com", masked)


class TestPressureTracker(unittest.TestCase):
    """Test least-pressure account selection."""

    def setUp(self):
        self.tracker = router.PressureTracker()
        self.accounts = [
            {"email": "a@example.com", "type": "claude", "path": "/tmp/a.json", "expired": ""},
            {"email": "b@example.com", "type": "claude", "path": "/tmp/b.json", "expired": ""},
            {"email": "c@example.com", "type": "claude", "path": "/tmp/c.json", "expired": ""},
        ]

    def test_initial_selection(self):
        """All accounts have equal pressure initially; any is valid."""
        selected = self.tracker.select_least_pressure(self.accounts)
        self.assertIsNotNone(selected)
        self.assertIn(selected["email"], ["a@example.com", "b@example.com", "c@example.com"])

    def test_least_pressure_after_requests(self):
        """Should prefer account with fewer requests."""
        self.tracker.record_request("a@example.com")
        self.tracker.record_request("a@example.com")
        self.tracker.record_request("b@example.com")
        selected = self.tracker.select_least_pressure(self.accounts)
        self.assertEqual(selected["email"], "c@example.com")

    def test_least_pressure_after_failures(self):
        """Failures weighted higher than requests."""
        self.tracker.record_request("b@example.com")
        self.tracker.record_failure("a@example.com")
        selected = self.tracker.select_least_pressure(self.accounts)
        # c has 0 failures, 0 requests -> least pressure
        self.assertEqual(selected["email"], "c@example.com")

    def test_exclude_tried(self):
        """Should exclude already-tried accounts."""
        tried = {"a@example.com", "b@example.com"}
        selected = self.tracker.select_least_pressure(self.accounts, exclude=tried)
        self.assertEqual(selected["email"], "c@example.com")

    def test_exclude_all(self):
        """Should return None when all accounts are excluded."""
        tried = {"a@example.com", "b@example.com", "c@example.com"}
        selected = self.tracker.select_least_pressure(self.accounts, exclude=tried)
        self.assertIsNone(selected)

    def test_failure_priority_over_requests(self):
        """An account with 0 failures but many requests beats one with 1 failure."""
        two_accounts = [
            {"email": "a@example.com", "type": "claude", "path": "/tmp/a.json", "expired": ""},
            {"email": "b@example.com", "type": "claude", "path": "/tmp/b.json", "expired": ""},
        ]
        self.tracker.record_request("a@example.com")
        self.tracker.record_request("a@example.com")
        self.tracker.record_failure("b@example.com")
        selected = self.tracker.select_least_pressure(two_accounts)
        self.assertEqual(selected["email"], "a@example.com")


class TestGetEligibleAccounts(unittest.TestCase):
    """Test reading auth files and filtering eligible accounts."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        now = datetime.now(timezone.utc)
        future = (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z")
        past = (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z")

        self._create_auth("active@example.com", "claude", False, future)
        self._create_auth("disabled@example.com", "claude", True, future)
        self._create_auth("expired@example.com", "claude", False, past)
        self._create_auth("xai@example.com", "xai", False, future)
        self._create_auth("codex@example.com", "codex", False, future)

        # Non-auth files (should be skipped)
        Path(self.tmpdir, "claude-skip.bak").write_text("{}")
        Path(self.tmpdir, "claude-skip.stale").write_text("{}")
        Path(self.tmpdir, "claude-skip.lock").write_text("{}")

    def _create_auth(self, email, auth_type, disabled, expired):
        data = {
            "email": email,
            "type": auth_type,
            "disabled": disabled,
            "expired": expired,
            "access_token": "secret-token",
            "refresh_token": "secret-refresh",
        }
        Path(self.tmpdir, f"{auth_type}-{email}.json").write_text(json.dumps(data))

    def test_filter_by_provider(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email"], "active@example.com")

    def test_exclude_disabled(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        emails = [a["email"] for a in accounts]
        self.assertNotIn("disabled@example.com", emails)

    def test_exclude_expired(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        emails = [a["email"] for a in accounts]
        self.assertNotIn("expired@example.com", emails)

    def test_xai_provider(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "xai")
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email"], "xai@example.com")

    def test_codex_provider(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "codex")
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email"], "codex@example.com")

    def test_nonexistent_provider(self):
        accounts = router.get_eligible_accounts(self.tmpdir, "kimi")
        self.assertEqual(len(accounts), 0)

    def test_skip_non_auth_files(self):
        """Should skip .bak, .stale, .lock files."""
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        self.assertEqual(len(accounts), 1)

    def test_no_secrets_in_account_data(self):
        """Returned account data must not include token fields."""
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        for a in accounts:
            self.assertNotIn("access_token", a)
            self.assertNotIn("refresh_token", a)
            self.assertNotIn("id_token", a)

    def test_nonexistent_dir(self):
        """Should return empty list for nonexistent directory."""
        accounts = router.get_eligible_accounts("/nonexistent/path", "claude")
        self.assertEqual(len(accounts), 0)

    def test_malformed_json_skipped(self):
        """Malformed JSON files should be skipped gracefully."""
        Path(self.tmpdir, "claude-bad@example.com.json").write_text("{invalid json")
        accounts = router.get_eligible_accounts(self.tmpdir, "claude")
        # Still only the one valid account
        self.assertEqual(len(accounts), 1)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)


class TestRouteRequest(unittest.TestCase):
    """Test the full routing logic with mocked upstream."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        now = datetime.now(timezone.utc)
        future = (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z")
        self._create_auth("a@example.com", "claude", False, future)
        self._create_auth("b@example.com", "claude", False, future)
        self._create_auth("c@example.com", "claude", False, future)
        self.tracker = router.PressureTracker()

    def _create_auth(self, email, auth_type, disabled, expired):
        data = {
            "email": email,
            "type": auth_type,
            "disabled": disabled,
            "expired": expired,
        }
        Path(self.tmpdir, f"{auth_type}-{email}.json").write_text(json.dumps(data))

    def _make_body(self, model):
        return json.dumps(
            {"model": model, "messages": [{"role": "user", "content": "hi"}]}
        ).encode()

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_success_first_try(self, mock_proxy):
        """Should succeed on first try without retry."""
        mock_proxy.return_value = (
            200,
            {"Content-Type": "application/json"},
            b'{"ok": true}',
        )
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 1)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_retry_on_401(self, mock_proxy):
        """Should retry on 401 with a different account."""
        mock_proxy.side_effect = [
            (401, {}, b'{"error": "unauthorized"}'),
            (200, {"Content-Type": "application/json"}, b'{"ok": true}'),
        ]
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 2)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_retry_on_429(self, mock_proxy):
        """Should retry on 429 with a different account."""
        mock_proxy.side_effect = [
            (429, {}, b'{"error": "rate limited"}'),
            (200, {"Content-Type": "application/json"}, b'{"ok": true}'),
        ]
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 2)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_retry_on_503(self, mock_proxy):
        """Should retry on 503 with a different account."""
        mock_proxy.side_effect = [
            (503, {}, b'{"error": "unavailable"}'),
            (200, {"Content-Type": "application/json"}, b'{"ok": true}'),
        ]
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 2)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_no_retry_on_200(self, mock_proxy):
        """Should not retry on 200."""
        mock_proxy.return_value = (
            200,
            {"Content-Type": "application/json"},
            b'{"ok": true}',
        )
        router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(mock_proxy.call_count, 1)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_no_retry_on_400(self, mock_proxy):
        """Should not retry on 400 (not in retry set)."""
        mock_proxy.return_value = (
            400,
            {"Content-Type": "application/json"},
            b'{"error": "bad request"}',
        )
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 400)
        self.assertEqual(mock_proxy.call_count, 1)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_max_retries_exhausted(self, mock_proxy):
        """Should exhaust retries and return last response."""
        mock_proxy.return_value = (
            503,
            {},
            b'{"error": "unavailable"}',
        )
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
            max_retries=3,
        )
        self.assertEqual(status, 503)
        # 3 accounts, max_retries=3, so max 4 attempts but only 3 accounts
        self.assertEqual(mock_proxy.call_count, 3)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_always_distinct_account(self, mock_proxy):
        """Each retry must use a different account (never repeat)."""
        mock_proxy.return_value = (
            401,
            {},
            b'{"error": "unauthorized"}',
        )
        router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
            max_retries=3,
        )
        # With 3 accounts and max_retries=3, should try all 3 distinct accounts
        self.assertEqual(mock_proxy.call_count, 3)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_api_key_provider_no_account_selection(self, mock_proxy):
        """API-key providers should proxy directly without account selection."""
        mock_proxy.return_value = (
            200,
            {"Content-Type": "application/json"},
            b'{"ok": true}',
        )
        status, _, _ = router.route_request(
            "kimi-k3",
            self._make_body("kimi-k3"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 1)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_unknown_model_proxies_directly(self, mock_proxy):
        """Unknown models should proxy directly."""
        mock_proxy.return_value = (
            200,
            {"Content-Type": "application/json"},
            b'{"ok": true}',
        )
        status, _, _ = router.route_request(
            "some-unknown-model",
            self._make_body("some-unknown-model"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 1)

    def test_no_eligible_accounts(self):
        """Should return 503 when no eligible accounts exist."""
        status, _, body = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            "/nonexistent/path",
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 503)
        self.assertIn(b"no eligible accounts", body)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_connection_error_retries(self, mock_proxy):
        """Should retry on connection error (URLError)."""
        import urllib.error

        mock_proxy.side_effect = [
            urllib.error.URLError("Connection refused"),
            (200, {"Content-Type": "application/json"}, b'{"ok": true}'),
        ]
        status, _, _ = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
        )
        self.assertEqual(status, 200)
        self.assertEqual(mock_proxy.call_count, 2)

    @patch("crsproxy_auto_router.proxy_to_upstream")
    def test_dry_run_no_proxy(self, mock_proxy):
        """Dry run should not call the upstream proxy."""
        status, _, body = router.route_request(
            "claude-sonnet-5",
            self._make_body("claude-sonnet-5"),
            {},
            self.tmpdir,
            "http://127.0.0.1:8319",
            self.tracker,
            dry_run=True,
        )
        self.assertEqual(status, 200)
        self.assertIn(b"dry_run", body)
        mock_proxy.assert_not_called()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)


class TestNoSecretsInLogs(unittest.TestCase):
    """Test that no secrets are exposed in log output or returned data."""

    def test_mask_email_hides_local_part(self):
        email = "sensitive@domain.com"
        masked = router.mask_email(email)
        self.assertNotIn("sensitive", masked)

    def test_account_data_no_tokens(self):
        """get_eligible_accounts must not include tokens in returned data."""
        tmpdir = tempfile.mkdtemp()
        try:
            now = datetime.now(timezone.utc)
            future = (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z")
            data = {
                "email": "test@example.com",
                "type": "claude",
                "disabled": False,
                "expired": future,
                "access_token": "secret-access-token",
                "refresh_token": "secret-refresh-token",
                "id_token": "secret-id-token",
            }
            Path(tmpdir, "claude-test@example.com.json").write_text(json.dumps(data))
            accounts = router.get_eligible_accounts(tmpdir, "claude")
            self.assertEqual(len(accounts), 1)
            for a in accounts:
                self.assertNotIn("access_token", a)
                self.assertNotIn("refresh_token", a)
                self.assertNotIn("id_token", a)
            # String representation must not contain tokens
            account_str = str(accounts)
            self.assertNotIn("secret-access-token", account_str)
            self.assertNotIn("secret-refresh-token", account_str)
        finally:
            shutil.rmtree(tmpdir)


if __name__ == "__main__":
    unittest.main()
