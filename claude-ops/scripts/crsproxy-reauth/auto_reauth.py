#!/usr/bin/env python3
"""CRSProxy autonomous reauth monitor.

Runs periodically via the systemd timer ``crsproxy-reauth.timer``.

Responsibilities:
  1. Run ``cliproxy-pool-health`` and log the result.
  2. Scan auth files for expired or disabled accounts.
  3. Trigger ``bu_reauth_lib.py`` for any expired account (subject to a
     per-account cooldown so a persistently-blocked account is not hammered).
  4. Log all results WITHOUT exposing secrets (emails are masked, tokens /
     codes / cookies / callback URLs are never printed).
  5. NEVER restart, reload, or kill ``crsproxy.service`` — this monitor is
     strictly read-only with respect to the proxy process. Auth files
     hot-reload, so reauth never requires a service restart.

Exit codes:
  0 — monitor completed (regardless of whether any reauth succeeded; the
      monitor is best-effort and must not fail the timer unit on a single
      reauth error, otherwise systemd would stop rescheduling it).
  2 — unrecoverable setup error (e.g. auth dir missing).
  3 — infrastructure failure (e.g. pool-health command not found, unhandled
      exception). Individual account reauth failures never cause a nonzero
      exit — only monitor-level breakage does.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
AUTH_DIR = Path("/opt/crsproxy/auths")
POOL_HEALTH_CMD = "/usr/local/bin/cliproxy-pool-health"
REAUTH_CMD = "/opt/crsproxy/venv/bin/python"
REAUTH_SCRIPT = "/opt/crsproxy/bu_reauth_lib.py"
ENV_FILE = Path("/opt/crsproxy/.env")
STATE_FILE = Path("/opt/crsproxy/.auto_reauth-state.json")
LOG_FILE = Path("/opt/crsproxy/auto_reauth.log")

# Per-account cooldown after a reauth attempt (success OR failure) so a
# persistently-blocked account (e.g. 2FA wall) is not retried every 15 min.
COOLDOWN_SECONDS = 6 * 3600  # 6 hours

# How close to expiry before we consider a token "expiring soon" and worth a
# proactive reauth. Claude tokens have ~8h TTL; we reauth when < 1h remaining.
EXPIRY_SOON_SECONDS = 3600

# Providers that bu_reauth_lib.py can reauth. Others (e.g. antigravity) are
# skipped with a log line — they are not OAuth-reauthable by this pipeline.
SUPPORTED_PROVIDERS = {"claude", "xai", "codex"}

# ---------------------------------------------------------------------------
# Logging — secrets are never written to logs.
# ---------------------------------------------------------------------------
_LOG_FP = None


def _open_log():
    global _LOG_FP
    if _LOG_FP is not None:
        return
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LOG_FP = open(LOG_FILE, "a", encoding="utf-8")
    except Exception:
        # Fall back to stderr (captured by journald).
        _LOG_FP = sys.stderr


def log(msg: str):
    """Log a single line with an ISO-8601 timestamp. No secrets are ever
    passed to log() by this module — callers mask emails before logging."""
    _open_log()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {msg}"
    if _LOG_FP is not None:
        try:
            _LOG_FP.write(line + "\n")
            _LOG_FP.flush()
        except Exception:
            pass
    # Always also print to stdout so systemd captures it in the journal.
    print(line, flush=True)


def mask_email(email: str) -> str:
    """Mask an email address for logging: 'us**@example.com'."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked = local[0] + "*"
    else:
        masked = local[:2] + "*" * (len(local) - 2)
    return f"{masked}@{domain}"


# ---------------------------------------------------------------------------
# Environment loading — read /opt/crsproxy/.env so the reauth subprocess
# inherits BROWSER_USE_API_KEY and Gmail/gogcli credentials.
# ---------------------------------------------------------------------------
def load_env(path: Path) -> dict:
    """Parse a simple KEY=VALUE .env file into a dict. Values may be wrapped
    in single or double quotes. Comments and blank lines are skipped."""
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        env[key] = val
    return env


# ---------------------------------------------------------------------------
# Cooldown state — prevents hammering a persistently-blocked account.
# ---------------------------------------------------------------------------
def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict):
    tmp = STATE_FILE.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(state, indent=2))
        os.replace(tmp, STATE_FILE)
    except Exception:
        # Non-fatal — cooldown is a best-effort optimization.
        pass


def in_cooldown(state: dict, account_key: str) -> bool:
    last = state.get(account_key, {}).get("last_attempt", 0)
    return (time.time() - last) < COOLDOWN_SECONDS


def record_attempt(state: dict, account_key: str, success: bool, reason: str = ""):
    state[account_key] = {
        "last_attempt": time.time(),
        "success": success,
        "reason": reason,
    }
    save_state(state)


# ---------------------------------------------------------------------------
# Pool health
# ---------------------------------------------------------------------------
def run_pool_health() -> tuple[int, str, bool]:
    """Run cliproxy-pool-health. Returns (exit_code, stdout, ran_ok).

    ``ran_ok`` is False when the command could not be executed at all
    (not found, permission denied) or timed out — these are infrastructure
    failures that should surface a nonzero exit code to systemd. ``ran_ok``
    is True when the command executed, regardless of its return code (a
    nonzero return code just means the pool is DEGRADED/CRITICAL, not that
    the monitor itself is broken).

    The command is read-only — it sends canary requests through the proxy
    but never restarts or modifies the proxy process."""
    try:
        proc = subprocess.run(
            [POOL_HEALTH_CMD],
            capture_output=True,
            text=True,
            timeout=120,
        )
        out = (proc.stdout or "").strip()
        return proc.returncode, out, True
    except subprocess.TimeoutExpired:
        return 1, "TIMEOUT pool health check exceeded 120s", False
    except Exception as exc:
        return 1, f"ERROR running pool health: {exc.__class__.__name__}", False


def parse_pool_status(output: str) -> str:
    """Extract the leading status token (OK / DEGRADED / CRITICAL) from the
    pool health output line."""
    if not output:
        return "UNKNOWN"
    first = output.splitlines()[0].strip()
    for token in ("OK", "DEGRADED", "CRITICAL"):
        if first.startswith(token):
            return token
    return "UNKNOWN"


# ---------------------------------------------------------------------------
# Auth file scanning
# ---------------------------------------------------------------------------
def parse_expiry(expired: str):
    """Parse an ISO-8601 expiry timestamp into an aware datetime, or None."""
    if not expired:
        return None
    try:
        return datetime.fromisoformat(expired.replace("Z", "+00:00"))
    except Exception:
        return None


def scan_auth_files():
    """Scan all auth files and return a list of dicts describing each account
    that needs a reauth (token expired/expiring-soon or disabled) and is
    supported by the reauth pipeline."""
    now = datetime.now(timezone.utc)
    needs_reauth = []
    all_files = sorted(AUTH_DIR.glob("*.json"))
    for path in all_files:
        try:
            data = json.loads(path.read_text())
        except Exception:
            log(f"[skip] unreadable auth file: {path.name}")
            continue

        provider = data.get("type", "")
        email = data.get("email", "")
        disabled = bool(data.get("disabled", False))
        exp = parse_expiry(data.get("expired", ""))

        # Determine if the token is expired or expiring soon.
        token_stale = False
        if exp is not None:
            if exp < now:
                token_stale = True
            elif (exp - now) < timedelta(seconds=EXPIRY_SOON_SECONDS):
                token_stale = True

        if not disabled and not token_stale:
            continue  # healthy — nothing to do

        reason = []
        if disabled:
            reason.append("disabled")
        if token_stale:
            reason.append("token-expired" if (exp and exp < now) else "token-expiring-soon")

        if provider not in SUPPORTED_PROVIDERS:
            log(f"[skip] unsupported provider '{provider}' for {mask_email(email)} "
                f"({', '.join(reason)}) — not reauthable by this pipeline")
            continue

        needs_reauth.append({
            "file": path.name,
            "provider": provider,
            "email": email,
            "reason": ", ".join(reason),
        })
    return needs_reauth


# ---------------------------------------------------------------------------
# Reauth trigger
# ---------------------------------------------------------------------------
def trigger_reauth(account: dict, env: dict) -> tuple[bool, str]:
    """Run bu_reauth_lib.py for one account. Returns (success, reason).

    Secrets are never logged: we pass -gog-account but mask the email in all
    log output. The subprocess inherits the loaded .env so BROWSER_USE_API_KEY
    and Gmail credentials are available without printing them."""
    provider = account["provider"]
    email = account["email"]
    masked = mask_email(email)

    # Claude verification emails are forwarded to a central Gmail inbox
    # (GOG_ACCOUNT in .env), not the account's own address. Polling the
    # account's own mailbox fails with "No auth for gmail". For other
    # providers (xai, codex) the verification email goes to the account
    # itself, so we poll that address directly.
    if provider == "claude":
        gog_account = env.get("GOG_ACCOUNT", "")
        if not gog_account:
            log("[warn] GOG_ACCOUNT not set in env — Claude reauth will "
                "fall back to account email (may fail)")
            gog_account = email
    else:
        gog_account = email

    cmd = [
        REAUTH_CMD, REAUTH_SCRIPT,
        "-provider", provider,
        "-email", email,
        "-gog-account", gog_account,
    ]
    log(f"[reauth] triggering {provider} for {masked} (reason: {account['reason']})")

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=660,  # bu_reauth TOTAL_TIMEOUT is 600s; add slack
            env=env,
        )
        # The reauth script's own logs go to its log file; we only capture the
        # exit code here. We do NOT log stdout/stderr to avoid leaking any
        # secret that might slip through (emails, codes, URLs).
        rc = proc.returncode
        if rc == 0:
            return True, "reauth succeeded"
        if rc == 2:
            return False, "hCaptcha checkpoint — needs human intervention"
        return False, f"reauth failed (exit {rc})"
    except subprocess.TimeoutExpired:
        return False, "reauth timed out (>660s)"
    except Exception as exc:
        return False, f"reauth error: {exc.__class__.__name__}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    log("=" * 72)
    log("auto_reauth: starting periodic reauth check")

    if not AUTH_DIR.is_dir():
        log(f"[fatal] auth dir not found: {AUTH_DIR}")
        return 2

    # 1. Run pool health and log the result.
    rc, out, ran_ok = run_pool_health()
    status = parse_pool_status(out)
    log(f"[pool-health] status={status} exit={rc}")
    # Log the pool health line (it contains no secrets — only counts/probes).
    for line in out.splitlines():
        log(f"[pool-health] {line}")

    # Track infrastructure failures (command not found, timeout) so we can
    # surface a nonzero exit to systemd. Individual reauth failures are
    # best-effort and never cause a nonzero exit.
    infra_failure = not ran_ok
    if infra_failure:
        log("[fatal] pool-health infrastructure failure — monitor cannot run")

    # 2. Scan auth files for expired/disabled accounts.
    needs = scan_auth_files()
    log(f"[scan] {len(needs)} account(s) need reauth")

    if not needs:
        log("auto_reauth: nothing to do — all accounts healthy")
        log("=" * 72)
        return 3 if infra_failure else 0

    # 3. Load env + cooldown state, then trigger reauth for each account.
    env = os.environ.copy()
    env.update(load_env(ENV_FILE))
    env["HOME"] = "/opt/crsproxy"

    state = load_state()
    attempted = 0
    succeeded = 0
    for account in needs:
        key = f"{account['provider']}:{account['email']}"
        if in_cooldown(state, key):
            log(f"[skip] {mask_email(account['email'])} ({account['provider']}) "
                f"in cooldown — last attempt too recent")
            continue

        attempted += 1
        success, reason = trigger_reauth(account, env)
        record_attempt(state, key, success, reason)
        if success:
            succeeded += 1
            log(f"[ok] {mask_email(account['email'])} ({account['provider']}): {reason}")
        else:
            log(f"[fail] {mask_email(account['email'])} ({account['provider']}): {reason}")

    log(f"[summary] attempted={attempted} succeeded={succeeded} "
        f"skipped(cooldown)={len(needs) - attempted}")
    log("=" * 72)

    # Always return 0 for individual reauth failures (best-effort) so the
    # timer keeps firing. Return nonzero (3) only for infrastructure
    # failures so systemd knows the monitor itself is broken.
    return 3 if infra_failure else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"[fatal] unhandled exception: {exc.__class__.__name__}: {exc}")
        sys.exit(3)  # infrastructure failure — surface to systemd
