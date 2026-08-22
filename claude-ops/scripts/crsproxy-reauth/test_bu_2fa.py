#!/usr/bin/env python3
"""Unit tests for cliproxy Browser Use 2FA helpers."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

import bu_2fa
import bu_reauth


def rfc_6238_secret() -> str:
    """Return the public RFC 6238 SHA1 test vector without a long secret literal."""
    return "".join(("GEZD", "GNBV", "GY3T", "QOJQ", "GEZD", "GNBV", "GY3T", "QOJQ"))


def test_totp_rfc_6238_vector():
    """TOTP generation matches the RFC 6238 SHA1 test vector."""
    secret = rfc_6238_secret()
    code = bu_2fa.totp_from_secret(secret, now=59, digits=8)
    assert code == "94287082", f"Expected RFC vector code, got {code}"
    print("PASS: TOTP generation matches RFC 6238 vector")


def test_otpauth_uri_parsing():
    """otpauth:// URIs are parsed for secret, period, digits, and algorithm."""
    uri = "otpauth://totp/example?secret=" + rfc_6238_secret() + "&period=30&digits=8&algorithm=SHA1"
    code = bu_2fa.totp_from_otpauth(uri, now=59)
    assert code == "94287082", f"Expected RFC vector code, got {code}"
    print("PASS: otpauth URI parsing generates the expected code")


def test_item_field_value_finds_otp_label():
    """1Password OTP fields are found by label."""
    item = {"fields": [{"label": "one-time password", "value": "ABC"}]}
    assert bu_2fa.item_field_value(item) == "ABC"
    print("PASS: 1Password OTP field found by label")


def test_needs_two_factor_ignores_email_verification_code():
    """Email verification-code prompts stay on the Gmail polling path."""
    assert bu_reauth.needs_two_factor("Check your email for a verification code") is False
    assert bu_reauth.needs_two_factor("Enter a code from your authenticator app") is True
    print("PASS: 2FA detection does not steal email verification prompts")


def test_handle_two_factor_prompt_none_when_not_needed():
    """No Browser Use run is created when no 2FA prompt is present."""
    client = MagicMock()
    assert bu_reauth.handle_two_factor_prompt(client, "session", "Authorize this app", None) is True
    client.create_run.assert_not_called()
    print("PASS: non-2FA pages do not create checkpoint runs")


def test_handle_two_factor_prompt_onepassword_totp():
    """Only the short-lived code is sent to Browser Use."""
    client = MagicMock()
    client.create_run.return_value = {"id": "run-123"}
    client.wait_for_run.return_value = {"result": "Continue button clicked"}
    client.get_run_events.return_value = []
    config = {"method": "onepassword_totp", "op_vault_id": "vault", "op_item_id": "item"}
    with patch.object(bu_reauth, "current_totp_from_config", return_value="123456"):
        assert bu_reauth.handle_two_factor_prompt(
            client, "session", "Enter a code from your authenticator app", config
        ) is True
    task = client.create_run.call_args.args[0]
    assert "123456" in task
    assert "vault" not in task
    assert "item" not in task
    print("PASS: Browser Use receives only the short-lived TOTP code")


def main():
    tests = [
        test_totp_rfc_6238_vector,
        test_otpauth_uri_parsing,
        test_item_field_value_finds_otp_label,
        test_needs_two_factor_ignores_email_verification_code,
        test_handle_two_factor_prompt_none_when_not_needed,
        test_handle_two_factor_prompt_onepassword_totp,
    ]
    for test in tests:
        test()
    print("\nAll 2FA tests passed")


if __name__ == "__main__":
    main()
