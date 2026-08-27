#!/usr/bin/env bash
# test-ops-marketing-dash-brand-isolation.sh
# --project other-than-default must not inherit owner env Amplitude/AppsFlyer/RevenueCat.
# OPS_MARKETING_DUMP_CRED_PRESENCE=1 prints booleans only (no secret values).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN="${PLUGIN_ROOT}/bin/ops-marketing-dash"

pass=0
fail=0
ok()  { printf '  PASS: %s\n' "$1"; pass=$((pass+1)); }
err() { printf '  FAIL: %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

cat > "${FIXTURE_DIR}/preferences.json" <<'EOF'
{
  "marketing": {
    "default_project": "acme",
    "projects": {
      "acme": {
        "domain": "acme.example",
        "amplitude": {
          "api_key": "inline-acme-amp",
          "secret_key": "inline-acme-amp-secret"
        }
      },
      "fresh": {
        "domain": "fresh.example",
        "amplitude": {
          "api_key": "inline-fresh-amp",
          "secret_key": "inline-fresh-amp-secret"
        }
      },
      "empty": {
        "domain": "empty.example"
      }
    }
  }
}
EOF

export OPS_DATA_DIR="$FIXTURE_DIR"
export OPS_MARKETING_DUMP_CRED_PRESENCE=1
unset OPS_MARKETING_PROJECT || true

# Owner-brand env that must not leak onto --project empty / fresh.
export AMPLITUDE_API_KEY="LEAKED_FROM_ENV"
export AMPLITUDE_SECRET_KEY="LEAKED_FROM_ENV"
export APPSFLYER_API_V2_TOKEN="LEAKED_FROM_ENV"
export APPSFLYER_APP_ID="id0000000000"
export REVENUECAT_API_KEY="LEAKED_FROM_ENV"
export REVENUECAT_PROJECT_ID="proj000"
export KLAVIYO_PRIVATE_KEY="LEAKED_FROM_ENV"
export INSTAGRAM_ACCOUNT_ID="0000000000"

dump() {
  "$BIN" "$@"
}

echo ""
echo "--- 1. --project empty does not inherit owner env ---"
out="$(dump --project empty 2>/dev/null || true)"
if printf '%s' "$out" | jq -e '.isolated == true and .amplitude == false and .appsflyer == false and .revenuecat == false and .klaviyo == false and .instagram == false' >/dev/null; then
  ok "empty project: all brand trackers absent despite env"
else
  err "empty isolation" "$out"
fi

echo ""
echo "--- 2. --project fresh uses its own amplitude, not env ---"
out="$(dump --project fresh 2>/dev/null || true)"
if printf '%s' "$out" | jq -e '.isolated == true and .amplitude == true and .appsflyer == false and .revenuecat == false' >/dev/null; then
  ok "fresh: project amplitude present, env appsflyer/revenuecat ignored"
else
  err "fresh project keys" "$out"
fi

echo ""
echo "--- 3. default project (no --project) may use env for missing channels ---"
out="$(dump 2>/dev/null || true)"
if printf '%s' "$out" | jq -e '.isolated == false and .project == "acme" and .amplitude == true and .appsflyer == true and .revenuecat == true' >/dev/null; then
  ok "default acme: prefs amplitude + env appsflyer/revenuecat"
else
  err "default fallback" "$out"
fi

echo ""
echo "--- 4. --project acme (same as default) is not isolated ---"
out="$(dump --project acme 2>/dev/null || true)"
if printf '%s' "$out" | jq -e '.isolated == false and .amplitude == true' >/dev/null; then
  ok "--project default-name is not isolated"
else
  err "explicit default" "$out"
fi

echo ""
echo "--- 5. dump never prints env sentinel ---"
out="$(dump --project empty 2>/dev/null || true)"
if printf '%s' "$out" | grep -q 'LEAKED_FROM_ENV'; then
  err "secret leak" "dump contained env sentinel"
else
  ok "dump is presence-only"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
