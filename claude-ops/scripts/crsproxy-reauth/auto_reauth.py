#!/usr/bin/env python3
"""CRSProxy autonomous reauth monitor.

Runs periodically via the systemd timer ``crsproxy-reauth.timer``.

Responsibilities:
  1. Run ``cliproxy-pool-health`` and log the result.
  2. Reconcile actual auth files against the declarative account policy
     (``/opt/crsproxy/account_policy.yaml``):
       - If policy says enabled but auth file is disabled  -> trigger reauth.
       - If policy says disabled but auth file is enabled  -> disable it.
  3. Scan auth files for expired or disabled accounts.
  4. Trigger reauth for any expired account using **profile-first** logic:
       - If ``reauth_seats.json`` maps a Browser Use Cloud profile ID to the
         account -> invoke ``bu_profile_reauth.py`` with ``-profile-id``.
       - Otherwise -> fall back to ``bu_reauth_lib.py`` (email-based).
     A per-account cooldown prevents hammering a persistently-blocked account.
  5. Log all results WITHOUT exposing secrets (emails are masked, tokens /
     codes / cookies / callback URLs are never printed).
  6. NEVER restart, reload, or kill ``crsproxy.service`` — this monitor is
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
PROFILE_REAUTH_SCRIPT = "/opt/crsproxy/bu_profile_reauth.py"
ENV_FILE = Path("/opt/crsproxy/.env")
STATE_FILE = Path("/opt/crsproxy/.auto_reauth-state.json")
LOG_FILE = Path("/opt/crsproxy/auto_reauth.log")

# Declarative account policy (contains PII — deployed on hub only, never
# committed to the public repo).
ACCOUNT_POLICY_FILE = Path("/opt/crsproxy/account_policy.yaml")

# Reauth seat mapping (contains PII — deployed on hub only).
REAUTH_SEATS_FILE = Path("/opt/crsproxy/reauth_seats.json")

# Per-account cooldown after a reauth attempt (success OR failure) so a
# persistently-blocked account (e.g. 2FA wall) is not retried every 15 min.
COOLDOWN_SECONDS = 6 * 3600  # 6 hours

# How close to expiry before we consider a token "expiring soon" and worth a
# proactive reauth. Claude tokens have ~8h TTL; we reauth when < 1h remaining.
EXPIRY_SOON_SECONDS = 3600

# Providers that the reauth pipeline can handle. Others (e.g. antigravity)
# are skipped with a log line — they are not OAuth-reauthable by this pipeline.
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
# Account policy loading (YAML)
# ---------------------------------------------------------------------------
def load_account_policy() -> dict | None:
    """Load the declarative account policy from account_policy.yaml.

    Returns a dict with an ``accounts`` list, or None if the file is missing
    or unreadable. Uses PyYAML if available, falls back to a minimal parser
    for the simple key-value list format used by this policy file."""
    if not ACCOUNT_POLICY_FILE.exists():
        return None

    text = ACCOUNT_POLICY_FILE.read_text()

    # Try PyYAML first (installed on hub).
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        pass
    except Exception as exc:
        log(f"[policy] error parsing YAML: {exc.__class__.__name__} — "
            "falling back to minimal parser")
        # Fall through to minimal parser

    # Minimal parser for the simple accounts list format.
    return _minimal_yaml_parse(text)


def _minimal_yaml_parse(text: str) -> dict:
    """Parse the simple account_policy.yaml format without PyYAML.

    Expected format:
        accounts:
          - key: value
            key: value
          - key: value

    This handles only the flat list-of-dicts structure used by the policy
    file. It is NOT a general YAML parser."""
    accounts = []
    current = None
    in_accounts = False

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # Detect top-level "accounts:" key
        if not line.startswith(" ") and stripped.endswith(":"):
            in_accounts = stripped[:-1] == "accounts"
            continue

        if not in_accounts:
            continue

        # List item start
        if stripped.startswith("- "):
            if current is not None:
                accounts.append(current)
            current = {}
            # First key on the same line
            rest = stripped[2:].strip()
            if rest and ":" in rest:
                k, _, v = rest.partition(":")
                current[k.strip()] = _parse_yaml_value(v.strip())
        elif current is not None and ":" in stripped:
            k, _, v = stripped.partition(":")
            current[k.strip()] = _parse_yaml_value(v.strip())

    if current is not None:
        accounts.append(current)

    return {"accounts": accounts}


def _parse_yaml_value(v: str):
    """Parse a scalar YAML value (string, int, bool, None)."""
    if not v:
        return ""
    # Remove surrounding quotes
    if len(v) >= 2 and v[0] in ("'", '"') and v[-1] == v[0]:
        return v[1:-1]
    low = v.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if low in ("none", "null", "~"):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    return v


# ---------------------------------------------------------------------------
# Reauth seat mapping (JSON)
# ---------------------------------------------------------------------------
def load_reauth_seats() -> dict:
    """Load reauth_seats.json. Returns a dict with a ``seats`` list, or an
    empty dict if the file is missing."""
    if not REAUTH_SEATS_FILE.exists():
        return {}
    try:
        return json.loads(REAUTH_SEATS_FILE.read_text())
    except Exception as exc:
        log(f"[seats] error reading {REAUTH_SEATS_FILE.name}: "
            f"{exc.__class__.__name__}")
        return {}


def find_seat(seats: dict, provider: str, email: str) -> dict | None:
    """Find the seat entry matching provider+email in reauth_seats.json."""
    for seat in seats.get("seats", []):
        if seat.get("provider") == provider and seat.get("email") == email:
            return seat
    return None


# ---------------------------------------------------------------------------
# Auth file lookup
# ---------------------------------------------------------------------------
def find_auth_file(provider: str, email: str) -> Path | None:
    """Find the auth file for a given provider and email.

    Auth file naming conventions:
      - claude:  claude-{email}.json
      - xai:     xai-{email}.json
      - codex:   codex-{hash}-{email}-pro.json
      - antigravity: antigravity-{email}.json
    """
    # Try direct name first (works for claude, xai, antigravity).
    direct = AUTH_DIR / f"{provider}-{email}.json"
    if direct.exists():
        return direct

    # Search for files containing the email (handles codex hash prefix).
    for f in AUTH_DIR.glob(f"{provider}-*{email}*.json"):
        return f

    # Fallback: read files and check the email field inside (handles
    # filename mismatches, e.g. claude-user@example.com.json
    # containing email "user@example.com").
    for f in AUTH_DIR.glob(f"{provider}-*.json"):
        if any(ext in f.name for ext in (".bak", ".stale", ".lock", ".tmp")):
            continue
        try:
            data = json.loads(f.read_text())
            if data.get("email") == email and data.get("type") == provider:
                return f
        except Exception:
            continue

    return None


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


def scan_auth_files(policy_disabled=None):
    """Scan all auth files and return a list of dicts describing each account
    that needs a reauth (token expired/expiring-soon or disabled) and is
    supported by the reauth pipeline.

    If policy_disabled is provided (a set of (provider, email) tuples),
    accounts matching those tuples are excluded — they were intentionally
    disabled by policy and should not be reauthed. This prevents the
    reconciliation step from disabling a policy-disabled account and then
    the scan step immediately re-queueing it for reauth in the same cycle."""
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
        # Skip accounts that are intentionally disabled by policy — they
        # should not be re-queued for reauth by the generic scan.
        if policy_disabled and (provider, email) in policy_disabled:
            continue
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
# Reauth trigger (profile-first)
# ---------------------------------------------------------------------------
def trigger_reauth(account: dict, env: dict,
                   seats: dict | None = None) -> tuple[bool, str]:
    """Run a reauth for one account using profile-first logic.

    If ``reauth_seats.json`` maps a Browser Use Cloud profile ID to this
    account, invoke ``bu_profile_reauth.py`` with ``-profile-id``. Otherwise
    fall back to ``bu_reauth_lib.py`` (email-based).

    Secrets are never logged: emails are masked, and the subprocess inherits
    the loaded .env so BROWSER_USE_API_KEY and Gmail credentials are
    available without printing them. The method used (profile vs email) is
    logged, but the profile ID is truncated to 12 chars."""
    provider = account["provider"]
    email = account["email"]
    masked = mask_email(email)

    # Look up seat mapping for profile-first reauth.
    seat = None
    if seats is not None:
        seat = find_seat(seats, provider, email)

    if seat and seat.get("profile_id"):
        # --- Profile-based reauth ---
        profile_id = seat["profile_id"]
        cmd = [
            REAUTH_CMD, PROFILE_REAUTH_SCRIPT,
            "-provider", provider,
            "-email", email,
            "-profile-id", profile_id,
        ]
        method = "profile"
        log(f"[reauth] triggering {provider} for {masked} via {method} "
            f"(profile={profile_id[:12]}... reason: {account['reason']})")
    else:
        # --- Email-based reauth (fallback) ---
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
        method = "email"
        log(f"[reauth] triggering {provider} for {masked} via {method} "
            f"(reason: {account['reason']})")

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
            return True, f"reauth succeeded ({method})"
        if rc == 2:
            return False, f"hCaptcha checkpoint — needs human intervention ({method})"
        return False, f"reauth failed (exit {rc}, {method})"
    except subprocess.TimeoutExpired:
        return False, f"reauth timed out (>660s, {method})"
    except Exception as exc:
        return False, f"reauth error: {exc.__class__.__name__} ({method})"


# ---------------------------------------------------------------------------
# Account policy reconciliation
# ---------------------------------------------------------------------------
def reconcile_accounts(env: dict, seats: dict, state: dict) -> dict:
    """Reconcile actual auth files against the declarative account policy.

    For each account declared in ``account_policy.yaml``:
      - If policy says ``enabled: true`` but the auth file is disabled
        -> trigger reauth (subject to cooldown).
      - If policy says ``enabled: false`` but the auth file is enabled
        -> disable it atomically (temp file + rename) and record the reason.
      - If state matches policy -> no action.

    Returns a summary dict:
      {"reauth_triggered": N, "disabled": N, "skipped": N, "errors": N}
    """
    policy = load_account_policy()
    if not policy:
        log("[reconcile] no account_policy.yaml found — skipping reconciliation")
        return {"reauth_triggered": 0, "disabled": 0, "skipped": 0, "errors": 0}

    accounts_list = policy.get("accounts", [])
    if not accounts_list:
        log("[reconcile] account_policy.yaml has no accounts — skipping")
        return {"reauth_triggered": 0, "disabled": 0, "skipped": 0, "errors": 0}

    summary = {"reauth_triggered": 0, "disabled": 0, "skipped": 0, "errors": 0}
    log(f"[reconcile] processing {len(accounts_list)} account(s) from policy")

    for entry in accounts_list:
        provider = entry.get("provider", "")
        email = entry.get("email", "")
        should_be_enabled = entry.get("enabled", True)
        reason_text = entry.get("reason", "")
        masked = mask_email(email)

        # Find the auth file for this account.
        auth_file = find_auth_file(provider, email)
        if not auth_file:
            if should_be_enabled:
                log(f"[reconcile] {masked} ({provider}): no auth file — "
                    "cannot enable, will be handled by reauth pipeline")
            else:
                log(f"[reconcile] {masked} ({provider}): no auth file — "
                    "already absent (policy: disabled)")
            summary["skipped"] += 1
            continue

        # Read current state.
        try:
            data = json.loads(auth_file.read_text())
        except Exception as exc:
            log(f"[reconcile] {masked} ({provider}): unreadable auth file "
                f"({exc.__class__.__name__}) — skipping")
            summary["errors"] += 1
            continue

        is_disabled = bool(data.get("disabled", False))

        if should_be_enabled and is_disabled:
            # Policy says enabled but auth file is disabled -> trigger reauth.
            key = f"{provider}:{email}"
            if in_cooldown(state, key):
                log(f"[reconcile] {masked} ({provider}): should be enabled "
                    "but is disabled — in cooldown, skipping")
                summary["skipped"] += 1
                continue

            log(f"[reconcile] {masked} ({provider}): should be enabled but "
                "is disabled — triggering reauth")
            account = {
                "file": auth_file.name,
                "provider": provider,
                "email": email,
                "reason": "policy-enabled-but-disabled",
            }
            success, reason = trigger_reauth(account, env, seats)
            record_attempt(state, key, success, reason)
            if success:
                summary["reauth_triggered"] += 1
                log(f"[reconcile] {masked} ({provider}): reauth succeeded")
            else:
                log(f"[reconcile] {masked} ({provider}): reauth failed — {reason}")

        elif not should_be_enabled and not is_disabled:
            # Policy says disabled but auth file is enabled -> disable it.
            log(f"[reconcile] {masked} ({provider}): should be disabled but "
                "is enabled — disabling per policy")
            if reason_text:
                data["disabled_reason"] = reason_text
            data["disabled"] = True
            # Atomic write: temp file + rename.
            tmp = auth_file.with_suffix(".tmp")
            try:
                tmp.write_text(json.dumps(data, indent=2))
                os.replace(tmp, auth_file)
                summary["disabled"] += 1
                log(f"[reconcile] {masked} ({provider}): disabled per policy")
            except Exception as exc:
                log(f"[reconcile] {masked} ({provider}): failed to disable "
                    f"({exc.__class__.__name__})")
                summary["errors"] += 1
                try:
                    if tmp.exists():
                        tmp.unlink()
                except Exception:
                    pass

        else:
            # State matches policy — no action needed.
            summary["skipped"] += 1

    log(f"[reconcile] summary: reauth_triggered={summary['reauth_triggered']} "
        f"disabled={summary['disabled']} skipped={summary['skipped']} "
        f"errors={summary['errors']}")
    return summary


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

    # 2. Load env, seats, and cooldown state.
    env = os.environ.copy()
    env.update(load_env(ENV_FILE))
    env["HOME"] = "/opt/crsproxy"

    seats = load_reauth_seats()
    state = load_state()

    # 3. Run account policy reconciliation.
    reconcile_summary = reconcile_accounts(env, seats, state)

    # Build set of policy-disabled accounts to exclude from the generic scan.
    # This prevents the scan from re-queueing accounts that were just disabled
    # by reconcile_accounts() in the same cycle (reconciliation bug fix).
    policy = load_account_policy()
    policy_disabled = set()
    if policy:
        for entry in policy.get("accounts", []):
            if not entry.get("enabled", True):
                policy_disabled.add(
                    (entry.get("provider", ""), entry.get("email", "")))

    # 4. Scan auth files for expired/disabled accounts.
    needs = scan_auth_files(policy_disabled=policy_disabled)
    log(f"[scan] {len(needs)} account(s) need reauth (token expiry/disabled)")

    if not needs:
        log("auto_reauth: nothing to do — all accounts healthy")
        log("=" * 72)
        return 3 if infra_failure else 0

    # 5. Trigger reauth for each account (profile-first, with cooldown).
    attempted = 0
    succeeded = 0
    for account in needs:
        key = f"{account['provider']}:{account['email']}"
        if in_cooldown(state, key):
            log(f"[skip] {mask_email(account['email'])} ({account['provider']}) "
                f"in cooldown — last attempt too recent")
            continue

        attempted += 1
        success, reason = trigger_reauth(account, env, seats)
        record_attempt(state, key, success, reason)
        if success:
            succeeded += 1
            log(f"[ok] {mask_email(account['email'])} ({account['provider']}): {reason}")
        else:
            log(f"[fail] {mask_email(account['email'])} ({account['provider']}): {reason}")

    log(f"[summary] reconcile: {reconcile_summary['reauth_triggered']} reauthed, "
        f"{reconcile_summary['disabled']} disabled. "
        f"scan: attempted={attempted} succeeded={succeeded} "
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
