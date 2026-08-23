#!/usr/bin/env python3
"""test_auto_reauth_profiles.py — Unit tests for profile-first reauth.

auto_reauth.trigger_reauth() picks between two reauth scripts: if
reauth_seats.json maps a Browser Use Cloud profile to the account it runs
bu_profile_reauth.py with -profile-id, otherwise it falls back to the
email-based bu_reauth.py. That choice, the 2FA arguments it forwards, and
the promise that neither the full email nor the full profile ID reaches the
log had no coverage.

Run: python3 test_auto_reauth_profiles.py
"""

import os
import sys
import unittest
from unittest.mock import patch

# Add parent directory to path so we can import the module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auto_reauth


PROFILE_ID = "prof-0123456789abcdef-tail"
EMAIL = "operator@example.com"


def make_account(provider="claude", email=EMAIL, two_factor=None):
    """Build the account dict trigger_reauth expects."""
    account = {"provider": provider, "email": email, "reason": "expired"}
    if two_factor is not None:
        account["two_factor"] = two_factor
    return account


def seats_for(provider="claude", email=EMAIL, profile_id=PROFILE_ID):
    return {"seats": [{"provider": provider, "email": email,
                       "profile_id": profile_id}]}


class FakeProc:
    def __init__(self, returncode=0):
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


class TestFindSeat(unittest.TestCase):
    """find_seat matches on provider AND email, never one alone."""

    def test_matches_provider_and_email(self):
        seat = auto_reauth.find_seat(seats_for(), "claude", EMAIL)
        self.assertIsNotNone(seat)
        self.assertEqual(seat["profile_id"], PROFILE_ID)

    def test_same_email_different_provider_does_not_match(self):
        # One person can hold seats on several providers; matching on email
        # alone would reauth the wrong provider's profile.
        self.assertIsNone(auto_reauth.find_seat(seats_for(), "xai", EMAIL))

    def test_same_provider_different_email_does_not_match(self):
        self.assertIsNone(
            auto_reauth.find_seat(seats_for(), "claude", "other@example.com"))

    def test_missing_seats_key_returns_none(self):
        self.assertIsNone(auto_reauth.find_seat({}, "claude", EMAIL))


class TestTriggerReauthScriptChoice(unittest.TestCase):
    """A mapped seat selects the profile script; no seat falls back to email."""

    def _run(self, account, seats, env=None):
        env = env or {"GOG_ACCOUNT": "inbox@example.com"}
        with patch.object(auto_reauth, "subprocess") as mock_sub:
            mock_sub.run.return_value = FakeProc(0)
            ok, msg = auto_reauth.trigger_reauth(account, env, seats)
            cmd = mock_sub.run.call_args[0][0]
        return ok, msg, cmd

    def test_mapped_seat_uses_profile_script(self):
        ok, msg, cmd = self._run(make_account(), seats_for())
        self.assertTrue(ok)
        self.assertIn("profile", msg)
        self.assertIn(auto_reauth.PROFILE_REAUTH_SCRIPT, cmd)
        self.assertNotIn(auto_reauth.REAUTH_SCRIPT, cmd)
        self.assertIn("-profile-id", cmd)
        self.assertEqual(cmd[cmd.index("-profile-id") + 1], PROFILE_ID)

    def test_unmapped_account_falls_back_to_email_script(self):
        ok, msg, cmd = self._run(make_account(), {"seats": []})
        self.assertTrue(ok)
        self.assertIn("email", msg)
        self.assertIn(auto_reauth.REAUTH_SCRIPT, cmd)
        self.assertNotIn(auto_reauth.PROFILE_REAUTH_SCRIPT, cmd)
        self.assertNotIn("-profile-id", cmd)

    def test_seat_without_profile_id_falls_back(self):
        # A seat row can exist with the profile field not yet filled in.
        seats = {"seats": [{"provider": "claude", "email": EMAIL}]}
        _, msg, cmd = self._run(make_account(), seats)
        self.assertIn("email", msg)
        self.assertIn(auto_reauth.REAUTH_SCRIPT, cmd)

    def test_seats_none_falls_back(self):
        env = {"GOG_ACCOUNT": "inbox@example.com"}
        with patch.object(auto_reauth, "subprocess") as mock_sub:
            mock_sub.run.return_value = FakeProc(0)
            auto_reauth.trigger_reauth(make_account(), env, None)
            cmd = mock_sub.run.call_args[0][0]
        self.assertIn(auto_reauth.REAUTH_SCRIPT, cmd)


class TestTriggerReauthGogAccount(unittest.TestCase):
    """Claude verification mail lands in a central inbox, not the account."""

    def _cmd(self, account, env):
        with patch.object(auto_reauth, "subprocess") as mock_sub:
            mock_sub.run.return_value = FakeProc(0)
            auto_reauth.trigger_reauth(account, env, {"seats": []})
            return mock_sub.run.call_args[0][0]

    def test_claude_polls_the_central_inbox(self):
        cmd = self._cmd(make_account("claude"),
                        {"GOG_ACCOUNT": "inbox@example.com"})
        self.assertEqual(cmd[cmd.index("-gog-account") + 1],
                         "inbox@example.com")

    def test_claude_without_gog_account_falls_back_to_own_address(self):
        cmd = self._cmd(make_account("claude"), {})
        self.assertEqual(cmd[cmd.index("-gog-account") + 1], EMAIL)

    def test_other_providers_poll_their_own_address(self):
        cmd = self._cmd(make_account("xai"),
                        {"GOG_ACCOUNT": "inbox@example.com"})
        self.assertEqual(cmd[cmd.index("-gog-account") + 1], EMAIL)


class TestTriggerReauthTwoFactorArgs(unittest.TestCase):
    """2FA arguments are forwarded only when a method is configured."""

    def _cmd(self, two_factor, seats=None):
        with patch.object(auto_reauth, "subprocess") as mock_sub:
            mock_sub.run.return_value = FakeProc(0)
            auto_reauth.trigger_reauth(
                make_account(two_factor=two_factor),
                {"GOG_ACCOUNT": "inbox@example.com"},
                seats if seats is not None else {"seats": []})
            return mock_sub.run.call_args[0][0]

    def test_no_two_factor_block_omits_the_flags(self):
        self.assertNotIn("-two-factor-method", self._cmd(None))

    def test_method_none_omits_the_flags(self):
        self.assertNotIn("-two-factor-method", self._cmd({"method": "none"}))

    def test_onepassword_totp_forwards_vault_item_and_field(self):
        cmd = self._cmd({
            "method": "onepassword_totp",
            "op_vault_id": "vault-1",
            "op_item_id": "item-1",
            "op_field": "one-time password",
        })
        self.assertEqual(cmd[cmd.index("-two-factor-method") + 1],
                         "onepassword_totp")
        self.assertEqual(cmd[cmd.index("-op-vault-id") + 1], "vault-1")
        self.assertEqual(cmd[cmd.index("-op-item-id") + 1], "item-1")
        self.assertEqual(cmd[cmd.index("-op-field") + 1], "one-time password")

    def test_two_factor_args_also_reach_the_profile_script(self):
        cmd = self._cmd({"method": "onepassword_totp"}, seats_for())
        self.assertIn(auto_reauth.PROFILE_REAUTH_SCRIPT, cmd)
        self.assertIn("-two-factor-method", cmd)


class TestTriggerReauthDoesNotLeak(unittest.TestCase):
    """The docstring promises masked emails and a truncated profile ID."""

    def _logs(self, account, seats):
        lines = []
        with patch.object(auto_reauth, "subprocess") as mock_sub, \
                patch.object(auto_reauth, "log", side_effect=lines.append):
            mock_sub.run.return_value = FakeProc(0)
            auto_reauth.trigger_reauth(
                account, {"GOG_ACCOUNT": "inbox@example.com"}, seats)
        return "\n".join(lines)

    def test_full_email_is_never_logged(self):
        for seats in (seats_for(), {"seats": []}):
            out = self._logs(make_account(), seats)
            self.assertNotIn(EMAIL, out)
            self.assertIn(auto_reauth.mask_email(EMAIL), out)

    def test_profile_id_is_truncated(self):
        out = self._logs(make_account(), seats_for())
        self.assertNotIn(PROFILE_ID, out)
        self.assertIn(PROFILE_ID[:12], out)

    def test_subprocess_output_is_never_logged(self):
        lines = []
        with patch.object(auto_reauth, "subprocess") as mock_sub, \
                patch.object(auto_reauth, "log", side_effect=lines.append):
            proc = FakeProc(1)
            proc.stdout = "SENSITIVE-STDOUT-TOKEN"
            proc.stderr = "SENSITIVE-STDERR-TOKEN"
            mock_sub.run.return_value = proc
            auto_reauth.trigger_reauth(make_account(), {}, {"seats": []})
        out = "\n".join(lines)
        self.assertNotIn("SENSITIVE-STDOUT-TOKEN", out)
        self.assertNotIn("SENSITIVE-STDERR-TOKEN", out)


class TestTriggerReauthExitCodes(unittest.TestCase):
    """Exit code 2 is a human checkpoint, not a generic failure."""

    def _result(self, returncode):
        with patch.object(auto_reauth, "subprocess") as mock_sub:
            mock_sub.run.return_value = FakeProc(returncode)
            return auto_reauth.trigger_reauth(
                make_account(), {"GOG_ACCOUNT": "inbox@example.com"},
                seats_for())

    def test_zero_succeeds(self):
        ok, msg = self._result(0)
        self.assertTrue(ok)
        self.assertIn("succeeded", msg)

    def test_two_reports_a_captcha_checkpoint(self):
        ok, msg = self._result(2)
        self.assertFalse(ok)
        self.assertIn("checkpoint", msg)

    def test_other_nonzero_is_a_plain_failure(self):
        ok, msg = self._result(1)
        self.assertFalse(ok)
        self.assertIn("exit 1", msg)


if __name__ == "__main__":
    unittest.main()
