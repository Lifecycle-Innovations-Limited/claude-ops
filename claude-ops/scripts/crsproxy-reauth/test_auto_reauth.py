#!/usr/bin/env python3
"""test_auto_reauth.py — Unit tests for auto_reauth.py.

Tests the reconciliation bug fix: after reconcile_accounts() disables a
policy-disabled account, the generic scan_auth_files() call in the same
cycle must NOT pick up that account and queue it for reauth.

Run: python3 test_auto_reauth.py
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

import auto_reauth


class TestScanAuthFilesPolicyFilter(unittest.TestCase):
    """Test that scan_auth_files excludes policy-disabled accounts."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        now = datetime.now(timezone.utc)
        future = (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z")
        past = (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z")

        # Create auth files:
        # - disabled@example.com: disabled, fresh token (would be queued by scan)
        # - expired@example.com: enabled, expired token (would be queued by scan)
        # - healthy@example.com: enabled, fresh token (not queued)
        self._create_auth("disabled@example.com", "claude", True, future)
        self._create_auth("expired@example.com", "claude", False, past)
        self._create_auth("healthy@example.com", "claude", False, future)

    def _create_auth(self, email, auth_type, disabled, expired):
        data = {
            "email": email,
            "type": auth_type,
            "disabled": disabled,
            "expired": expired,
        }
        Path(self.tmpdir, f"{auth_type}-{email}.json").write_text(json.dumps(data))

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    @patch("auto_reauth.AUTH_DIR")
    def test_scan_without_policy_disabled(self, mock_auth_dir):
        """Without policy_disabled, all disabled/expired accounts are queued."""
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        needs = auto_reauth.scan_auth_files()
        emails = [a["email"] for a in needs]
        self.assertIn("disabled@example.com", emails)
        self.assertIn("expired@example.com", emails)
        self.assertNotIn("healthy@example.com", emails)

    @patch("auto_reauth.AUTH_DIR")
    def test_scan_excludes_policy_disabled(self, mock_auth_dir):
        """With policy_disabled, the policy-disabled account is excluded."""
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        # disabled@example.com is policy-disabled
        policy_disabled = {("claude", "disabled@example.com")}
        needs = auto_reauth.scan_auth_files(policy_disabled=policy_disabled)
        emails = [a["email"] for a in needs]

        # disabled@example.com should NOT be in the scan results
        self.assertNotIn("disabled@example.com", emails)
        # expired@example.com should still be in the results (not policy-disabled)
        self.assertIn("expired@example.com", emails)
        # healthy@example.com should not be in results (healthy)
        self.assertNotIn("healthy@example.com", emails)

    @patch("auto_reauth.AUTH_DIR")
    def test_scan_excludes_multiple_policy_disabled(self, mock_auth_dir):
        """Multiple policy-disabled accounts are all excluded."""
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        policy_disabled = {
            ("claude", "disabled@example.com"),
            ("claude", "expired@example.com"),
        }
        needs = auto_reauth.scan_auth_files(policy_disabled=policy_disabled)
        emails = [a["email"] for a in needs]

        self.assertNotIn("disabled@example.com", emails)
        self.assertNotIn("expired@example.com", emails)
        self.assertNotIn("healthy@example.com", emails)

    @patch("auto_reauth.AUTH_DIR")
    def test_scan_empty_policy_disabled(self, mock_auth_dir):
        """Empty policy_disabled set behaves like no filter (all queued)."""
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        needs = auto_reauth.scan_auth_files(policy_disabled=set())
        emails = [a["email"] for a in needs]
        self.assertIn("disabled@example.com", emails)
        self.assertIn("expired@example.com", emails)

    @patch("auto_reauth.AUTH_DIR")
    def test_scan_none_policy_disabled(self, mock_auth_dir):
        """None policy_disabled behaves like no filter (all queued)."""
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        needs = auto_reauth.scan_auth_files(policy_disabled=None)
        emails = [a["email"] for a in needs]
        self.assertIn("disabled@example.com", emails)
        self.assertIn("expired@example.com", emails)


class TestReconciliationBugScenario(unittest.TestCase):
    """End-to-end test for the reconciliation bug scenario.

    Verifies that after a policy-disabled account is disabled by
    reconcile_accounts(), the subsequent scan_auth_files() call with
    the policy_disabled filter does NOT re-queue it.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        now = datetime.now(timezone.utc)
        future = (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z")

        # Create an enabled account that policy says should be disabled
        self._create_auth("policyoff@example.com", "claude", False, future)

    def _create_auth(self, email, auth_type, disabled, expired):
        data = {
            "email": email,
            "type": auth_type,
            "disabled": disabled,
            "expired": expired,
        }
        Path(self.tmpdir, f"{auth_type}-{email}.json").write_text(json.dumps(data))

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    @patch("auto_reauth.AUTH_DIR")
    def test_policy_disabled_account_not_requeued(self, mock_auth_dir):
        """After policy disables an account, scan should not re-queue it.

        This simulates the full cycle:
        1. Policy says policyoff@example.com should be disabled
        2. reconcile_accounts() disables it (sets disabled=true)
        3. scan_auth_files() with policy_disabled filter should NOT
           include it in the reauth queue
        """
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        # Simulate step 2: reconcile_accounts disables the account
        auth_file = Path(self.tmpdir, "claude-policyoff@example.com.json")
        data = json.loads(auth_file.read_text())
        data["disabled"] = True
        auth_file.write_text(json.dumps(data))

        # Step 3: build policy_disabled set (as main() does)
        policy_disabled = {("claude", "policyoff@example.com")}

        # Scan with the filter
        needs = auto_reauth.scan_auth_files(policy_disabled=policy_disabled)
        emails = [a["email"] for a in needs]

        # The just-disabled account should NOT be re-queued
        self.assertNotIn(
            "policyoff@example.com", emails,
            "Policy-disabled account should NOT be re-queued for reauth"
        )

    @patch("auto_reauth.AUTH_DIR")
    def test_without_filter_account_would_be_requeued(self, mock_auth_dir):
        """Without the filter, the disabled account WOULD be re-queued.

        This demonstrates the bug: without the policy_disabled filter,
        the scan picks up the just-disabled account.
        """
        mock_auth_dir.glob = lambda pattern: sorted(Path(self.tmpdir).glob(pattern))

        # Simulate reconcile_accounts disabling the account
        auth_file = Path(self.tmpdir, "claude-policyoff@example.com.json")
        data = json.loads(auth_file.read_text())
        data["disabled"] = True
        auth_file.write_text(json.dumps(data))

        # Scan WITHOUT the filter (old behavior)
        needs = auto_reauth.scan_auth_files()
        emails = [a["email"] for a in needs]

        # The disabled account WOULD be re-queued (this is the bug)
        self.assertIn(
            "policyoff@example.com", emails,
            "Without filter, disabled account IS re-queued (demonstrates the bug)"
        )


if __name__ == "__main__":
    unittest.main()
