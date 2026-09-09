#!/usr/bin/env bash
# A 401 only means "needs_bootstrap" when the probe actually presented a
# credential and the server rejected it. With nothing to present, a 401 says
# only that the prober knocked with empty hands.
#
# This matters because Claude Code keeps OAuth tokens for natively-authenticated
# HTTP MCPs in memory, where no external process can read them. Such a server
# answers every session normally and probes 401 forever. Classifying that as
# needs_bootstrap dispatched the fix agent and a Playwright OAuth flow on every
# tick, and told the owner to re-auth a server that was never broken.
# Measured 2026-09-08: claude-design and openrouter, both working in-session.
#
# run-all.sh invokes suites with bash, so the Python driver is embedded here.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="${MCP_WATCHDOG_UNDER_TEST:-$HERE/../scripts/ops-mcp-watchdog.py}"

if [ ! -f "$WATCHDOG" ]; then
  echo "FAIL: watchdog not found at $WATCHDOG"
  exit 1
fi

python3 - "$WATCHDOG" <<'PY'
import importlib.util
import json
import sys
import urllib.error
import urllib.request

PATH = sys.argv[1]
spec = importlib.util.spec_from_file_location("wd", PATH)
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

FAILS = []
PASSES = 0


def check(name, cond, detail=""):
    global PASSES
    if cond:
        PASSES += 1
    else:
        FAILS.append(f"{name}{(': ' + detail) if detail else ''}")


def fake_401(body=b'{"error":"invalid_token"}'):
    """Make every probe hit a 401, so classification is the only variable."""
    def _open(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, __import__("io").BytesIO(body))
    return _open


real_open = urllib.request.urlopen
real_find = wd.find_token_cache
real_kc = wd.keychain_oauth_token
real_cfg = wd.config_headers
real_api = wd.get_api_key_for
try:
    urllib.request.urlopen = fake_401()

    # --- Case 1: no credential anywhere → no_probe_credential, not a fault.
    wd.find_token_cache = lambda url: (None, None)
    wd.keychain_oauth_token = lambda name: None
    wd.config_headers = lambda name: {}
    wd.get_api_key_for = lambda name: None
    r = wd.probe("https://example.invalid/mcp", "some-native-mcp")
    check("blind 401 is not needs_bootstrap", r["state"] != "needs_bootstrap",
          f"got {r['state']}")
    check("blind 401 is no_probe_credential", r["state"] == "no_probe_credential",
          f"got {r['state']}")
    check("blind 401 records had_probe_credential=False",
          r.get("had_probe_credential") is False, repr(r.get("had_probe_credential")))

    # --- Case 2: a keychain token WAS presented and rejected → real bootstrap.
    wd.keychain_oauth_token = lambda name: "tok-from-keychain"
    r = wd.probe("https://example.invalid/mcp", "some-oauth-mcp")
    check("rejected credential is needs_bootstrap", r["state"] == "needs_bootstrap",
          f"got {r['state']}")
    check("rejected credential records had_probe_credential=True",
          r.get("had_probe_credential") is True, repr(r.get("had_probe_credential")))
    wd.keychain_oauth_token = lambda name: None

    # --- Case 3: a static config header counts as a presented credential.
    wd.config_headers = lambda name: {"Authorization": "Bearer from-config"}
    r = wd.probe("https://example.invalid/mcp", "header-mcp")
    check("config header counts as a credential", r["state"] == "needs_bootstrap",
          f"got {r['state']}")
    wd.config_headers = lambda name: {}

    # --- Case 4: a refresh token still wins — that path is recoverable.
    wd.find_token_cache = lambda url: (None, None)
    class _P:
        def read_text(self):
            return json.dumps({"access_token": "a", "refresh_token": "r"})
    wd.find_token_cache = lambda url: (_P(), None)
    r = wd.probe("https://example.invalid/mcp", "refreshable-mcp")
    check("refresh token still classifies token_expired",
          r["state"] == "token_expired", f"got {r['state']}")
finally:
    urllib.request.urlopen = real_open
    wd.find_token_cache = real_find
    wd.keychain_oauth_token = real_kc
    wd.config_headers = real_cfg
    wd.get_api_key_for = real_api

# --- Case 5: the state must never drive the fixer or a browser OAuth flow.
src = open(PATH).read()
reauth_guard = 'if info.get("state") != "needs_bootstrap":' in src
check("auto-reauth loop only acts on needs_bootstrap", reauth_guard)
check("degradation diff excludes no_probe_credential",
      '!= "no_probe_credential"' in src)

# --- Case 6: the summary must be able to count it.
check("summary has a no_probe_credential bucket", '"no_probe_credential": 0' in src)

# --- Case 7: ops-doctor must not warn on it.
import os
doctor = os.path.join(os.path.dirname(PATH), "..", "bin", "ops-doctor")
if os.path.exists(doctor):
    d = open(doctor).read()
    check("ops-doctor skips no_probe_credential in its degraded>1h warning",
          "no_probe_credential" in d)
else:
    check("ops-doctor present", False, "not found")

for f in FAILS:
    print(f"FAIL: {f}")
print(f"{PASSES} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
PY
