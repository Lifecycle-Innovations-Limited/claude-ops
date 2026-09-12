"""Regression test for accounts that require Claude's magic-link login path."""

from bu_reauth import build_email_login_task


def test_prefer_magic_explicitly_requests_a_fresh_login_link():
    task = build_email_login_task(
        "https://claude.ai/oauth/authorize", "support@healify.io", True
    )

    assert "Email me a login link" in task
    assert "send the link" in task


def test_default_login_does_not_force_magic_link_choice():
    task = build_email_login_task(
        "https://claude.ai/oauth/authorize", "support@healify.io", False
    )

    assert "Email me a login link" not in task
