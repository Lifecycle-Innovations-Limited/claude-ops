#!/usr/bin/env python3
"""Browser Use Cloud Agent — OAuth re-auth for CRSProxy.

Production-grade reauth script that uses Browser Use Cloud to automate
OAuth flows for Claude, xAI, and Codex providers on the healify-hub EC2.

Features:
  - Proper timeout handling on all Browser Use API calls (never hang).
  - Always stops browser sessions on completion/timeout.
  - JS Navigation API callback interception (window.__CB__).
  - PTY paste of callback URL into cli-proxy-api stdin.
  - Sanitizes all URLs in logs using sanitize_url().
  - Never prints tokens, codes, magic links, or cookies.
  - Supports all OAuth providers (Claude, xAI, Codex) with provider-specific
    callback ports.
  - Structured exit codes: 0=success, 1=failure, 2=captcha.

Usage:
  # Full reauth for a Claude account
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email info@auroracapital.nl -gog-account info@auroracapital.nl

  # Dry run (validates setup, no browser runs)
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email info@auroracapital.nl -dry-run

  # xAI reauth
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider xai -email sam@samfeldt.com -gog-account sam@samfeldt.com

  # Codex reauth
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider codex -email sam@samfeldt.com -gog-account sam@samfeldt.com
"""

import argparse
import atexit
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------
HUB_BIN = "/opt/crsproxy/cli-proxy-api"
HUB_CONFIG = "/opt/crsproxy/config.yaml"
AUTH_DIR = Path("/opt/crsproxy/auths")
HOME_DIR = Path("/opt/crsproxy")
BU_API_BASE = "https://api.browser-use.com/api/v4"
BU_MODEL = "gpt-5.6-luna"
LOG_DIR = Path("/tmp")
LEASE_FILE = Path("/tmp/crsproxy-claude-oauth-lease.json")

# Exit codes
EXIT_SUCCESS = 0
EXIT_FAILURE = 1
EXIT_CAPTCHA = 2

# Timeouts (seconds)
API_TIMEOUT = 30          # per HTTP request
RUN_POLL_INTERVAL = 3     # poll run status every 3s
RUN_POLL_TIMEOUT = 120    # max wait for a single agent run
OAUTH_URL_TIMEOUT = 60    # max wait for OAuth URL from cli-proxy-api
GMAIL_POLL_TIMEOUT = 180  # max wait for Gmail code/link
PTY_PASTE_WAIT = 5       # wait after pasting callback URL
AUTH_FILE_WAIT = 10      # wait for auth file to appear after paste
TOTAL_TIMEOUT = 300       # overall script timeout (5 minutes)
LEASE_STALE_SECONDS = 600 # lease older than 10 min is stale

# Provider configuration: callback ports, login flags, auth URL patterns.
PROVIDERS = {
    "claude": {
        "login_flag": "-claude-login",
        "callback_port": 54545,
        "callback_url_re": r"http://localhost:54545/callback\?[^\s\"']+",
        "auth_url_re": r"https://claude\.ai/oauth/authorize\?[^\s]+",
        "auth_file_prefix": "claude",
        "email_sender": "anthropic.com",
        "domain": "claude.ai",
    },
    "xai": {
        "login_flag": "-xai-login",
        "callback_port": 51121,
        "callback_url_re": r"http://localhost:51121/[^\s\"']*callback\?[^\s\"']+",
        "auth_url_re": r"https://accounts\.x\.ai/oauth/authorize\?[^\s]+",
        "auth_file_prefix": "xai",
        "email_sender": "noreply@x.ai",
        "domain": "accounts.x.ai",
    },
    "codex": {
        "login_flag": "-codex-login",
        "callback_port": 1455,
        "callback_url_re": r"http://localhost:1455/auth/callback\?[^\s\"']+",
        "auth_url_re": r"https://auth\.openai\.com/oauth/authorize\?[^\s]+",
        "auth_file_prefix": "codex",
        "email_sender": "noreply@openai.com",
        "domain": "auth.openai.com",
    },
}

# JS to inject before clicking Authorize.  Intercepts the navigation to the
# localhost callback URL and stores it in window.__CB__ so the agent can
# retrieve it after clicking.  The port is templated per provider.
INTERCEPT_JS_TEMPLATE = """
window.__CB__=null;
if(navigation){{
  navigation.addEventListener('navigate',e=>{{
    const u=e.destination.url;
    if(u.includes('localhost:{port}')||u.includes('callback')){{
      window.__CB__=u;
      e.preventDefault();
    }}
  }});
}}else{{
  window.addEventListener('beforeunload',e=>{{
    if(location.href.includes('callback'))window.__CB__=location.href;
  }});
}}
"""

# ---------------------------------------------------------------------------
# Logging — sanitized, no secrets
# ---------------------------------------------------------------------------
_log_file = None


def log(msg: str):
    """Log a message to stdout and the log file. Never log secrets."""
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    if _log_file:
        try:
            _log_file.write(line + "\n")
            _log_file.flush()
        except Exception:
            pass


def sanitize_url(raw: str) -> str:
    """Strip query parameters and fragments from a URL to remove secrets.

    Returns scheme://netloc/path only, or empty string on error.
    """
    try:
        from urllib.parse import urlparse
        parsed = urlparse(raw)
        if parsed.scheme in ("http", "https"):
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        pass
    return ""


def safe_email(email: str) -> str:
    """Redact the local part of an email for logging (e.g. i***@domain.com)."""
    if "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


# ---------------------------------------------------------------------------
# Serialization lease
# ---------------------------------------------------------------------------
def acquire_lease(provider: str) -> bool:
    """Check/create the serialization lease file. Returns True if acquired."""
    if LEASE_FILE.exists():
        try:
            data = json.loads(LEASE_FILE.read_text())
            age = time.time() - data.get("timestamp", 0)
            if age < LEASE_STALE_SECONDS:
                log(f"Lease held by {data.get('provider','?')} "
                    f"({int(age)}s old) — waiting")
                return False
            log(f"Stale lease ({int(age)}s old) — removing")
            LEASE_FILE.unlink()
        except (json.JSONDecodeError, OSError):
            try:
                LEASE_FILE.unlink()
            except OSError:
                pass
    LEASE_FILE.write_text(json.dumps({
        "provider": provider,
        "timestamp": time.time(),
        "pid": os.getpid(),
    }))
    log(f"Lease acquired for {provider}")
    return True


def release_lease():
    """Remove the serialization lease file."""
    try:
        LEASE_FILE.unlink(missing_ok=True)
        log("Lease released")
    except Exception as e:
        log(f"Lease release error: {e}")


# ---------------------------------------------------------------------------
# Browser Use Cloud API client
# ---------------------------------------------------------------------------
class BrowserUseClient:
    """Thin wrapper around the Browser Use Cloud REST API with timeouts."""

    def __init__(self, api_key: str, base_url: str = BU_API_BASE):
        self.base = base_url
        self.headers = {
            "X-Browser-Use-API-Key": api_key,
            "Content-Type": "application/json",
        }
        self._browser_sessions: list[str] = []
        self._runs: list[str] = []

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        """Make an HTTP request with a guaranteed timeout."""
        kwargs.setdefault("timeout", API_TIMEOUT)
        url = f"{self.base}{path}"
        r = requests.request(method, url, headers=self.headers, **kwargs)
        r.raise_for_status()
        return r

    def create_run(self, task: str, session_id: str = "",
                   profile_id: str = "") -> dict:
        """Create a new Browser Use agent run."""
        payload = {"task": task, "model": BU_MODEL}
        if session_id:
            payload["sessionId"] = session_id
        if profile_id:
            payload.setdefault("browserSettings", {})["profileId"] = profile_id
        r = self._request("POST", "/runs", json=payload)
        data = r.json()
        run_id = data.get("id", "")
        if run_id:
            self._runs.append(run_id)
        return data

    def get_run_status(self, run_id: str) -> str:
        """Get the status of a run."""
        r = self._request("GET", f"/runs/{run_id}/status")
        return r.json().get("status", "?")

    def get_run(self, run_id: str) -> dict:
        """Get full run details."""
        r = self._request("GET", f"/runs/{run_id}")
        return r.json()

    def get_run_events(self, run_id: str, limit: int = 50) -> list:
        """Get events for a run."""
        r = self._request("GET", f"/runs/{run_id}/events",
                          params={"limit": limit})
        return r.json().get("events", [])

    def cancel_run(self, run_id: str):
        """Cancel a run (best effort)."""
        try:
            self._request("PATCH", f"/runs/{run_id}",
                          json={"action": "cancel"})
        except Exception:
            pass

    def stop_browser(self, browser_id: str):
        """Stop a browser session via PATCH /api/v4/browsers/{id}."""
        if not browser_id:
            return
        try:
            self._request("PATCH", f"/browsers/{browser_id}",
                          json={"action": "stop"})
            log(f"Browser session stopped: {browser_id[:12]}...")
        except Exception as e:
            log(f"Browser stop error for {browser_id[:12]}: {e}")
        finally:
            if browser_id in self._browser_sessions:
                self._browser_sessions.remove(browser_id)

    def list_browsers(self) -> list:
        """List all running browser sessions."""
        try:
            r = self._request("GET", "/browsers")
            return r.json() if r.content else []
        except Exception:
            return []

    def stop_all_browsers(self):
        """Stop all tracked browser sessions."""
        for bid in list(self._browser_sessions):
            self.stop_browser(bid)
        # Also check for any running sessions we might have missed
        try:
            browsers = self.list_browsers()
            for b in browsers:
                bid = b.get("id", "")
                if bid:
                    self.stop_browser(bid)
        except Exception:
            pass

    def wait_for_run(self, run_id: str, timeout: int = RUN_POLL_TIMEOUT,
                     track_browser: bool = True) -> dict:
        """Poll a run until it completes, times out, or is cancelled.

        Tracks browser session IDs from events for cleanup.
        Returns the full run dict on completion, or {"status": "timeout"} on timeout.
        """
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                status = self.get_run_status(run_id)
                if status in ("completed", "failed", "cancelled"):
                    return self.get_run(run_id)
                # Poll events to track browser sessions
                if track_browser:
                    events = self.get_run_events(run_id, limit=10)
                    for e in events:
                        ed = e.get("data", {})
                        if e.get("type") == "browser.ready":
                            bid = ed.get("browser_session_id", "")
                            if bid and bid not in self._browser_sessions:
                                self._browser_sessions.append(bid)
                                log(f"Browser session started: {bid[:12]}...")
            except Exception as e:
                log(f"Poll error: {e}")
            time.sleep(RUN_POLL_INTERVAL)

        log(f"Run {run_id[:12]} timed out after {timeout}s — cancelling")
        self.cancel_run(run_id)
        return {"status": "timeout", "result": None}

    def get_live_view_url(self, run_id: str) -> str:
        """Extract the live view URL from run events (for human captcha checkpoint)."""
        try:
            events = self.get_run_events(run_id, limit=100)
            for e in events:
                ed = e.get("data", {})
                if e.get("type") == "browser.ready":
                    return ed.get("live_view_url", "")
        except Exception:
            pass
        return ""


# ---------------------------------------------------------------------------
# cli-proxy-api login process management
# ---------------------------------------------------------------------------
def start_login(provider: str, log_path: Path) -> subprocess.Popen:
    """Start cli-proxy-api login process with a PTY for interactive callback."""
    meta = PROVIDERS[provider]
    cmd = [
        HUB_BIN, "-config", HUB_CONFIG,
        meta["login_flag"], "-no-browser",
        "-oauth-callback-port", str(meta["callback_port"]),
    ]
    env = os.environ.copy()
    env["HOME"] = str(HOME_DIR)

    import pty
    master_fd, slave_fd = pty.openpty()
    out = open(log_path, "a", encoding="utf-8")
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(HOME_DIR),
            stdin=slave_fd,
            stdout=out,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
    finally:
        os.close(slave_fd)
        out.close()
    proc._pty_master = master_fd
    return proc


def get_oauth_url(log_path: Path, provider: str,
                  timeout: int = OAUTH_URL_TIMEOUT) -> str | None:
    """Wait for the OAuth URL to appear in the login log."""
    meta = PROVIDERS[provider]
    pattern = meta["auth_url_re"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            text = log_path.read_text(errors="ignore")
            matches = re.findall(pattern, text)
            if matches:
                return matches[-1]
        except Exception:
            pass
        time.sleep(1)
    return None


def paste_callback_url(proc: subprocess.Popen, url: str) -> bool:
    """Write the callback URL into the cli-proxy-api PTY stdin."""
    master_fd = getattr(proc, "_pty_master", None)
    if master_fd is None:
        log("No PTY master fd — cannot paste callback URL")
        return False
    try:
        os.write(master_fd, (url + "\n").encode())
        log(f"Callback URL pasted to cli-proxy-api PTY: {sanitize_url(url)}")
        return True
    except OSError as e:
        log(f"PTY write error: {e}")
        return False


def cleanup_login_process(proc: subprocess.Popen):
    """Terminate the cli-proxy-api login process and close its PTY."""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
    except Exception as e:
        log(f"Login process cleanup error: {e}")
    master_fd = getattr(proc, "_pty_master", None)
    if master_fd is not None:
        try:
            os.close(master_fd)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Gmail polling (delegates to reauth_hub.poll_gmail)
# ---------------------------------------------------------------------------
def poll_gmail_for_code(provider: str, email: str, gog_account: str,
                        kind: str = "code") -> str | None:
    """Poll Gmail for a verification code or magic link via gogcli.

    Delegates to reauth_hub.poll_gmail to avoid duplicating the Gmail logic.
    Never prints the code/link value — only logs that it was found.
    """
    try:
        sys.path.insert(0, "/opt/crsproxy")
        from reauth_hub import poll_gmail as _poll_gmail, PROVIDERS as _RH_PROVIDERS
    except ImportError:
        log("Cannot import poll_gmail from reauth_hub — Gmail polling unavailable")
        return None

    meta = _RH_PROVIDERS.get(provider, {})
    seat = {
        "provider": provider,
        "email": email,
        "email_sender": meta.get("email_sender", ""),
    }
    log_path = Path("/tmp/bu_reauth_gmail.log")
    result = _poll_gmail(seat, gog_account, kind=kind, log_path=log_path,
                        timeout=GMAIL_POLL_TIMEOUT)
    if result:
        log(f"Gmail {kind} found (value redacted)")
    else:
        log(f"Gmail {kind} poll timed out")
    return result


# ---------------------------------------------------------------------------
# Callback URL extraction
# ---------------------------------------------------------------------------
def extract_callback_url(run_result: dict, client: BrowserUseClient,
                         provider: str) -> str | None:
    """Search run results and events for the OAuth callback URL.

    Never logs the full URL — uses sanitize_url() for any logging.
    """
    meta = PROVIDERS[provider]
    pattern = meta["callback_url_re"]

    # Search run result text
    result_text = str(run_result.get("result", "") or "")
    m = re.search(pattern, result_text)
    if m:
        log(f"Callback URL found in run result: {sanitize_url(m.group(0))}")
        return m.group(0)

    # Search run events
    run_id = run_result.get("id", "")
    if run_id:
        try:
            events = client.get_run_events(run_id, limit=100)
            for e in events:
                ed = e.get("data", {})
                # Check event data for callback URL
                event_str = json.dumps(ed)
                m = re.search(pattern, event_str)
                if m:
                    log(f"Callback URL found in run events: {sanitize_url(m.group(0))}")
                    return m.group(0)
        except Exception as e:
            log(f"Event search error: {e}")

    return None


def detect_captcha(run_result: dict, client: BrowserUseClient) -> bool:
    """Check if the run result or events indicate a real captcha challenge."""
    result_text = str(run_result.get("result", "") or "").lower()
    # "captcha" in a sentence is not enough — look for specific indicators
    captcha_indicators = [
        "hcaptcha", "h-captcha", "newassets.hcaptcha.com",
        "captcha challenge", "solve the captcha",
        "i see a captcha", "captcha widget",
        "are you human", "verify you are human",
    ]
    for indicator in captcha_indicators:
        if indicator in result_text:
            return True

    # Check events for captcha-related types
    run_id = run_result.get("id", "")
    if run_id:
        try:
            events = client.get_run_events(run_id, limit=100)
            for e in events:
                ed = e.get("data", {})
                event_str = json.dumps(ed).lower()
                for indicator in captcha_indicators:
                    if indicator in event_str:
                        return True
        except Exception:
            pass

    return False


# ---------------------------------------------------------------------------
# Core reauth flow
# ---------------------------------------------------------------------------
def run_reauth(provider: str, email: str, gog_account: str,
               client: BrowserUseClient, dry_run: bool = False) -> int:
    """Run the full Browser Use Cloud OAuth reauth flow.

    Returns exit code: 0=success, 1=failure, 2=captcha.
    """
    meta = PROVIDERS[provider]
    port = meta["callback_port"]
    log_path = Path("/tmp/bu_reauth_hub.log")
    log_path.unlink(missing_ok=True)

    # --- Step 1: Acquire serialization lease ---
    if not acquire_lease(provider):
        log("Could not acquire lease — another login may be in progress")
        return EXIT_FAILURE

    try:
        return _run_reauth_inner(provider, email, gog_account, client,
                                 dry_run, log_path)
    finally:
        release_lease()


def _run_reauth_inner(provider: str, email: str, gog_account: str,
                      client: BrowserUseClient, dry_run: bool,
                      log_path: Path) -> int:
    """Inner reauth flow — assumes lease is already held."""
    meta = PROVIDERS[provider]
    port = meta["callback_port"]
    safe = safe_email(email)

    # --- Dry run ---
    if dry_run:
        log(f"[DRY RUN] Provider={provider} Email={safe} Port={port}")
        log(f"[DRY RUN] Would start: {HUB_BIN} -config {HUB_CONFIG} "
            f"{meta['login_flag']} -no-browser -oauth-callback-port {port}")
        log(f"[DRY RUN] Auth file target: {meta['auth_file_prefix']}-{email}.json")
        log("[DRY RUN] Validating Browser Use API access...")
        try:
            browsers = client.list_browsers()
            log(f"[DRY RUN] Browser Use API: OK ({len(browsers)} active sessions)")
        except Exception as e:
            log(f"[DRY RUN] Browser Use API error: {e}")
            return EXIT_FAILURE
        log("[DRY RUN] Dry run complete — no browser sessions started")
        return EXIT_SUCCESS

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

        # --- Step 4: Agent — navigate + enter email ---
        log(f"[3] Agent: navigating to OAuth URL and entering email for {safe}")
        task1 = (
            f"Go to {oauth_url}. "
            f"Enter {email} in the email field. "
            f"Click Continue. Do NOT use Google sign-in. "
            f"Report exactly what you see after clicking Continue."
        )
        run1 = client.create_run(task1)
        run1_id = run1.get("id", "")
        session_id = run1.get("sessionId", "")
        log(f"[3] Run created: {run1_id[:12]}... session: {session_id[:12]}...")
        result1 = client.wait_for_run(run1_id, timeout=RUN_POLL_TIMEOUT)
        text1 = str(result1.get("result", "") or "")
        log(f"[3] Run 1 complete: {text1[:200]}")

        # Check for captcha on first step
        if detect_captcha(result1, client):
            log("[CAPTCHA] Captcha detected during email entry")
            live_url = client.get_live_view_url(run1_id)
            if live_url:
                log(f"[CAPTCHA] Live view URL: {sanitize_url(live_url)}")
            return EXIT_CAPTCHA

        # --- Step 5: Handle verification code or magic link ---
        needs_code = any(kw in text1.lower() for kw in
                         ["code", "link sent", "verify", "check your email",
                          "magic", "email has been sent"])
        if not needs_code:
            log("[4] No verification code/magic link needed — proceeding to Authorize")
        else:
            log(f"[4] Verification needed — polling Gmail for {safe}")
            time.sleep(5)  # Give Gmail time to receive the email

            # Try code first, then magic link
            code = poll_gmail_for_code(provider, email, gog_account, kind="code")
            if code:
                log("[4] Verification code received (value redacted)")
                task2 = (
                    f"Enter the verification code in the verification field. "
                    f"Click Continue. Report what you see."
                )
                run2 = client.create_run(task2, session_id=session_id)
                run2_id = run2.get("id", "")
                log(f"[4] Code entry run: {run2_id[:12]}...")
                result2 = client.wait_for_run(run2_id, timeout=RUN_POLL_TIMEOUT)
                text2 = str(result2.get("result", "") or "")
                log(f"[4] Code entry complete: {text2[:200]}")
                session_id = run2.get("sessionId", session_id)

                # Check for captcha after code entry
                if detect_captcha(result2, client):
                    log("[CAPTCHA] Captcha detected after code entry")
                    live_url = client.get_live_view_url(run2_id)
                    if live_url:
                        log(f"[CAPTCHA] Live view URL: {sanitize_url(live_url)}")
                    return EXIT_CAPTCHA

                # Check if we need a magic link (selectAccount flow)
                if any(kw in text2.lower() for kw in
                       ["link sent", "magic", "selectaccount", "click the link"]):
                    log("[5] Magic link flow detected — polling Gmail")
                    time.sleep(5)
                    magic = poll_gmail_for_code(provider, email, gog_account,
                                                kind="magic")
                    if magic:
                        log("[5] Magic link received (value redacted)")
                        task3 = (
                            f"Navigate to the magic link URL. "
                            f"If you see an Authorize button, click it. "
                            f"Report what you see."
                        )
                        run3 = client.create_run(task3, session_id=session_id)
                        run3_id = run3.get("id", "")
                        log(f"[5] Magic link run: {run3_id[:12]}...")
                        result3 = client.wait_for_run(run3_id, timeout=RUN_POLL_TIMEOUT)
                        text3 = str(result3.get("result", "") or "")
                        log(f"[5] Magic link run complete: {text3[:200]}")
                        session_id = run3.get("sessionId", session_id)
                    else:
                        log("[5] No magic link found — cannot continue")
                        return EXIT_FAILURE
            else:
                log("[4] No verification code — trying magic link...")
                magic = poll_gmail_for_code(provider, email, gog_account,
                                            kind="magic")
                if magic:
                    log("[4] Magic link received (value redacted)")
                    task2 = (
                        f"Navigate to the magic link URL. "
                        f"If you see an Authorize button, click it. "
                        f"Report what you see."
                    )
                    run2 = client.create_run(task2, session_id=session_id)
                    run2_id = run2.get("id", "")
                    log(f"[4] Magic link run: {run2_id[:12]}...")
                    result2 = client.wait_for_run(run2_id, timeout=RUN_POLL_TIMEOUT)
                    text2 = str(result2.get("result", "") or "")
                    log(f"[4] Magic link run complete: {text2[:200]}")
                    session_id = run2.get("sessionId", session_id)
                else:
                    log("[FAIL] No verification code or magic link received")
                    return EXIT_FAILURE

        # --- Step 6: Click Authorize with JS interception ---
        intercept_js = INTERCEPT_JS_TEMPLATE.format(port=port)
        log(f"[6] Injecting JS callback interception (port {port}) and clicking Authorize")
        task_auth = (
            f"Run this JavaScript in the browser console: {intercept_js} "
            f"Then if you see an Authorize or Allow button, click it. "
            f"Wait 3 seconds. "
            f"Then run window.__CB__ in the console and report its value. "
            f"If null, report the current URL."
        )
        run_auth = client.create_run(task_auth, session_id=session_id)
        run_auth_id = run_auth.get("id", "")
        log(f"[6] Authorize run: {run_auth_id[:12]}...")
        result_auth = client.wait_for_run(run_auth_id, timeout=RUN_POLL_TIMEOUT)
        text_auth = str(result_auth.get("result", "") or "")
        log(f"[6] Authorize run complete: {text_auth[:200]}")

        # Check for captcha during authorize
        if detect_captcha(result_auth, client):
            log("[CAPTCHA] Captcha detected during Authorize")
            live_url = client.get_live_view_url(run_auth_id)
            if live_url:
                log(f"[CAPTCHA] Live view URL: {sanitize_url(live_url)}")
            return EXIT_CAPTCHA

        # --- Step 7: Extract callback URL ---
        log("[7] Searching for callback URL...")
        callback_url = extract_callback_url(result_auth, client, provider)

        if not callback_url:
            # Try asking the agent directly for window.__CB__
            log("[7] Callback not found in results — asking agent for window.__CB__")
            task_cb = (
                "Run window.__CB__ in the browser console and report the exact value. "
                "If null, report the current page URL."
            )
            run_cb = client.create_run(task_cb, session_id=session_id)
            run_cb_id = run_cb.get("id", "")
            log(f"[7] Callback query run: {run_cb_id[:12]}...")
            result_cb = client.wait_for_run(run_cb_id, timeout=60)
            text_cb = str(result_cb.get("result", "") or "")
            log(f"[7] Callback query result: {text_cb[:200]}")

            # Search the callback query result
            callback_url = extract_callback_url(result_cb, client, provider)

        if not callback_url:
            log("[FAIL] Could not extract callback URL from any run")
            return EXIT_FAILURE

        log(f"[7] Callback URL extracted: {sanitize_url(callback_url)}")

        # --- Step 8: Paste callback URL into cli-proxy-api PTY ---
        log("[8] Pasting callback URL into cli-proxy-api PTY...")
        if not paste_callback_url(proc, callback_url):
            log("[FAIL] Could not paste callback URL into PTY")
            return EXIT_FAILURE

        # Wait for cli-proxy-api to process the callback and write auth file
        log(f"[8] Waiting {AUTH_FILE_WAIT}s for auth file to appear...")
        time.sleep(AUTH_FILE_WAIT)

        # --- Step 9: Check for auth file ---
        auth_file = AUTH_DIR / f"{meta['auth_file_prefix']}-{email}.json"
        if auth_file.exists():
            log(f"[OK] Auth file created: {auth_file.name}")
            return EXIT_SUCCESS
        else:
            log(f"[FAIL] Auth file not found at expected path: {auth_file.name}")
            return EXIT_FAILURE

    except Exception as e:
        log(f"[ERROR] Unexpected error: {e}")
        return EXIT_FAILURE
    finally:
        # Always stop all browser sessions
        log("[CLEANUP] Stopping all browser sessions...")
        client.stop_all_browsers()
        # Always clean up the login process
        cleanup_login_process(proc)


# ---------------------------------------------------------------------------
# Signal handling for overall timeout
# ---------------------------------------------------------------------------
def _timeout_handler(signum, frame):
    raise TimeoutError(f"Script exceeded {TOTAL_TIMEOUT}s total timeout")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global _log_file

    parser = argparse.ArgumentParser(
        description="Browser Use Cloud OAuth reauth for CRSProxy"
    )
    parser.add_argument("-provider", required=True,
                        choices=list(PROVIDERS.keys()),
                        help="OAuth provider (claude, xai, codex)")
    parser.add_argument("-email", required=True,
                        help="Account email address")
    parser.add_argument("-gog-account", default="",
                        help="Gogcli account for Gmail polling")
    parser.add_argument("-dry-run", action="store_true",
                        help="Validate setup without running browser flows")
    parser.add_argument("-log-file", default="",
                        help="Log file path (default: /tmp/bu_reauth.log)")
    args = parser.parse_args()

    # Set up log file
    log_path = args.log_file or str(LOG_DIR / "bu_reauth.log")
    _log_file = open(log_path, "a", encoding="utf-8")

    # Set overall timeout
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TOTAL_TIMEOUT)

    # Load API key from environment
    api_key = os.environ.get("BROWSER_USE_API_KEY", "")
    if not api_key:
        # Try loading from .env
        env_path = Path("/opt/crsproxy/.env")
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("BROWSER_USE_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if not api_key:
        log("[FATAL] BROWSER_USE_API_KEY not found in environment or .env")
        return EXIT_FAILURE

    if args.dry_run:
        log(f"=== DRY RUN: {args.provider} / {safe_email(args.email)} ===")
    else:
        log(f"=== Reauth: {args.provider} / {safe_email(args.email)} ===")

    client = BrowserUseClient(api_key)

    # Register cleanup to stop all browsers on any exit
    atexit.register(client.stop_all_browsers)

    try:
        exit_code = run_reauth(
            provider=args.provider,
            email=args.email,
            gog_account=args.gog_account,
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
        signal.alarm(0)  # Cancel the alarm
        # Ensure all browser sessions are stopped
        client.stop_all_browsers()

    log(f"=== Exit code: {exit_code} ===")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
