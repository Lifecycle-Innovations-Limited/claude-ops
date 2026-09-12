#!/usr/bin/env python3
"""Regression tests for account-specific reauth candidate validation."""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bu_reauth


class TestCandidateIdentity(unittest.TestCase):
    def _candidate(self, **overrides):
        data = {
            "email": "operator@example.com",
            "type": "claude",
            "expired": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "organization_uuid": "org-team",
            "organization_name": "Example Team",
        }
        data.update(overrides)
        handle = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(Path(handle.name).unlink, missing_ok=True)
        return Path(handle.name)

    def test_rejects_candidate_for_other_same_email_organization(self):
        valid, reason = bu_reauth.validate_candidate(
            self._candidate(),
            expected_email="operator@example.com",
            expected_type="claude",
            expected_organization_uuid="org-max",
            skip_canary=True,
        )

        self.assertFalse(valid)
        self.assertIn("organization UUID mismatch", reason)

    def test_accepts_matching_same_email_organization(self):
        valid, reason = bu_reauth.validate_candidate(
            self._candidate(),
            expected_email="operator@example.com",
            expected_type="claude",
            expected_organization_uuid="org-team",
            expected_organization_name="Example Team",
            skip_canary=True,
        )

        self.assertTrue(valid, reason)

    def test_account_specific_activation_preserves_canonical_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            canonical = auth_dir / "claude-operator@example.com.json"
            target = auth_dir / "claude-operator-max.json"
            canonical.write_text(json.dumps({"marker": "canonical"}))
            target.write_text(json.dumps({"marker": "old-target"}))
            meta = dict(bu_reauth.PROVIDERS["claude"])
            meta["canary_model"] = ""

            with patch.object(bu_reauth, "AUTH_DIR", auth_dir):
                candidate, stale = bu_reauth.prepare_auth_target(
                    meta, "claude", "operator@example.com", target.name,
                    "org-max")
                candidate.write_text(json.dumps({
                    "email": "operator@example.com",
                    "type": "claude",
                    "expired": (
                        datetime.now(timezone.utc) + timedelta(days=2)
                    ).isoformat(),
                    "organization_uuid": "org-max",
                }))
                with patch.object(bu_reauth, "paste_callback_url", return_value=True), \
                        patch.object(bu_reauth.time, "sleep"), \
                        patch.object(bu_reauth, "clear_email_cooldown"):
                    result = bu_reauth._complete_reauth(
                        object(), "http://localhost/callback", candidate, stale,
                        "operator@example.com", "claude", meta)

            self.assertEqual(result, bu_reauth.EXIT_SUCCESS)
            self.assertEqual(json.loads(canonical.read_text())["marker"], "canonical")
            activated = json.loads(target.read_text())
            self.assertEqual(activated["organization_uuid"], "org-max")
            self.assertFalse(activated["disabled"])

    def test_rejected_candidate_preserves_target_and_canonical_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            canonical = auth_dir / "claude-operator@example.com.json"
            target = auth_dir / "claude-operator-max.json"
            canonical.write_text(json.dumps({"marker": "canonical"}))
            target.write_text(json.dumps({"marker": "old-target"}))
            meta = dict(bu_reauth.PROVIDERS["claude"])

            with patch.object(bu_reauth, "AUTH_DIR", auth_dir):
                candidate, stale = bu_reauth.prepare_auth_target(
                    meta, "claude", "operator@example.com", target.name,
                    "org-max")
                candidate.write_text(json.dumps({
                    "email": "operator@example.com",
                    "type": "claude",
                    "expired": (
                        datetime.now(timezone.utc) + timedelta(days=2)
                    ).isoformat(),
                    "organization_uuid": "org-team",
                }))
                with patch.object(bu_reauth, "paste_callback_url", return_value=True), \
                        patch.object(bu_reauth.time, "sleep"):
                    result = bu_reauth._complete_reauth(
                        object(), "http://localhost/callback", candidate, stale,
                        "operator@example.com", "claude", meta)

            self.assertEqual(result, bu_reauth.EXIT_FAILURE)
            self.assertEqual(json.loads(canonical.read_text())["marker"], "canonical")
            self.assertEqual(json.loads(target.read_text())["marker"], "old-target")

    def test_checkpoint_persists_account_specific_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "checkpoint.json"
            meta = {
                "_target_auth_file": Path("claude-operator-max.json"),
                "_expected_organization_uuid": "org-max",
                "_expected_organization_name": "Example Max",
            }
            with patch.object(bu_reauth, "CHECKPOINT_FILE", checkpoint):
                bu_reauth.write_checkpoint(
                    "session", "run", "browser", "https://example.test/live",
                    "claude", "operator@example.com", 54545, meta)

            stored = json.loads(checkpoint.read_text())
            self.assertEqual(stored["auth_file"], "claude-operator-max.json")
            self.assertEqual(stored["expected_organization_uuid"], "org-max")
            self.assertEqual(stored["expected_organization_name"], "Example Max")


if __name__ == "__main__":
    unittest.main()
