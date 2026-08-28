#!/usr/bin/env python3
"""Browser Use Cloud Agent — OAuth re-auth for cliproxy / CLIProxyAPI.

Production-grade reauth script that uses Browser Use Cloud to automate
OAuth flows for Claude, xAI, and Codex providers on the cliproxy hub.

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
  - Isolated candidate validation before atomic activation.
  - Stale auth preservation when candidate fails validation.
  - Human hCaptcha checkpoint: detects captcha, emits live_view_url,
    keeps browser session alive, waits for a file-based trigger, then
    resumes with a follow-up run in the same session to click Authorize
    and capture the callback URL.
  - Serialization lease: checks the cliproxy OAuth lease file before starting
    a login, waits if held, cleans up after completion.
  - Email cooldown: tracks verification code send timestamps, enforces
    a 5-minute cooldown if >3 codes are sent in 5 minutes, logs
    cooldown events without exposing the email address or code values.

Usage:
  # Full reauth for a Claude account
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -gog-account user@example.com

  # Dry run (validates setup, no browser runs)
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -dry-run

  # xAI reauth
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider xai -email user2@example.com -gog-account user2@example.com

  # Codex reauth
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider codex -email user2@example.com -gog-account user2@example.com

  # Validate an existing auth file (no reauth, no browser)
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -validate-only

  # Validate and activate if valid
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -validate-only -activate

  # Validate metadata only (skip canary request)
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -validate-only -skip-canary

  # Resume from a hCaptcha checkpoint (after Sam solved the captcha)
  sudo -u crsproxy /opt/crsproxy/venv/bin/python /opt/crsproxy/bu_reauth.py \\
      -provider claude -email user@example.com -checkpoint-resume

  # When hCaptcha is detected, the script emits the live_view_url and waits.
  # After solving the captcha in the browser, create the trigger file:
  #   sudo -u crsproxy touch /opt/crsproxy/state/bu_reauth_checkpoint_trigger
  # The script will then create a follow-up run and complete the flow.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bu_2fa import TwoFactorError, current_totp_from_config

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------
# Runtime compatibility: the deployed hub may still store cliproxy files under
# this legacy path while service paths are migrated. Keep these constants until
# the host is moved; do not present the old path name as the product name.
HUB_BIN = "/opt/crsproxy/cli-proxy-api"
HUB_CONFIG = "/opt/crsproxy/config.yaml"
AUTH_DIR = Path("/opt/crsproxy/auths")
HOME_DIR = Path("/opt/crsproxy")
BU_API_BASE = "https://api.browser-use.com/api/v4"
BU_MODEL = "gpt-5.6-luna"
LOG_DIR = Path("/tmp")
STATE_DIR = Path("/opt/crsproxy/state")
LEASE_FILE = STATE_DIR / "cliproxy-claude-oauth-lease.json"
LEGACY_LEASE_FILE = STATE_DIR / "crsproxy-claude-oauth-lease.json"
CANARY_URL = "http://localhost:8319/v1/chat/completions"

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

# Human checkpoint (hCaptcha) configuration
CHECKPOINT_FILE = STATE_DIR / "bu_reauth_checkpoint.json"
CHECKPOINT_TRIGGER = STATE_DIR / "bu_reauth_checkpoint_trigger"
CHECKPOINT_POLL_INTERVAL = 5   # seconds between trigger polls
CHECKPOINT_TIMEOUT = 600       # 10 minutes for human to solve captcha

# Email cooldown configuration
EMAIL_COOLDOWN_FILE = STATE_DIR / "cliproxy-email-cooldown.json"
LEGACY_EMAIL_COOLDOWN_FILE = STATE_DIR / "crsproxy-email-cooldown.json"
EMAIL_COOLDOWN_WINDOW = 300      # 5 min sliding window for counting code sends
EMAIL_COOLDOWN_THRESHOLD = 3     # max 3 code sends before cooldown triggers
EMAIL_COOLDOWN_DURATION = 300    # 5 min cooldown when threshold exceeded

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
        "canary_model": "claude-sonnet-5",
    },
    "xai": {
        "login_flag": "-xai-login",
        "callback_port": 51121,
        "callback_url_re": r"http://localhost:51121/[^\s\"']*callback\?[^\s\"']+",
        "auth_url_re": r"https://accounts\.x\.ai/oauth/authorize\?[^\s]+",
        "auth_file_prefix": "xai",
        "email_sender": "noreply@x.ai",
        "domain": "accounts.x.ai",
        "canary_model": "grok-4.5",
    },
    "codex": {
        "login_flag": "-codex-login",
        "callback_port": 1455,
        "callback_url_re": r"http://localhost:1455/auth/callback\?[^\s\"']+",
        "auth_url_re": r"https://auth\.openai\.com/oauth/authorize\?[^\s]+",
        "auth_file_prefix": "codex",
        "email_sender": "noreply@openai.com",
        "domain": "auth.openai.com",
        "canary_model": "o4-mini",
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


def _requests_module():
    """Import requests lazily so local logic tests can run without hub deps."""
    try:
        import requests
        return requests
    except ImportError as exc:
        raise RuntimeError("Python requests package is required for Browser Use API calls") from exc


# ---------------------------------------------------------------------------
# Canary request (proxy health check)
# ---------------------------------------------------------------------------
def send_canary(model: str, timeout: int = 30) -> int:
    """Send a canary request through the cli-proxy-api proxy.

    Returns the HTTP status code, or -1 on connection error.
    A 200 means the proxy is serving the model.  429 means rate-limited
    (proxy is alive).  503 means no auth available (proxy is alive but
    has no enabled accounts — the candidate might fix this).
    """
    try:
        requests = _requests_module()
        r = requests.post(
            CANARY_URL,
            headers={"Authorization": "Bearer test"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1,
            },
            timeout=timeout,
        )
        return r.status_code
    except Exception as e:
        log(f"Canary request error: {e}")
        return -1


# ---------------------------------------------------------------------------
# Isolated candidate validation
# ---------------------------------------------------------------------------
def validate_candidate(auth_path: Path, expected_email: str,
                       expected_type: str, canary_model: str = "",
                       skip_canary: bool = False) -> tuple[bool, str]:
    """Validate a candidate auth file before activation.

    Performs four checks:
      1. auth['email'] matches the target email.
      2. auth['type'] matches the expected provider type.
      3. auth['expired'] is more than 24 hours from now.
      4. A canary request for the account's model succeeds (proxy health).

    This function is independently callable — it does not modify the auth
    file or any other state.  It only reads the candidate and sends a
    canary request through the proxy.

    Args:
        auth_path:      Path to the candidate auth file.
        expected_email:  The target account email.
        expected_type:   The expected provider type (claude/xai/codex).
        canary_model:    Model name for the canary request (empty to skip).
        skip_canary:     If True, skip the canary request (metadata-only mode).

    Returns:
        (True,  "all checks passed")  if every check passes.
        (False, "rejection reason")   if any check fails.
    """
    # --- Read the candidate auth file ---
    try:
        auth = json.loads(auth_path.read_text())
    except Exception as e:
        return False, f"cannot read auth file: {e}"

    # --- Check 1: Email matches target ---
    actual_email = auth.get("email", "")
    if actual_email != expected_email:
        return False, (f"email mismatch: expected {safe_email(expected_email)}, "
                       f"got {safe_email(actual_email)}")

    # --- Check 2: Provider type matches expected ---
    actual_type = auth.get("type", "")
    if actual_type != expected_type:
        return False, f"type mismatch: expected {expected_type}, got {actual_type}"

    # --- Check 3: Expiry is >24h from now ---
    expired_str = auth.get("expired", "")
    if not expired_str:
        return False, "no 'expired' field in auth file"
    try:
        # Handle ISO 8601 with optional Z suffix
        expired_dt = datetime.fromisoformat(
            expired_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        if expired_dt <= now + timedelta(hours=24):
            return False, f"token expires within 24h: {expired_str}"
    except Exception as e:
        return False, f"cannot parse expiry '{expired_str}': {e}"

    # --- Check 4: Canary request (proxy health) ---
    if canary_model and not skip_canary:
        status = send_canary(canary_model)
        # The canary is a proxy health check, not a per-account token test.
        # The token freshness is validated by the expiry check (check 3).
        # Any HTTP response means the proxy is alive and processing
        # requests.  Only a connection error (-1) means the proxy is down.
        # 200 = serving, 429 = rate-limited, 503 = no auth available,
        # 401/403 = accounts in cooldown/auth issues — all indicate the
        # proxy is alive.  -1 = connection error — proxy is down.
        if status < 0:
            return False, f"canary request failed: proxy unreachable (connection error)"

    return True, "all checks passed"


# ---------------------------------------------------------------------------
# Atomic activation
# ---------------------------------------------------------------------------
def activate_auth_file(auth_path: Path) -> bool:
    """Atomically activate an auth file by setting disabled=false.

    Uses a temp file + os.rename for atomicity.  The auth directory
    hot-reloads, so no service restart is needed.

    Returns True on success, False on failure.
    """
    try:
        auth = json.loads(auth_path.read_text())
        auth["disabled"] = False
        tmp_path = auth_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(auth, indent=2))
        os.rename(str(tmp_path), str(auth_path))
        log(f"Auth file activated: {auth_path.name}")
        return True
    except Exception as e:
        log(f"Activation error for {auth_path.name}: {e}")
        return False


def disable_auth_file(auth_path: Path) -> bool:
    """Atomically disable an auth file by setting disabled=true.

    Uses a temp file + os.rename for atomicity.
    Returns True on success, False on failure.
    """
    try:
        auth = json.loads(auth_path.read_text())
        auth["disabled"] = True
        tmp_path = auth_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(auth, indent=2))
        os.rename(str(tmp_path), str(auth_path))
        log(f"Auth file disabled: {auth_path.name}")
        return True
    except Exception as e:
        log(f"Disable error for {auth_path.name}: {e}")
        return False


# ---------------------------------------------------------------------------
# Serialization lease
# ---------------------------------------------------------------------------
def _read_lease(path):
    """Return the lease dict, or None when no usable lease is present.

    Raises nothing: an unreadable or corrupt lease is reported as None.

    `Path.exists()` raises PermissionError when the parent directory is not
    searchable by the calling user (running as anyone but the service account,
    or on a box where the state dir is root-owned). That escaped acquire_lease's
    own OSError handling because it fired on the probe itself, not the read,
    and crashed the reauth run instead of degrading.
    """
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError):
        return None


def _try_create_lease(path, provider: str) -> bool:
    """Atomically create the lease file. False when it already exists.

    O_CREAT|O_EXCL is the actual mutual-exclusion primitive: an exists() probe
    followed by a write is two syscalls with a window between them, so two
    processes can both see "no lease" and both write. Creating exclusively
    makes the check and the claim one operation.
    """
    payload = json.dumps({
        "provider": provider,
        "timestamp": time.time(),
        "pid": os.getpid(),
    })
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # Non-fatal on purpose: the directory may already exist but be
        # unwritable by this user, or be owned by the service account. The
        # exclusive create below is the real gate — let it produce the
        # authoritative error rather than failing here on a probe.
        log(f"Lease dir not creatable ({exc}) — continuing to claim attempt")
    # Build the lease in a private temp file FIRST, then link it into place.
    # O_CREAT|O_EXCL alone is atomic for the *create* but leaves a window in
    # which the file exists and is still empty: a racer reading it in that
    # window sees invalid JSON, classifies the lease as corrupt, removes it,
    # and claims it too. os.link() is atomic AND the destination already has
    # its full contents the instant it appears, so the window does not exist.
    # (Measured: the create-then-write shape let 2 of 8 racers win.)
    tmp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        # 0o600: the lease records a provider name and pid and is only ever
        # read by the service account that writes it. No reason for group or
        # world read.
        fd = os.open(str(tmp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError as exc:
        log(f"Lease temp file not creatable ({exc}) — cannot claim")
        return False
    try:
        os.write(fd, payload.encode())
    finally:
        os.close(fd)

    try:
        os.link(str(tmp), str(path))
        return True
    except FileExistsError:
        return False
    except OSError as exc:
        log(f"Lease link failed ({exc}) — treating as not acquired")
        return False
    finally:
        try:
            os.unlink(str(tmp))
        except OSError:
            # The temp file is ours alone and already served its purpose; a
            # failure to remove it leaks one small file and must never turn a
            # successful claim into a failure.
            pass


def acquire_lease(provider: str, max_wait: int = 120) -> bool:
    """Acquire the serialization lease, waiting up to max_wait seconds.

    The claim itself is an atomic exclusive create. If the lease file already
    exists and is recent (younger than LEASE_STALE_SECONDS), polls every 5
    seconds until it is released or max_wait is reached. A stale or corrupt
    lease is removed and the claim retried. Returns True if the lease was
    acquired, False on timeout.
    """
    t0 = time.time()
    first_check = True
    while True:
        if _try_create_lease(LEASE_FILE, provider):
            log(f"Lease acquired for {provider}")
            return True

        # Someone holds it (or a legacy-named lease is in the way).
        data = _read_lease(LEASE_FILE)
        lease_path = LEASE_FILE
        if data is None:
            legacy = _read_lease(LEGACY_LEASE_FILE)
            if legacy is not None:
                data, lease_path = legacy, LEGACY_LEASE_FILE

        if data is None:
            # Unreadable or corrupt on both names. Remove and retry the claim;
            # never fall through to an unconditional overwrite.
            try:
                lease_path.unlink()
            except OSError:
                if time.time() - t0 >= max_wait:
                    log("Lease unreadable and not removable — giving up")
                    return False
                time.sleep(5)
            continue

        age = time.time() - data.get("timestamp", 0)
        if age >= LEASE_STALE_SECONDS:
            log(f"Stale lease ({int(age)}s old) — removing")
            try:
                lease_path.unlink()
            except OSError as exc:
                # Another process may have cleared the same stale lease first,
                # which is the desired outcome, not an error. Loop back and let
                # the exclusive create decide who actually holds it.
                log(f"Stale lease already gone or not removable ({exc}) — retrying claim")
            continue

        if first_check:
            log(f"Lease held by {data.get('provider','?')} "
                f"({int(age)}s old) — waiting up to {max_wait}s")
            first_check = False
        if time.time() - t0 >= max_wait:
            log(f"Lease wait timed out after {max_wait}s — "
                f"another login may still be in progress")
            return False
        time.sleep(5)


def release_lease():
    """Remove the serialization lease file."""
    try:
        LEASE_FILE.unlink(missing_ok=True)
        log("Lease released")
    except Exception as e:
        log(f"Lease release error: {e}")


# ---------------------------------------------------------------------------
# Email cooldown tracking
# ---------------------------------------------------------------------------
def _load_cooldown_state() -> dict:
    """Load email cooldown state from the current or legacy file."""
    for path in (EMAIL_COOLDOWN_FILE, LEGACY_EMAIL_COOLDOWN_FILE):
        try:
            if path.exists():
                return json.loads(path.read_text())
        except Exception:
            pass
    return {"send_timestamps": [], "cooldown_until": 0}


def _save_cooldown_state(state: dict):
    """Save email cooldown state to file."""
    try:
        EMAIL_COOLDOWN_FILE.write_text(json.dumps(state))
    except Exception as e:
        log(f"Cooldown state save error: {e}")


def record_email_send():
    """Record a verification code send timestamp.

    Called when a new verification code is found in Gmail.  Prunes
    timestamps older than the cooldown window.  Never logs the email
    address or code value.
    """
    state = _load_cooldown_state()
    now = time.time()
    state["send_timestamps"] = [
        ts for ts in state.get("send_timestamps", [])
        if now - ts < EMAIL_COOLDOWN_WINDOW
    ]
    state["send_timestamps"].append(now)
    _save_cooldown_state(state)
    count = len(state["send_timestamps"])
    log(f"Email send recorded (count in window: {count})")


def check_email_cooldown() -> tuple[bool, int]:
    """Check if we're in an email cooldown period.

    Returns (is_in_cooldown, seconds_remaining).
    """
    state = _load_cooldown_state()
    now = time.time()
    cooldown_until = state.get("cooldown_until", 0)
    if cooldown_until > now:
        return True, int(cooldown_until - now)
    return False, 0


def enforce_email_cooldown() -> bool:
    """Check and enforce email cooldown after a code entry failure.

    If more than EMAIL_COOLDOWN_THRESHOLD codes have been sent in the
    last EMAIL_COOLDOWN_WINDOW seconds, sets a cooldown of
    EMAIL_COOLDOWN_DURATION and blocks until it expires.

    Returns True if a cooldown was enforced (waited), False if no
    cooldown was needed.  Logs cooldown events without exposing the
    email address or code values.
    """
    state = _load_cooldown_state()
    now = time.time()

    # Prune old timestamps
    state["send_timestamps"] = [
        ts for ts in state.get("send_timestamps", [])
        if now - ts < EMAIL_COOLDOWN_WINDOW
    ]

    # Check if we're already in a cooldown
    cooldown_until = state.get("cooldown_until", 0)
    if cooldown_until > now:
        remaining = int(cooldown_until - now)
        log(f"Email cooldown active — {remaining}s remaining "
            f"(threshold: {EMAIL_COOLDOWN_THRESHOLD} sends per "
            f"{EMAIL_COOLDOWN_WINDOW}s)")
        log("Waiting for cooldown to expire before retrying...")
        time.sleep(remaining + 1)
        log("Email cooldown expired — proceeding with retry")
        state["cooldown_until"] = 0
        _save_cooldown_state(state)
        return True

    # Check if threshold is exceeded
    count = len(state["send_timestamps"])
    if count > EMAIL_COOLDOWN_THRESHOLD:
        state["cooldown_until"] = now + EMAIL_COOLDOWN_DURATION
        _save_cooldown_state(state)
        log(f"Email cooldown triggered: {count} sends in "
            f"{EMAIL_COOLDOWN_WINDOW}s window — waiting "
            f"{EMAIL_COOLDOWN_DURATION}s")
        log("Cooldown event logged (email and code values redacted)")
        time.sleep(EMAIL_COOLDOWN_DURATION)
        log("Email cooldown expired — proceeding with retry")
        state["cooldown_until"] = 0
        _save_cooldown_state(state)
        return True

    log(f"No cooldown needed ({count} sends in window)")
    return False


def clear_email_cooldown():
    """Clear email cooldown state.  Called on successful completion."""
    try:
        EMAIL_COOLDOWN_FILE.unlink(missing_ok=True)
        log("Email cooldown state cleared")
    except Exception as e:
        log(f"Email cooldown clear error: {e}")


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
        self.keep_browser_alive = False  # set True during human checkpoint

    def _request(self, method: str, path: str, **kwargs):
        """Make an HTTP request with a guaranteed timeout."""
        kwargs.setdefault("timeout", API_TIMEOUT)
        url = f"{self.base}{path}"
        requests = _requests_module()
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
        if self.keep_browser_alive:
            log(f"Browser session kept alive (checkpoint): {browser_id[:12]}...")
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
        """List all browser sessions from the Browser Use API.

        The API returns a paginated response dict:
            {"items": [...], "totalItems": N, "pageNumber": 1, "pageSize": 20}
        This method normalizes that to the items list so callers can
        iterate browser session dicts directly.
        """
        try:
            r = self._request("GET", "/browsers")
            if not r.content:
                return []
            data = r.json()
            # Normalize paginated response dict to its items array
            if isinstance(data, dict) and "items" in data:
                return data["items"]
            # Already a plain list
            if isinstance(data, list):
                return data
            # Unknown shape — return empty rather than iterating dict keys
            log(f"list_browsers: unexpected response shape: {type(data).__name__}")
            return []
        except Exception:
            return []

    def stop_all_browsers(self):
        """Stop all tracked browser sessions.

        Stops sessions tracked via _browser_sessions (from run events)
        and also queries the API for any running sessions we might
        have missed.  Skips sessions that are already stopped to avoid
        unnecessary API calls.
        """
        if self.keep_browser_alive:
            log("[CLEANUP] Browser sessions kept alive for checkpoint")
            return
        for bid in list(self._browser_sessions):
            self.stop_browser(bid)
        # Also check for any running sessions we might have missed
        try:
            browsers = self.list_browsers()
            for b in browsers:
                if not isinstance(b, dict):
                    continue
                bid = b.get("id", "")
                if not bid:
                    continue
                # Skip already-stopped sessions to avoid unnecessary API calls
                status = b.get("status", "")
                if status in ("stopped", "closed", "finished"):
                    continue
                self.stop_browser(bid)
        except Exception as e:
            log(f"stop_all_browsers: error listing/stopping browsers: {e}")

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


def _code_entry_failed(result_text: str) -> bool:
    """Check if a verification code entry run failed.

    Looks for indicators that the code was rejected, expired, or
    could not be entered.  Never logs the code value itself.
    """
    text_lower = result_text.lower()
    failure_indicators = [
        "invalid code", "code is invalid", "expired",
        "incorrect", "wrong code", "code is not valid",
        "didn't work", "please try again", "try again",
        "code is wrong", "enter the code again",
        "unable to verify", "verification failed",
        "code didn't match", "that code isn't",
        "error verifying", "there was an error",
        "error verifying your code",
    ]
    return any(ind in text_lower for ind in failure_indicators)


def needs_two_factor(result_text: str) -> bool:
    """Return True when the page appears to be asking for a 2FA/OTP code."""
    text = result_text.lower()
    indicators = [
        "two-factor", "two factor", "2fa", "multi-factor", "mfa",
        "authenticator", "authentication code",
        "one-time password", "one time password",
        "enter a code from your authenticator",
    ]
    return any(indicator in text for indicator in indicators)


def _human_2fa_message(method: str) -> str:
    """Return safe Browser Use instructions for a human-driven 2FA method."""
    if method == "sms_checkpoint":
        return "Ask the operator for the SMS code, enter it, and click Continue."
    if method == "push_checkpoint":
        return "Ask the operator to approve the push prompt, then click Continue."
    if method == "passkey_checkpoint":
        return "Ask the operator to complete the passkey/WebAuthn prompt."
    return "Ask the operator to complete the 2FA checkpoint."


def handle_two_factor_prompt(client: BrowserUseClient, session_id: str,
                             result_text: str, two_factor: dict | None) -> bool:
    """Handle a 2FA prompt without exposing long-lived secrets to Browser Use."""
    if not needs_two_factor(result_text):
        return True

    config = two_factor or {}
    method = str(config.get("method") or "none").strip().lower()
    if method in ("", "none", "false"):
        log("[2FA] Prompt detected but no 2FA method is configured")
        return False

    if method == "onepassword_totp":
        try:
            code = current_totp_from_config(config)
        except TwoFactorError as exc:
            log(f"[2FA] Could not get 1Password TOTP: {exc}")
            return False
        if not code:
            log("[2FA] 1Password TOTP config returned no code")
            return False
        log("[2FA] 1Password TOTP generated (value redacted)")
        task = (
            f"Enter this one-time authentication code: {code}. "
            "Click Continue. Report exactly what you see."
        )
    else:
        log(f"[2FA] Human checkpoint required: {method}")
        task = _human_2fa_message(method) + " Report exactly what you see."

    run = client.create_run(task, session_id=session_id)
    run_id = run.get("id", "")
    log(f"[2FA] Checkpoint run: {run_id[:12]}...")
    result = client.wait_for_run(run_id, timeout=RUN_POLL_TIMEOUT)
    text = str(result.get("result", "") or "")
    log(f"[2FA] Checkpoint complete: {text[:200]}")
    if detect_captcha(result, client):
        log("[2FA] Captcha appeared during 2FA checkpoint")
        return False
    if _code_entry_failed(text):
        log("[2FA] 2FA code was rejected")
        return False
    return True


def detect_captcha(run_result: dict, client: BrowserUseClient) -> bool:
    """Check if the run result or events indicate a real captcha challenge."""
    result_raw = str(run_result.get("result", "") or "")
    result_text = result_raw.lower()
    # Browser Use tasks report exact 'CAPTCHA' (uppercase) as a sentinel
    # when they encounter a real captcha challenge. Use EXACT whole-result
    # matching (after stripping whitespace) so that phrases like
    # "No CAPTCHA needed" do NOT trigger a false positive. A word-boundary
    # regex would still match "CAPTCHA" inside "No CAPTCHA needed".
    if result_raw.strip() == "CAPTCHA":
        return True
    # "captcha" in a sentence is not enough — look for specific indicators
    captcha_indicators = [
        # These indicators are checked ONLY against the agent's result
        # text (the agent's description of what it sees), NOT against
        # raw HTML events.  The events-based check was removed because
        # the invisible hCaptcha widget (hcaptcha-invisible) is present
        # in page HTML even when no visible challenge exists.
        "hcaptcha", "h-captcha", "newassets.hcaptcha.com",
        "captcha challenge", "solve the captcha",
        "i see a captcha", "captcha widget",
        "are you human", "verify you are human",
        "image-selection",
    ]
    for indicator in captcha_indicators:
        if indicator in result_text:
            return True

    # NOTE: We do NOT check raw HTML events for captcha indicators.
    # The hCaptcha widget (including invisible mode) embeds iframe URLs
    # and attributes containing "newassets.hcaptcha.com" etc. in page HTML,
    # which causes false positives on Claude's login page.  The agent's
    # result text is sufficient — if the agent sees a visible captcha
    # challenge, it will report it (e.g., "I see a captcha").

    return False


# ---------------------------------------------------------------------------
# Human captcha checkpoint
# ---------------------------------------------------------------------------
def write_checkpoint(session_id: str, run_id: str, browser_session_id: str,
                     live_view_url: str, provider: str, email: str,
                     callback_port: int):
    """Write checkpoint state to a file for human captcha solving.

    The checkpoint file contains the full live_view_url (needed by Sam to
    access the browser), the session_id (for follow-up runs), and metadata
    about the reauth attempt.  The file is world-readable so the
    orchestrator can read it without sudo.
    """
    data = {
        "session_id": session_id,
        "run_id": run_id,
        "browser_session_id": browser_session_id,
        "live_view_url": live_view_url,
        "provider": provider,
        "email": email,
        "callback_port": callback_port,
        "status": "waiting",
        "timestamp": time.time(),
    }
    try:
        CHECKPOINT_FILE.write_text(json.dumps(data, indent=2))
        os.chmod(str(CHECKPOINT_FILE), 0o600)
        log(f"[CAPTCHA_CHECKPOINT] Checkpoint file: {CHECKPOINT_FILE}")
    except Exception as e:
        log(f"[CAPTCHA_CHECKPOINT] Could not write checkpoint file: {e}")


def wait_for_checkpoint_signal(timeout: int = CHECKPOINT_TIMEOUT) -> bool:
    """Wait for a file-based trigger indicating the captcha is solved.

    Polls for the existence of CHECKPOINT_TRIGGER every CHECKPOINT_POLL_INTERVAL
    seconds.  Returns True if the trigger appears, False on timeout.
    The trigger file can be created by: sudo -u crsproxy touch /opt/crsproxy/state/bu_reauth_checkpoint_trigger
    """
    log(f"[CAPTCHA_CHECKPOINT] Waiting up to {timeout}s for trigger: {CHECKPOINT_TRIGGER}")
    t0 = time.time()
    while time.time() - t0 < timeout:
        if CHECKPOINT_TRIGGER.exists():
            log("[CAPTCHA_CHECKPOINT] Trigger file detected")
            try:
                CHECKPOINT_TRIGGER.unlink()
            except OSError:
                pass
            return True
        time.sleep(CHECKPOINT_POLL_INTERVAL)
    return False


def clear_checkpoint():
    """Clean up checkpoint and trigger files."""
    for f in (CHECKPOINT_FILE, CHECKPOINT_TRIGGER):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass


def handle_captcha_checkpoint(client: BrowserUseClient, run_id: str,
                              session_id: str, provider: str, email: str,
                              port: int) -> tuple[str | None, str]:
    """Handle the human captcha checkpoint flow.

    1. Get live_view_url from the run's browser.ready event.
    2. Emit the URL to stdout (full URL for Sam, sanitized for logs).
    3. Keep the browser session alive (do NOT stop it).
    4. Write a checkpoint file with session state.
    5. Wait for a file-based trigger (sudo -u crsproxy touch /opt/crsproxy/state/bu_reauth_checkpoint_trigger).
    6. After trigger, create a follow-up run in the same session to click
       Authorize with JS interception and capture the callback URL.
    7. Return (callback_url, session_id) or (None, session_id) on failure.

    The browser session is kept alive during the wait so Sam can interact
    with it via the live_view_url.  After the follow-up run completes,
    the browser is released for normal cleanup.
    """
    safe = safe_email(email)

    # --- 1. Get live_view_url from run events ---
    live_url = client.get_live_view_url(run_id)
    if not live_url:
        log("[CAPTCHA_CHECKPOINT] Could not extract live_view_url — aborting checkpoint")
        return None, session_id

    # Get browser_session_id for the checkpoint file
    browser_session_id = ""
    try:
        events = client.get_run_events(run_id, limit=100)
        for e in events:
            if e.get("type") == "browser.ready":
                browser_session_id = e.get("data", {}).get(
                    "browser_session_id", "")
                break
    except Exception:
        pass

    # --- 2. Emit the live_view_url to stdout ---
    # The live_view_url is a browser-use.com URL for Sam to access the
    # browser session.  It is NOT an OAuth URL and does not contain OAuth
    # tokens or callback codes.  Emit the full URL so Sam can open it.
    # Also emit a sanitized version for log monitoring.
    log(f"[CAPTCHA_CHECKPOINT] live_view_url={live_url}")
    log(f"[CAPTCHA_CHECKPOINT] Sanitized: {sanitize_url(live_url)}")
    log(f"[CAPTCHA_CHECKPOINT] Provider: {provider}, Email: {safe}")
    log("[CAPTCHA_CHECKPOINT] Browser session kept alive — do NOT stop")
    log(f"[CAPTCHA_CHECKPOINT] To resume after solving: touch {CHECKPOINT_TRIGGER}")

    # --- 3. Keep the browser session alive ---
    client.keep_browser_alive = True

    # --- 4. Write checkpoint file ---
    write_checkpoint(session_id, run_id, browser_session_id, live_url,
                     provider, email, port)

    # Extend the signal-based timeout to account for the checkpoint wait
    signal.alarm(0)  # Cancel current alarm
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TOTAL_TIMEOUT + CHECKPOINT_TIMEOUT)

    try:
        # --- 5. Wait for file-based trigger ---
        triggered = wait_for_checkpoint_signal(timeout=CHECKPOINT_TIMEOUT)

        if not triggered:
            log("[CAPTCHA_CHECKPOINT] Timeout waiting for human — aborting")
            return None, session_id

        log("[CAPTCHA_CHECKPOINT] Trigger received — creating follow-up run")

        # --- 6. Create follow-up run in the same session ---
        intercept_js = INTERCEPT_JS_TEMPLATE.format(port=port)
        task_resume = (
            f"The captcha has been solved by a human. "
            f"Run this JavaScript in the browser console: {intercept_js} "
            f"Then if you see an Authorize or Allow button, click it. "
            f"Wait 3 seconds. "
            f"Then run window.__CB__ in the console and report its value. "
            f"If null, report the current URL. "
            f"If you see another captcha, report CAPTCHA."
        )
        run_resume = client.create_run(task_resume, session_id=session_id)
        run_resume_id = run_resume.get("id", "")
        session_id = run_resume.get("sessionId", session_id)
        log(f"[CAPTCHA_CHECKPOINT] Follow-up run: {run_resume_id[:12]}...")

        result_resume = client.wait_for_run(run_resume_id,
                                             timeout=RUN_POLL_TIMEOUT)
        text_resume = str(result_resume.get("result", "") or "")
        log(f"[CAPTCHA_CHECKPOINT] Follow-up run complete: {text_resume[:200]}")

        # Check for captcha again in the follow-up run
        if detect_captcha(result_resume, client):
            log("[CAPTCHA_CHECKPOINT] Captcha still present after follow-up — aborting")
            return None, session_id

        # Extract callback URL from the follow-up run
        callback_url = extract_callback_url(result_resume, client, provider)

        if not callback_url:
            # Try asking the agent directly for window.__CB__
            log("[CAPTCHA_CHECKPOINT] Callback not found — asking agent for window.__CB__")
            task_cb = (
                "Run window.__CB__ in the browser console and report the "
                "exact value. If null, report the current page URL."
            )
            run_cb = client.create_run(task_cb, session_id=session_id)
            run_cb_id = run_cb.get("id", "")
            log(f"[CAPTCHA_CHECKPOINT] Callback query run: {run_cb_id[:12]}...")
            result_cb = client.wait_for_run(run_cb_id, timeout=60)
            callback_url = extract_callback_url(result_cb, client, provider)

        if callback_url:
            log(f"[CAPTCHA_CHECKPOINT] Callback URL extracted: {sanitize_url(callback_url)}")
        else:
            log("[CAPTCHA_CHECKPOINT] Could not extract callback URL from follow-up run")

        return callback_url, session_id

    finally:
        # Always release the browser for normal cleanup
        client.keep_browser_alive = False
        # Clean up checkpoint files
        clear_checkpoint()
        # Restore a reasonable alarm for the remaining flow
        signal.alarm(TOTAL_TIMEOUT)


# ---------------------------------------------------------------------------
# Core reauth flow
# ---------------------------------------------------------------------------
def _complete_reauth(proc: subprocess.Popen, callback_url: str,
                     auth_file: Path, stale_backup: Path,
                     email: str, provider: str,
                     meta: dict) -> int:
    """Complete the reauth flow after a callback URL is obtained.

    Pastes the callback URL into the cli-proxy-api PTY, waits for the auth
    file to appear, validates the isolated candidate, and atomically
    activates it if valid.

    Returns EXIT_SUCCESS or EXIT_FAILURE.
    """
    # --- Paste callback URL into cli-proxy-api PTY ---
    log("[8] Pasting callback URL into cli-proxy-api PTY...")
    if not paste_callback_url(proc, callback_url):
        log("[FAIL] Could not paste callback URL into PTY")
        return EXIT_FAILURE

    # Wait for cli-proxy-api to process the callback and write auth file
    log(f"[8] Waiting {AUTH_FILE_WAIT}s for auth file to appear...")
    time.sleep(AUTH_FILE_WAIT)

    # --- Validate and activate candidate auth file ---
    if not auth_file.exists():
        log(f"[FAIL] Auth file not found at expected path: {auth_file.name}")
        return EXIT_FAILURE

    log(f"[9] Auth file created: {auth_file.name}")
    log("[9] Validating isolated candidate...")

    valid, reason = validate_candidate(
        auth_path=auth_file,
        expected_email=email,
        expected_type=provider,
        canary_model=meta.get("canary_model", ""),
    )

    if not valid:
        log(f"[FAIL] Candidate validation failed: {reason}")
        log("[9] Preserving stale auth — restoring from backup")
        if stale_backup.exists():
            try:
                os.rename(str(stale_backup), str(auth_file))
                log(f"[9] Stale auth restored: {auth_file.name}")
            except Exception as e:
                log(f"[9] Stale restore error: {e}")
        else:
            log("[9] No stale backup — removing failed candidate")
            try:
                auth_file.unlink()
            except Exception:
                pass
        return EXIT_FAILURE

    log(f"[9] Candidate validation passed: {reason}")
    log("[9] Atomically activating auth file...")
    if not activate_auth_file(auth_file):
        log("[FAIL] Could not activate auth file")
        return EXIT_FAILURE

    # Clean up stale backup on success
    try:
        stale_backup.unlink(missing_ok=True)
    except Exception:
        pass

    # Clear email cooldown state on successful completion
    clear_email_cooldown()

    log(f"[OK] Auth file activated: {auth_file.name}")
    return EXIT_SUCCESS


def run_reauth(provider: str, email: str, gog_account: str,
               client: BrowserUseClient, dry_run: bool = False,
               two_factor: dict | None = None) -> int:
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
                                 dry_run, log_path, two_factor)
    finally:
        release_lease()


def _run_reauth_inner(provider: str, email: str, gog_account: str,
                      client: BrowserUseClient, dry_run: bool,
                      log_path: Path,
                      two_factor: dict | None = None) -> int:
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
            callback_url, session_id = handle_captcha_checkpoint(
                client, run1_id, session_id, provider, email, port)
            if callback_url:
                return _complete_reauth(proc, callback_url, auth_file,
                                        stale_backup, email, provider, meta)
            return EXIT_FAILURE

        if not handle_two_factor_prompt(client, session_id, text1, two_factor):
            return EXIT_FAILURE

        # --- Step 5: Handle verification code or magic link ---
        needs_code = any(kw in text1.lower() for kw in
                         ["code", "link sent", "verify", "check your email",
                          "magic", "email has been sent"])
        if not needs_code:
            log("[4] No verification code/magic link needed — proceeding to Authorize")
        else:
            log(f"[4] Verification needed — polling Gmail for {safe}")
            time.sleep(15)  # Give Gmail time to receive the email

            # Try code first, then magic link
            code = poll_gmail_for_code(provider, email, gog_account, kind="code")
            if code:
                record_email_send()
                log("[4] Verification code received (value redacted)")

                # Code entry with retry and email cooldown enforcement.
                # If the code is rejected, check the email send history.
                # If >3 codes have been sent in 5 minutes, enforce a
                # 5-minute cooldown before retrying with a fresh code.
                max_code_retries = 3
                text2 = ""
                for attempt in range(max_code_retries):
                    task2 = (
                        f"Enter the verification code {code} in the verification field. "
                        f"Click Continue. Report what you see."
                    )
                    run2 = client.create_run(task2, session_id=session_id)
                    run2_id = run2.get("id", "")
                    log(f"[4] Code entry run (attempt {attempt+1}/"
                        f"{max_code_retries}): {run2_id[:12]}...")
                    result2 = client.wait_for_run(run2_id,
                                                 timeout=RUN_POLL_TIMEOUT)
                    text2 = str(result2.get("result", "") or "")
                    log(f"[4] Code entry complete: {text2[:200]}")
                    session_id = run2.get("sessionId", session_id)

                    # Check for captcha after code entry
                    if detect_captcha(result2, client):
                        log("[CAPTCHA] Captcha detected after code entry")
                        callback_url, session_id = handle_captcha_checkpoint(
                            client, run2_id, session_id, provider, email, port)
                        if callback_url:
                            return _complete_reauth(proc, callback_url,
                                                    auth_file, stale_backup,
                                                    email, provider, meta)
                        return EXIT_FAILURE

                    if not handle_two_factor_prompt(client, session_id, text2, two_factor):
                        return EXIT_FAILURE

                    # Check if code entry failed
                    if _code_entry_failed(text2):
                        log(f"[4] Code entry failed on attempt {attempt+1}")
                        if attempt < max_code_retries - 1:
                            # Enforce email cooldown (waits if threshold
                            # exceeded) then poll for a fresh code
                            enforce_email_cooldown()
                            log("[4] Polling for new verification code")
                            code = poll_gmail_for_code(
                                provider, email, gog_account, kind="code")
                            if code:
                                record_email_send()
                                log("[4] New verification code received "
                                    "(value redacted)")
                            else:
                                log("[FAIL] No new verification code received")
                                return EXIT_FAILURE
                        else:
                            log("[FAIL] Code entry failed after all retries — trying magic link")
                            # Fall through to magic link flow instead of exiting
                            text2 = "link sent"  # Trigger magic link check
                    else:
                        break  # Code entry succeeded

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
                            f"Navigate to the magic link URL: {magic}. "
                            f"If you see an Authorize button, click it. "
                            f"Report what you see."
                        )
                        run3 = client.create_run(task3, session_id=session_id)
                        run3_id = run3.get("id", "")
                        log(f"[5] Magic link run: {run3_id[:12]}...")
                        result3 = client.wait_for_run(run3_id,
                                                      timeout=RUN_POLL_TIMEOUT)
                        text3 = str(result3.get("result", "") or "")
                        log(f"[5] Magic link run complete: {text3[:200]}")
                        session_id = run3.get("sessionId", session_id)

                        # Check for captcha after magic link navigation
                        if detect_captcha(result3, client):
                            log("[CAPTCHA] Captcha detected after magic link")
                            callback_url, session_id = handle_captcha_checkpoint(
                                client, run3_id, session_id, provider, email, port)
                            if callback_url:
                                return _complete_reauth(proc, callback_url, auth_file,
                                                        stale_backup, email, provider, meta)
                            return EXIT_CAPTCHA

                        if not handle_two_factor_prompt(client, session_id, text3, two_factor):
                            return EXIT_FAILURE
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
                        f"Navigate to the magic link URL: {magic}. "
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

                    # Check for captcha after magic link navigation
                    if detect_captcha(result2, client):
                        log("[CAPTCHA] Captcha detected after magic link")
                        callback_url, session_id = handle_captcha_checkpoint(
                            client, run2_id, session_id, provider, email, port)
                        if callback_url:
                            return _complete_reauth(proc, callback_url, auth_file,
                                                    stale_backup, email, provider, meta)
                        return EXIT_CAPTCHA

                    if not handle_two_factor_prompt(client, session_id, text2, two_factor):
                        return EXIT_FAILURE
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
            callback_url, session_id = handle_captcha_checkpoint(
                client, run_auth_id, session_id, provider, email, port)
            if callback_url:
                return _complete_reauth(proc, callback_url, auth_file,
                                        stale_backup, email, provider, meta)
            return EXIT_FAILURE

        if not handle_two_factor_prompt(client, session_id, text_auth, two_factor):
            return EXIT_FAILURE

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

        # --- Step 8-9: Paste, validate, and activate ---
        return _complete_reauth(proc, callback_url, auth_file,
                                stale_backup, email, provider, meta)

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
# Checkpoint resume
# ---------------------------------------------------------------------------
def _checkpoint_resume(args) -> int:
    """Resume from a hCaptcha checkpoint file.

    Reads /opt/crsproxy/state/bu_reauth_checkpoint.json for the session_id, provider,
    email, and callback_port.  Starts a new cli-proxy-api login process
    (the original one is likely dead), creates a follow-up run in the
    same Browser Use session to click Authorize, extracts the callback
    URL, pastes it into the new login process's PTY, and completes the
    validation + activation flow.
    """
    if not CHECKPOINT_FILE.exists():
        log("[FAIL] No checkpoint file found — cannot resume")
        return EXIT_FAILURE

    try:
        ckpt = json.loads(CHECKPOINT_FILE.read_text())
    except Exception as e:
        log(f"[FAIL] Cannot read checkpoint file: {e}")
        return EXIT_FAILURE

    session_id = ckpt.get("session_id", "")
    provider = ckpt.get("provider", "")
    email = ckpt.get("email", "")
    port = ckpt.get("callback_port", 0)

    if not session_id or not provider or not email:
        log("[FAIL] Checkpoint file missing required fields")
        return EXIT_FAILURE

    if provider not in PROVIDERS:
        log(f"[FAIL] Unknown provider in checkpoint: {provider}")
        return EXIT_FAILURE

    meta = PROVIDERS[provider]
    safe = safe_email(email)
    log(f"=== Checkpoint resume: {provider} / {safe} ===")
    log(f"Session: {session_id[:12]}...")

    # Load API key
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
    atexit.register(client.stop_all_browsers)

    # Acquire serialization lease (prevents concurrent logins)
    if not acquire_lease(provider):
        log("[FAIL] Could not acquire lease — another login may be in progress")
        return EXIT_FAILURE

    # Start a new login process (the original is likely dead)
    log_path = Path("/tmp/bu_reauth_hub.log")
    log("[1] Starting new cli-proxy-api login for checkpoint resume")
    proc = start_login(provider, log_path)

    # Wait for OAuth URL (needed to keep the callback port listener alive)
    log("[2] Waiting for OAuth URL...")
    oauth_url = get_oauth_url(log_path, provider)
    if not oauth_url:
        log("[ERROR] No OAuth URL found — cannot resume login process")
        cleanup_login_process(proc)
        return EXIT_FAILURE
    log(f"[2] OAuth URL captured: {sanitize_url(oauth_url)}")

    # Back up stale auth
    auth_file = AUTH_DIR / f"{meta['auth_file_prefix']}-{email}.json"
    stale_backup = auth_file.with_suffix(".stale")
    if auth_file.exists():
        try:
            stale_backup.unlink(missing_ok=True)
            stale_backup.write_text(auth_file.read_text())
            log(f"[1] Stale auth backed up: {auth_file.name}")
        except Exception as e:
            log(f"[1] Stale auth backup warning: {e}")

    try:
        # Create follow-up run in the same session
        intercept_js = INTERCEPT_JS_TEMPLATE.format(port=port)
        log("[3] Creating follow-up run in same session")
        task_resume = (
            f"The captcha has been solved by a human. "
            f"Run this JavaScript in the browser console: {intercept_js} "
            f"Then if you see an Authorize or Allow button, click it. "
            f"Wait 3 seconds. "
            f"Then run window.__CB__ in the console and report its value. "
            f"If null, report the current URL. "
            f"If you see another captcha, report CAPTCHA."
        )
        run_resume = client.create_run(task_resume, session_id=session_id)
        run_resume_id = run_resume.get("id", "")
        log(f"[3] Follow-up run: {run_resume_id[:12]}...")

        result_resume = client.wait_for_run(run_resume_id,
                                            timeout=RUN_POLL_TIMEOUT)
        text_resume = str(result_resume.get("result", "") or "")
        log(f"[3] Follow-up run complete: {text_resume[:200]}")

        if detect_captcha(result_resume, client):
            log("[FAIL] Captcha still present — cannot complete")
            return EXIT_FAILURE

        callback_url = extract_callback_url(result_resume, client, provider)

        if not callback_url:
            log("[3] Callback not found — asking agent for window.__CB__")
            task_cb = (
                "Run window.__CB__ in the browser console and report the "
                "exact value. If null, report the current page URL."
            )
            run_cb = client.create_run(task_cb, session_id=session_id)
            result_cb = client.wait_for_run(run_cb.get("id", ""), timeout=60)
            callback_url = extract_callback_url(result_cb, client, provider)

        if not callback_url:
            log("[FAIL] Could not extract callback URL")
            return EXIT_FAILURE

        log(f"[3] Callback URL extracted: {sanitize_url(callback_url)}")

        return _complete_reauth(proc, callback_url, auth_file, stale_backup,
                                email, provider, meta)

    except Exception as e:
        log(f"[ERROR] Checkpoint resume error: {e}")
        return EXIT_FAILURE
    finally:
        client.stop_all_browsers()
        cleanup_login_process(proc)
        clear_checkpoint()
        release_lease()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global _log_file

    parser = argparse.ArgumentParser(
        description="Browser Use Cloud OAuth reauth for cliproxy / CLIProxyAPI"
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
    parser.add_argument("-validate-only", action="store_true",
                        help="Only validate an existing auth file (no reauth). "
                             "Checks email, type, expiry, and canary. "
                             "Use with -activate to activate after validation.")
    parser.add_argument("-activate", action="store_true",
                        help="With -validate-only: atomically activate the "
                             "auth file if validation passes "
                             "(sets disabled=false via temp file + rename)")
    parser.add_argument("-skip-canary", action="store_true",
                        help="Skip the canary request (metadata-only validation)")
    parser.add_argument("-checkpoint-timeout", type=int, default=0,
                        help="Override the human checkpoint timeout in seconds "
                             "(default: 600 = 10 minutes). Used when "
                             "hCaptcha is detected and a human must solve it.")
    parser.add_argument("-checkpoint-resume", action="store_true",
                        help="Resume from a checkpoint file written by a "
                             "previous run that detected hCaptcha. Reads "
                             "/opt/crsproxy/state/bu_reauth_checkpoint.json for the "
                             "session_id, then creates a follow-up run to "
                             "click Authorize and complete the flow.")
    parser.add_argument("-two-factor-method", default="none",
                        choices=["none", "onepassword_totp", "passkey_checkpoint",
                                 "sms_checkpoint", "push_checkpoint"],
                        help="2FA method to use if the login flow asks for one")
    parser.add_argument("-op-vault-id", default="",
                        help="1Password Connect vault UUID for onepassword_totp")
    parser.add_argument("-op-item-id", default="",
                        help="1Password Connect item UUID for onepassword_totp")
    parser.add_argument("-op-field", default="one-time password",
                        help="1Password item field containing the TOTP seed/URI")
    parser.add_argument("-log-file", default="",
                        help="Log file path (default: /tmp/bu_reauth.log)")
    args = parser.parse_args()

    # Set up log file
    log_path = args.log_file or str(LOG_DIR / "bu_reauth.log")
    _log_file = open(log_path, "a", encoding="utf-8")

    # --- Validate-only mode: standalone candidate validation ---
    if args.validate_only:
        meta = PROVIDERS[args.provider]
        auth_file = AUTH_DIR / f"{meta['auth_file_prefix']}-{args.email}.json"
        log(f"=== Validate-only: {args.provider} / {safe_email(args.email)} ===")
        log(f"Auth file: {auth_file.name}")

        if not auth_file.exists():
            log(f"[FAIL] Auth file not found: {auth_file.name}")
            return EXIT_FAILURE

        valid, reason = validate_candidate(
            auth_path=auth_file,
            expected_email=args.email,
            expected_type=args.provider,
            canary_model=meta.get("canary_model", ""),
            skip_canary=args.skip_canary,
        )

        if not valid:
            log(f"[FAIL] Validation failed: {reason}")
            return EXIT_FAILURE

        log(f"[OK] Validation passed: {reason}")

        if args.activate:
            log("Atomically activating auth file...")
            if not activate_auth_file(auth_file):
                log("[FAIL] Could not activate auth file")
                return EXIT_FAILURE
            log(f"[OK] Auth file activated: {auth_file.name}")

        return EXIT_SUCCESS

    # --- Checkpoint-resume mode: resume from a hCaptcha checkpoint ---
    if args.checkpoint_resume:
        return _checkpoint_resume(args)

    # Set overall timeout
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TOTAL_TIMEOUT)

    # Override checkpoint timeout if specified
    if args.checkpoint_timeout > 0:
        global CHECKPOINT_TIMEOUT
        CHECKPOINT_TIMEOUT = args.checkpoint_timeout

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

    two_factor = {
        "method": args.two_factor_method,
        "op_vault_id": args.op_vault_id,
        "op_item_id": args.op_item_id,
        "op_field": args.op_field,
    }

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
            two_factor=two_factor,
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
