#!/usr/bin/env python3
"""Direct OAuth reauth for Aurora using BU Cloud API.

This script bypasses the bu_profile_reauth.py fallback flow and directly
controls the BU Cloud API to:
1. Start cli-proxy-api login (captures OAuth URL)
2. Create a BU Cloud run with the profile that enters the email
3. Poll Gmail for the magic link
4. Create a follow-up run that navigates to the magic link
5. Create another run that injects JS interception and clicks Authorize via JS
6. Capture the callback URL
7. Paste it into cli-proxy-api PTY
8. Validate and activate

Usage:
  sudo -u crsproxy bash -c "cd /opt/crsproxy && set -a && source /opt/crsproxy/.env && source /opt/crsproxy/.gog-keyring-env && set +a && /opt/crsproxy/venv/bin/python /tmp/aurora_reauth_direct.py"
"""

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/opt/crsproxy")
from bu_reauth import (
    BrowserUseClient,
    PROVIDERS,
    acquire_lease,
    release_lease,
    start_login,
    get_oauth_url,
    paste_callback_url,
    cleanup_login_process,
    validate_candidate,
    activate_auth_file,
    sanitize_url,
    safe_email,
    log,
    AUTH_DIR,
    EXIT_SUCCESS,
    EXIT_FAILURE,
    EXIT_CAPTCHA,
    _timeout_handler,
    _complete_reauth,
)
from bu_reauth import poll_gmail_for_code

PROVIDER = "claude"
EMAIL = os.environ.get("REAUTH_EMAIL", "user@example.com")
PROFILE_ID = os.environ.get("BU_PROFILE_ID", "<BU_PROFILE_ID>")
GOG_ACCOUNT = os.environ.get("GMAIL_TARGET_INBOX", "user@example.com")
PORT = 54545

# JS to intercept the callback URL - uses multiple methods
INTERCEPT_JS = """
window.__CB__ = null;
// Method 1: Navigation API
if (window.navigation) {
  window.navigation.addEventListener('navigate', function(e) {
    var u = e.destination.url;
    if (u.includes('localhost:%PORT%') || u.includes('callback')) {
      window.__CB__ = u;
      e.preventDefault();
    }
  });
}
// Method 2: Override location methods
var origAssign = window.location.assign.bind(window.location);
window.location.assign = function(url) {
  if (String(url).includes('localhost:%PORT%') || String(url).includes('callback')) {
    window.__CB__ = String(url);
    return;
  }
  return origAssign(url);
};
var origReplace = window.location.replace.bind(window.location);
window.location.replace = function(url) {
  if (String(url).includes('localhost:%PORT%') || String(url).includes('callback')) {
    window.__CB__ = String(url);
    return;
  }
  return origReplace(url);
};
// Method 3: beforeunload
window.addEventListener('beforeunload', function(e) {
  if (window.location.href.includes('callback') || window.location.href.includes('localhost:%PORT%')) {
    window.__CB__ = window.location.href;
  }
});
// Method 4: Intercept form submissions
document.addEventListener('submit', function(e) {
  var form = e.target;
  if (form.action && (String(form.action).includes('localhost:%PORT%') || String(form.action).includes('callback'))) {
    window.__CB__ = String(form.action);
  }
}, true);
""".replace("%PORT%", str(PORT))

# JS to find and click the Authorize button
CLICK_AUTHORIZE_JS = """
var btn = null;
var buttons = document.querySelectorAll('button, input[type=submit], a[role=button]');
for (var i = 0; i < buttons.length; i++) {
  var text = (buttons[i].textContent || buttons[i].value || '').trim();
  if (text.match(/authorize|allow|continue|grant/i)) {
    btn = buttons[i];
    break;
  }
}
if (btn) {
  btn.click();
  'CLICKED: ' + btn.textContent.trim();
} else {
  'NO_BUTTON_FOUND';
}
"""


def run_reauth():
    """Run the direct reauth flow."""
    safe = safe_email(EMAIL)
    log_path = Path("/tmp/aurora_reauth_direct.log")
    log_path.unlink(missing_ok=True)

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

    client = BrowserUseClient(api_key)
    import atexit
    atexit.register(client.stop_all_browsers)

    # Acquire lease
    if not acquire_lease(PROVIDER):
        log("Could not acquire lease")
        return EXIT_FAILURE

    auth_file = AUTH_DIR / f"claude-{EMAIL}.json"
    stale_backup = auth_file.with_suffix(".stale")
    if auth_file.exists():
        stale_backup.unlink(missing_ok=True)
        stale_backup.write_text(auth_file.read_text())
        log(f"Stale auth backed up: {auth_file.name}")

    try:
        return _run_reauth_inner(client, auth_file, stale_backup, log_path)
    finally:
        release_lease()
        client.stop_all_browsers()


def _run_reauth_inner(client, auth_file, stale_backup, log_path):
    """Inner reauth flow - assumes lease is held."""
    safe = safe_email(EMAIL)
    meta = PROVIDERS[PROVIDER]

    # Step 1: Start cli-proxy-api login
    log("[1] Starting cli-proxy-api login")
    proc = start_login(PROVIDER, log_path)

    try:
        # Step 2: Capture OAuth URL
        log("[2] Waiting for OAuth URL...")
        oauth_url = get_oauth_url(log_path, PROVIDER)
        if not oauth_url:
            log("[ERROR] No OAuth URL found")
            return EXIT_FAILURE
        log(f"[2] OAuth URL captured: {sanitize_url(oauth_url)}")

        # Step 3: Create BU Cloud run - enter email
        log("[3] Creating BU Cloud run to enter email")
        task_enter = (
            f"Navigate to this URL: {oauth_url}\n"
            f"If you see an email field, enter {EMAIL} and click Continue. "
            f"Do NOT use Google sign-in. "
            f"Report exactly what you see after clicking Continue."
        )
        run = client.create_run(task_enter, profile_id=PROFILE_ID)
        run_id = run.get("id", "")
        session_id = run.get("sessionId", "")
        log(f"[3] Run created: {run_id[:12]}... session: {session_id[:12]}...")
        result = client.wait_for_run(run_id, timeout=120)
        text = str(result.get("result", "") or "")
        log(f"[3] Run complete: {text[:300]}")
        session_id = result.get("sessionId", session_id)

        # Check if already authenticated (Authorize button visible)
        if "authorize" in text.lower() or "allow" in text.lower():
            log("[3] Already authenticated - proceeding to Authorize")
            callback_url = _click_authorize(client, session_id)
            if callback_url:
                return _complete_reauth(proc, callback_url, auth_file,
                                        stale_backup, EMAIL, PROVIDER, meta)
            log("[FAIL] Could not capture callback after direct Authorize")
            return EXIT_FAILURE

        # Step 4: Poll Gmail for magic link
        log(f"[4] Polling Gmail for magic link ({safe})")
        time.sleep(5)
        magic = poll_gmail_for_code(PROVIDER, EMAIL, GOG_ACCOUNT, kind="magic")
        if not magic:
            log("[4] No magic link - trying verification code")
            code = poll_gmail_for_code(PROVIDER, EMAIL, GOG_ACCOUNT, kind="code")
            if code:
                log("[4] Verification code found - entering code")
                task_code = (
                    f"Click 'Enter verification code' if you see that option. "
                    f"Then enter the verification code {code} in the verification field. "
                    f"Click Continue. Report what you see."
                )
                run_code = client.create_run(task_code, session_id=session_id)
                result_code = client.wait_for_run(run_code.get("id", ""), timeout=120)
                text_code = str(result_code.get("result", "") or "")
                log(f"[4] Code entry complete: {text_code[:200]}")
                session_id = result_code.get("sessionId", session_id)

                # Check if we need to click Authorize
                if "authorize" in text_code.lower() or "allow" in text_code.lower():
                    callback_url = _click_authorize(client, session_id)
                    if callback_url:
                        return _complete_reauth(proc, callback_url, auth_file,
                                                stale_backup, EMAIL, PROVIDER, meta)
                # Try to extract callback from the result
                callback_url = _extract_callback(text_code)
                if callback_url:
                    return _complete_reauth(proc, callback_url, auth_file,
                                            stale_backup, EMAIL, PROVIDER, meta)
            log("[FAIL] No magic link or verification code received")
            return EXIT_FAILURE

        log("[4] Magic link received (value redacted)")

        # Step 5: Navigate to magic link (DON'T click Authorize yet)
        log("[5] Navigating to magic link")
        task_magic = (
            f"Navigate to this URL: {magic}\n"
            f"Wait for the page to fully load. "
            f"Report the current page URL and what you see on the page. "
            f"Do NOT click any buttons yet."
        )
        run_magic = client.create_run(task_magic, session_id=session_id)
        result_magic = client.wait_for_run(run_magic.get("id", ""), timeout=120)
        text_magic = str(result_magic.get("result", "") or "")
        log(f"[5] Magic link navigation complete: {text_magic[:200]}")
        session_id = result_magic.get("sessionId", session_id)

        # Check if we're on the OAuth authorize page
        if "authorize" not in text_magic.lower() and "allow" not in text_magic.lower():
            # Maybe we need to navigate to the OAuth URL
            log("[5] Not on authorize page - navigating to OAuth URL")
            task_oauth = (
                f"Navigate to this URL: {oauth_url}\n"
                f"Report what you see. Do NOT click any buttons yet."
            )
            run_oauth = client.create_run(task_oauth, session_id=session_id)
            result_oauth = client.wait_for_run(run_oauth.get("id", ""), timeout=120)
            text_oauth = str(result_oauth.get("result", "") or "")
            log(f"[5] OAuth navigation complete: {text_oauth[:200]}")
            session_id = result_oauth.get("sessionId", session_id)

        # Step 6: Inject JS and click Authorize
        callback_url = _click_authorize(client, session_id)
        if callback_url:
            log(f"[6] Callback URL captured: {sanitize_url(callback_url)}")
            return _complete_reauth(proc, callback_url, auth_file,
                                    stale_backup, EMAIL, PROVIDER, meta)

        # Step 7: Try asking agent for the URL directly
        log("[7] Asking agent for current URL")
        task_url = (
            "Report the current page URL exactly as it appears in the address bar. "
            "Also report window.__CB__ if it has a value."
        )
        run_url = client.create_run(task_url, session_id=session_id)
        result_url = client.wait_for_run(run_url.get("id", ""), timeout=60)
        text_url = str(result_url.get("result", "") or "")
        log(f"[7] URL query result: {text_url[:200]}")

        callback_url = _extract_callback(text_url)
        if callback_url:
            log(f"[7] Callback URL extracted: {sanitize_url(callback_url)}")
            return _complete_reauth(proc, callback_url, auth_file,
                                    stale_backup, EMAIL, PROVIDER, meta)

        log("[FAIL] Could not capture callback URL")
        return EXIT_FAILURE

    except Exception as e:
        log(f"[ERROR] {e}")
        return EXIT_FAILURE
    finally:
        cleanup_login_process(proc)


def _click_authorize(client, session_id):
    """Inject JS interception and click Authorize via JavaScript."""
    log("[6] Injecting JS interception and clicking Authorize")

    # First, inject the JS interception
    task_inject = (
        f"Run this JavaScript in the browser console: {INTERCEPT_JS}\n"
        f"Then run this JavaScript to find and click the Authorize button: {CLICK_AUTHORIZE_JS}\n"
        f"Wait 5 seconds. "
        f"Then run window.__CB__ in the console and report its exact value. "
        f"If null, report the current page URL exactly."
    )
    run = client.create_run(task_inject, session_id=session_id)
    result = client.wait_for_run(run.get("id", ""), timeout=120)
    text = str(result.get("result", "") or "")
    log(f"[6] Authorize run complete: {text[:200]}")

    # Try to extract callback URL from the result
    callback_url = _extract_callback(text)
    if callback_url:
        return callback_url

    # Try asking for window.__CB__ directly
    task_cb = (
        "Run window.__CB__ in the browser console and report the exact value. "
        "If null, report the current page URL exactly as it appears in the address bar."
    )
    run_cb = client.create_run(task_cb, session_id=result.get("sessionId", session_id))
    result_cb = client.wait_for_run(run_cb.get("id", ""), timeout=60)
    text_cb = str(result_cb.get("result", "") or "")
    log(f"[6] CB query result: {text_cb[:200]}")

    callback_url = _extract_callback(text_cb)
    if callback_url:
        return callback_url

    return None


def _extract_callback(text):
    """Extract a callback URL from text."""
    # Look for localhost:54545/callback?code=... pattern
    pattern = r'https?://localhost:54545/callback\?[^\s"\'`]+'
    match = re.search(pattern, text)
    if match:
        return match.group(0)

    # Also look for any URL with callback and code
    pattern2 = r'https?://[^\s"\'`]*callback[^\s"\'`]*code=[^\s"\'`]+'
    match = re.search(pattern2, text)
    if match:
        return match.group(0)

    # Look for window.__CB__ value
    pattern3 = r'window\.__CB__\s*(?:is|=)\s*["\']?(https?://[^\s"\'`]+)'
    match = re.search(pattern3, text, re.IGNORECASE)
    if match:
        return match.group(1)

    return None


def main():
    # Set up logging
    from bu_reauth import _log_file, LOG_DIR, TOTAL_TIMEOUT
    global _log_file
    log_path = LOG_DIR / "aurora_reauth_direct.log"
    _log_file = open(log_path, "a", encoding="utf-8")

    # Set timeout
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TOTAL_TIMEOUT)

    log(f"=== Aurora Direct Reauth: {safe_email(EMAIL)} ===")
    log(f"=== Profile: {PROFILE_ID[:12]}... ===")
    log(f"=== GOG Account: {GOG_ACCOUNT} ===")

    try:
        exit_code = run_reauth()
    except TimeoutError as e:
        log(f"[TIMEOUT] {e}")
        exit_code = EXIT_FAILURE
    except KeyboardInterrupt:
        log("[INTERRUPTED]")
        exit_code = EXIT_FAILURE
    finally:
        signal.alarm(0)

    log(f"=== Exit code: {exit_code} ===")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
