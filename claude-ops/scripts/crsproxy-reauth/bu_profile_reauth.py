#!/usr/bin/env python3
"""Browser Use Cloud — Profile-based OAuth re-auth for CRSProxy.

Uses a Browser Use Cloud persistent profile (with synced cookies) to
bypass the OAuth email/captcha flow. The agent starts already
authenticated (or uses Google sign-in via synced cookies) and clicks
Authorize directly.

Falls back to email entry if the profile doesn't have valid cookies,
and emits a human checkpoint if hCaptcha is detected.

Usage:
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_profile_reauth.py \\
      -provider claude -email info@auroracapital.nl -profile-id <BU_PROFILE_ID>
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Import infrastructure from bu_reauth.py
sys.path.insert(0, "/opt/crsproxy")
from bu_reauth import (
    BrowserUseClient,
    PROVIDERS,
    INTERCEPT_JS_TEMPLATE,
    LOG_DIR,
    LEASE_FILE,
    acquire_lease,
    release_lease,
    start_login,
    get_oauth_url,
    paste_callback_url,
    cleanup_login_process,
    validate_candidate,
    activate_auth_file,
    extract_callback_url,
    detect_captcha,
    handle_captcha_checkpoint,
    sanitize_url,
    safe_email,
    log,
    _log_file,
    AUTH_DIR,
    EXIT_SUCCESS,
    EXIT_FAILURE,
    EXIT_CAPTCHA,
    RUN_POLL_TIMEOUT,
    TOTAL_TIMEOUT,
    _timeout_handler,
)

# Also import _complete_reauth for the final step
from bu_reauth import _complete_reauth


def run_profile_reauth(provider: str, email: str, profile_id: str,
                       client: BrowserUseClient,
                       dry_run: bool = False) -> int:
    """Run the profile-based OAuth reauth flow.

    1. Acquire serialization lease.
    2. Start cli-proxy-api login (captures OAuth URL, starts callback listener).
    3. Create a Browser Use run with the profile — agent navigates to OAuth URL.
    4. If already authenticated (cookies), agent clicks Authorize directly.
    5. If not authenticated, agent tries Google sign-in (using synced Google cookies).
    6. Inject JS to intercept the callback URL.
    7. Extract callback URL from run result/events.
    8. Paste callback into cli-proxy-api PTY.
    9. Validate isolated candidate.
    10. Atomically activate if valid.
    """
    meta = PROVIDERS[provider]
    port = meta["callback_port"]
    safe = safe_email(email)
    log_path = Path("/tmp/bu_profile_reauth_hub.log")
    log_path.unlink(missing_ok=True)

    # --- Step 1: Acquire serialization lease ---
    if not acquire_lease(provider):
        log("Could not acquire lease — another login may be in progress")
        return EXIT_FAILURE

    try:
        return _run_profile_reauth_inner(provider, email, profile_id,
                                         client, dry_run, log_path)
    finally:
        release_lease()


def _run_profile_reauth_inner(provider: str, email: str, profile_id: str,
                              client: BrowserUseClient, dry_run: bool,
                              log_path: Path) -> int:
    """Inner profile reauth flow — assumes lease is already held."""
    meta = PROVIDERS[provider]
    port = meta["callback_port"]
    safe = safe_email(email)

    # --- Dry run ---
    if dry_run:
        log(f"[DRY RUN] Provider={provider} Email={safe} Profile={profile_id[:12]}...")
        log(f"[DRY RUN] Would start: cli-proxy-api {meta['login_flag']}")
        log(f"[DRY RUN] Would create BU run with profileId={profile_id[:12]}...")
        log("[DRY RUN] Validating Browser Use API access...")
        try:
            browsers = client.list_browsers()
            log(f"[DRY RUN] Browser Use API: OK ({len(browsers)} active sessions)")
        except Exception as e:
            log(f"[DRY RUN] Browser Use API error: {e}")
            return EXIT_FAILURE
        log("[DRY RUN] Dry run complete — no browser sessions started")
        return EXIT_SUCCESS

    # --- Step 1.5: Back up stale auth for preservation ---
    auth_file = AUTH_DIR / f"{meta['auth_file_prefix']}-{email}.json"
    stale_backup = auth_file.with_suffix(".stale")
    if auth_file.exists():
        try:
            stale_backup.unlink(missing_ok=True)
            stale_backup.write_text(auth_file.read_text())
            log(f"[1] Stale auth backed up: {auth_file.name}")
        except Exception as e:
            log(f"[1] Stale auth backup warning: {e}")
    else:
        log(f"[1] No existing auth file — no stale backup needed")

    # --- Step 2: Start cli-proxy-api login ---
    log(f"[1] Starting cli-proxy-api login for {provider} ({safe})")
    proc = start_login(provider, log_path)

    try:
        # --- Step 3: Capture OAuth URL ---
        log("[2] Waiting for OAuth URL...")
        oauth_url = get_oauth_url(log_path, provider)
        if not oauth_url:
            log("[ERROR] No OAuth URL found in login log")
            return EXIT_FAILURE
        log(f"[2] OAuth URL captured: {sanitize_url(oauth_url)}")

        # --- Step 4: Create Browser Use run with profile ---
        # The agent navigates to the OAuth URL. If the profile has valid
        # cookies, it should be already authenticated. If not, it tries
        # Google sign-in (which should work if Google cookies are synced).
        intercept_js = INTERCEPT_JS_TEMPLATE.format(port=port)
        log(f"[3] Creating Browser Use run with profileId={profile_id[:12]}...")

        task = (
            f"Navigate to this URL: {oauth_url}\n\n"
            f"If you see an 'Authorize' or 'Allow' or 'Continue' button, "
            f"first run this JavaScript in the browser console: {intercept_js}\n"
            f"Then click the Authorize/Allow/Continue button. "
            f"Wait 3 seconds. "
            f"Then run window.__CB__ in the console and report its exact value. "
            f"If null, report the current page URL.\n\n"
            f"If you see a login page instead of an Authorize button:\n"
            f"- If there is a 'Continue with Google' or Google sign-in option, click it. "
            f"Then if you see an Authorize button, run the JavaScript above and click it.\n"
            f"- If there is an email field, enter {email} and click Continue. "
            f"Report what you see next.\n"
            f"- If you see a CAPTCHA challenge, report 'CAPTCHA' and stop.\n"
        )

        run = client.create_run(task, profile_id=profile_id)
        run_id = run.get("id", "")
        session_id = run.get("sessionId", "")
        log(f"[3] Run created: {run_id[:12]}... session: {session_id[:12]}...")
        result = client.wait_for_run(run_id, timeout=RUN_POLL_TIMEOUT)
        text = str(result.get("result", "") or "")
        log(f"[3] Run complete: {text[:300]}")

        # Check for captcha
        if detect_captcha(result, client):
            log("[CAPTCHA] Captcha detected during profile-based auth")
            callback_url, session_id = handle_captcha_checkpoint(
                client, run_id, session_id, provider, email, port)
            if callback_url:
                return _complete_reauth(proc, callback_url, auth_file,
                                        stale_backup, email, provider, meta)
            return EXIT_CAPTCHA

        # --- Step 5: Extract callback URL ---
        log("[4] Searching for callback URL...")
        callback_url = extract_callback_url(result, client, provider)

        if not callback_url:
            # Try asking the agent directly for window.__CB__
            log("[4] Callback not found — asking agent for window.__CB__")
            task_cb = (
                "Run window.__CB__ in the browser console and report the exact value. "
                "If null, report the current page URL."
            )
            run_cb = client.create_run(task_cb, session_id=session_id)
            run_cb_id = run_cb.get("id", "")
            log(f"[4] Callback query run: {run_cb_id[:12]}...")
            result_cb = client.wait_for_run(run_cb_id, timeout=60)
            text_cb = str(result_cb.get("result", "") or "")
            log(f"[4] Callback query result: {text_cb[:200]}")
            callback_url = extract_callback_url(result_cb, client, provider)

        if not callback_url:
            # Check if the agent reported being on a login page
            text_lower = text.lower()
            if any(kw in text_lower for kw in ["login", "sign in", "email", "enter"]):
                log("[FALLBACK] Agent not authenticated — falling back to email entry")
                # Fall back to email entry in the same session
                return _fallback_email_entry(
                    proc, client, session_id, provider, email,
                    auth_file, stale_backup, meta, oauth_url)

            log("[FAIL] Could not extract callback URL from any run")
            log(f"[FAIL] Agent result: {text[:500]}")
            return EXIT_FAILURE

        log(f"[4] Callback URL extracted: {sanitize_url(callback_url)}")

        # --- Step 6-8: Paste, validate, and activate ---
        return _complete_reauth(proc, callback_url, auth_file,
                                stale_backup, email, provider, meta)

    except Exception as e:
        log(f"[ERROR] Unexpected error: {e}")
        return EXIT_FAILURE
    finally:
        log("[CLEANUP] Stopping all browser sessions...")
        client.stop_all_browsers()


def _fallback_email_entry(proc, client, session_id, provider, email,
                          auth_file, stale_backup, meta, oauth_url):
    """Fall back to email entry if the profile doesn't have valid cookies.

    This reuses the session to enter the email and proceed with the
    standard OAuth flow (code/magic link via Gmail).
    """
    from bu_reauth import (
        poll_gmail_for_code,
        record_email_send,
        _code_entry_failed,
        enforce_email_cooldown,
        clear_email_cooldown,
    )

    safe = safe_email(email)
    port = meta["callback_port"]

    log(f"[FALLBACK] Entering email for {safe}")
    task_email = (
        f"Enter {email} in the email field. "
        f"Click Continue. Do NOT use Google sign-in. "
        f"Report exactly what you see after clicking Continue."
    )
    run_email = client.create_run(task_email, session_id=session_id)
    run_email_id = run_email.get("id", "")
    session_id = run_email.get("sessionId", session_id)
    log(f"[FALLBACK] Email entry run: {run_email_id[:12]}...")
    result_email = client.wait_for_run(run_email_id, timeout=RUN_POLL_TIMEOUT)
    text_email = str(result_email.get("result", "") or "")
    log(f"[FALLBACK] Email entry complete: {text_email[:200]}")

    # Check for captcha
    if detect_captcha(result_email, client):
        log("[CAPTCHA] Captcha detected during email entry")
        callback_url, session_id = handle_captcha_checkpoint(
            client, run_email_id, session_id, provider, email, port)
        if callback_url:
            return _complete_reauth(proc, callback_url, auth_file,
                                    stale_backup, email, provider, meta)
        return EXIT_CAPTCHA

    # Check if verification code is needed
    needs_code = any(kw in text_email.lower() for kw in
                     ["code", "link sent", "verify", "check your email",
                      "magic", "email has been sent"])

    if not needs_code:
        log("[FALLBACK] No verification needed — proceeding to Authorize")
    else:
        log(f"[FALLBACK] Verification needed — polling Gmail for {safe}")
        time.sleep(5)

        code = poll_gmail_for_code(provider, email, email, kind="code")
        if code:
            record_email_send()
            log("[FALLBACK] Verification code received (value redacted)")

            max_code_retries = 3
            text2 = ""
            for attempt in range(max_code_retries):
                task_code = (
                    "Enter the verification code in the verification field. "
                    "Click Continue. Report what you see."
                )
                run_code = client.create_run(task_code, session_id=session_id)
                run_code_id = run_code.get("id", "")
                log(f"[FALLBACK] Code entry run (attempt {attempt+1}): {run_code_id[:12]}...")
                result_code = client.wait_for_run(run_code_id, timeout=RUN_POLL_TIMEOUT)
                text2 = str(result_code.get("result", "") or "")
                log(f"[FALLBACK] Code entry complete: {text2[:200]}")
                session_id = run_code.get("sessionId", session_id)

                if detect_captcha(result_code, client):
                    log("[CAPTCHA] Captcha detected after code entry")
                    callback_url, session_id = handle_captcha_checkpoint(
                        client, run_code_id, session_id, provider, email, port)
                    if callback_url:
                        return _complete_reauth(proc, callback_url, auth_file,
                                                stale_backup, email, provider, meta)
                    return EXIT_CAPTCHA

                if _code_entry_failed(text2):
                    log(f"[FALLBACK] Code entry failed on attempt {attempt+1}")
                    if attempt < max_code_retries - 1:
                        enforce_email_cooldown()
                        code = poll_gmail_for_code(provider, email, email, kind="code")
                        if code:
                            record_email_send()
                        else:
                            log("[FAIL] No new verification code received")
                            return EXIT_FAILURE
                    else:
                        log("[FAIL] Code entry failed after all retries")
                        return EXIT_FAILURE
                else:
                    break
        else:
            log("[FALLBACK] No verification code — trying magic link...")
            magic = poll_gmail_for_code(provider, email, email, kind="magic")
            if magic:
                log("[FALLBACK] Magic link received (value redacted)")
                task_magic = (
                    "Navigate to the magic link URL. "
                    "If you see an Authorize button, click it. "
                    "Report what you see."
                )
                run_magic = client.create_run(task_magic, session_id=session_id)
                result_magic = client.wait_for_run(run_magic.get("id", ""),
                                                    timeout=RUN_POLL_TIMEOUT)
                text_magic = str(result_magic.get("result", "") or "")
                log(f"[FALLBACK] Magic link run complete: {text_magic[:200]}")
                session_id = run_magic.get("sessionId", session_id)
            else:
                log("[FAIL] No verification code or magic link received")
                return EXIT_FAILURE

    # Click Authorize with JS interception
    intercept_js = INTERCEPT_JS_TEMPLATE.format(port=port)
    log(f"[FALLBACK] Injecting JS and clicking Authorize (port {port})")
    task_auth = (
        f"Run this JavaScript in the browser console: {intercept_js} "
        f"Then if you see an Authorize or Allow button, click it. "
        f"Wait 3 seconds. "
        f"Then run window.__CB__ in the console and report its value. "
        f"If null, report the current URL."
    )
    run_auth = client.create_run(task_auth, session_id=session_id)
    run_auth_id = run_auth.get("id", "")
    log(f"[FALLBACK] Authorize run: {run_auth_id[:12]}...")
    result_auth = client.wait_for_run(run_auth_id, timeout=RUN_POLL_TIMEOUT)
    text_auth = str(result_auth.get("result", "") or "")
    log(f"[FALLBACK] Authorize run complete: {text_auth[:200]}")

    if detect_captcha(result_auth, client):
        log("[CAPTCHA] Captcha detected during Authorize")
        callback_url, session_id = handle_captcha_checkpoint(
            client, run_auth_id, session_id, provider, email, port)
        if callback_url:
            return _complete_reauth(proc, callback_url, auth_file,
                                    stale_backup, email, provider, meta)
        return EXIT_CAPTCHA

    callback_url = extract_callback_url(result_auth, client, provider)

    if not callback_url:
        log("[FALLBACK] Callback not found — asking agent for window.__CB__")
        task_cb = (
            "Run window.__CB__ in the browser console and report the exact value. "
            "If null, report the current page URL."
        )
        run_cb = client.create_run(task_cb, session_id=session_id)
        result_cb = client.wait_for_run(run_cb.get("id", ""), timeout=60)
        callback_url = extract_callback_url(result_cb, client, provider)

    if not callback_url:
        log("[FAIL] Could not extract callback URL from fallback flow")
        return EXIT_FAILURE

    log(f"[FALLBACK] Callback URL extracted: {sanitize_url(callback_url)}")
    return _complete_reauth(proc, callback_url, auth_file,
                            stale_backup, email, provider, meta)


def main():
    global _log_file

    parser = argparse.ArgumentParser(
        description="Profile-based OAuth reauth for CRSProxy")
    parser.add_argument("-provider", required=True,
                        choices=["claude", "xai", "codex"],
                        help="OAuth provider")
    parser.add_argument("-email", required=True,
                        help="Account email")
    parser.add_argument("-profile-id", required=True,
                        help="Browser Use Cloud profile ID")
    parser.add_argument("-dry-run", action="store_true",
                        help="Validate setup without creating browser runs")
    args = parser.parse_args()

    log_path = LOG_DIR / f"bu_profile_reauth_{args.provider}_{args.email.split('@')[0]}.log"
    _log_file = open(log_path, "a", encoding="utf-8")

    # Set overall timeout
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TOTAL_TIMEOUT)

    # Get API key
    api_key = os.environ.get("BROWSER_USE_API_KEY", "")
    if not api_key:
        env_path = Path("/opt/crsproxy/.env")
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("BROWSER_USE_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if not api_key:
        log("[FATAL] BROWSER_USE_API_KEY not found")
        return EXIT_FAILURE

    log(f"=== Profile Reauth: {args.provider} / {safe_email(args.email)} ===")
    log(f"=== Profile ID: {args.profile_id[:12]}... ===")

    client = BrowserUseClient(api_key)
    import atexit
    atexit.register(client.stop_all_browsers)

    try:
        exit_code = run_profile_reauth(
            provider=args.provider,
            email=args.email,
            profile_id=args.profile_id,
            client=client,
            dry_run=args.dry_run,
        )
    except TimeoutError as e:
        log(f"[TIMEOUT] {e}")
        exit_code = EXIT_FAILURE
    except KeyboardInterrupt:
        log("[INTERRUPTED] User interrupted")
        exit_code = EXIT_FAILURE
    finally:
        signal.alarm(0)
        client.stop_all_browsers()

    log(f"=== Exit code: {exit_code} ===")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
