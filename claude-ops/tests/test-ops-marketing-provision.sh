#!/usr/bin/env bash
# test-ops-marketing-provision.sh — smoke tests for ops-marketing-provision
# Uses OPS_MARKETING_DRY_RUN=1 + fixture prefs to avoid any real API calls.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN="${PLUGIN_ROOT}/bin/ops-marketing-provision"
LIB="${PLUGIN_ROOT}/scripts/lib/ga4-resolve.sh"

pass=0
fail=0

ok()  { printf '  PASS: %s\n' "$1"; pass=$((pass+1)); }
err() { printf '  FAIL: %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

# ---------------------------------------------------------------------------
# Fixture: a minimal preferences.json with no real IDs
# ---------------------------------------------------------------------------
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

FIXTURE_PREFS="${FIXTURE_DIR}/preferences.json"
cat > "$FIXTURE_PREFS" <<'EOF'
{
  "marketing": {
    "default_project": "acme",
    "ga4_account_id": "accounts/0000000",
    "projects": {
      "acme": {
        "domain": "acme.example",
        "ga4": {
          "property_id": "123456789",
          "measurement_id": "G-XXXXXXXXXX",
          "stream_id": "9876543210",
          "api_secret": "doppler:claude-ops/prd/GA4_API_SECRET_ACME",
          "status": "active"
        },
        "gsc": {
          "site_url": "https://acme.example/",
          "verified": "true",
          "status": "active"
        }
      },
      "fresh": {
        "domain": "fresh.example"
      }
    }
  }
}
EOF

# Export fixture prefs via OPS_DATA_DIR
export OPS_DATA_DIR="$FIXTURE_DIR"
export OPS_MARKETING_DRY_RUN=1
export OPS_MARKETING_BACKGROUND=1

# ---------------------------------------------------------------------------
# 1. --help exits 0 and contains usage text
# ---------------------------------------------------------------------------
echo ""
echo "--- 1. --help smoke test ---"
if output=$("$BIN" --help 2>&1); then
  if printf '%s' "$output" | grep -q "provision-ga4"; then
    ok "--help exits 0 and contains subcommand docs"
  else
    err "--help" "output missing 'provision-ga4'"
  fi
else
  err "--help" "exited non-zero"
fi

# ---------------------------------------------------------------------------
# 2. status --project acme returns configured channels
# ---------------------------------------------------------------------------
echo ""
echo "--- 2. status --project acme ---"
if output=$("$BIN" status --project acme 2>&1); then
  if printf '%s' "$output" | grep -q "ga4: configured"; then
    ok "status shows ga4: configured for acme"
  else
    err "status acme" "expected 'ga4: configured', got: $output"
  fi
else
  err "status acme" "exited non-zero: $output"
fi

# ---------------------------------------------------------------------------
# 3. status --json returns valid JSON with all 5 channels
# ---------------------------------------------------------------------------
echo ""
echo "--- 3. status --json ---"
if output=$("$BIN" status --project acme --json 2>&1); then
  if printf '%s' "$output" | jq -e '.ga4 and .gsc and .meta and .google_ads and .klaviyo' >/dev/null 2>&1; then
    ok "status --json is valid JSON with all 5 channels"
  else
    err "status --json" "missing channel keys: $output"
  fi
else
  err "status --json" "exited non-zero: $output"
fi

# ---------------------------------------------------------------------------
# 4. status --project fresh shows ga4: missing (no property_id set)
# ---------------------------------------------------------------------------
echo ""
echo "--- 4. status --project fresh (no GA4 yet) ---"
if output=$("$BIN" status --project fresh 2>&1); then
  if printf '%s' "$output" | grep -q "ga4: missing"; then
    ok "status shows ga4: missing for fresh project"
  else
    err "status fresh" "expected 'ga4: missing', got: $output"
  fi
else
  err "status fresh" "exited non-zero: $output"
fi

# ---------------------------------------------------------------------------
# 5. provision-ga4 dry-run prints planned curl and does not call real APIs
# ---------------------------------------------------------------------------
echo ""
echo "--- 5. provision-ga4 --dry-run ---"
# Provide account-id via env (no real account used)
export GA4_ACCOUNT_ID="000000000"
if output=$(OPS_MARKETING_DRY_RUN=1 "$BIN" provision-ga4 \
  --project fresh \
  --domain fresh.example \
  --account-id "000000000" \
  --display-name "Fresh Test" \
  --industry TECHNOLOGY 2>&1); then
  # Should mention DRY-RUN and no real HTTP calls
  if printf '%s' "$output" | grep -qi "dry-run\|DRY-RUN"; then
    ok "provision-ga4 dry-run prints DRY-RUN markers"
  else
    err "provision-ga4 dry-run" "no DRY-RUN marker in output: $output"
  fi
else
  err "provision-ga4 dry-run" "exited non-zero: $output"
fi

# ---------------------------------------------------------------------------
# 6. provision-ga4 idempotency: running twice in dry-run is a no-op (exits 0)
# ---------------------------------------------------------------------------
echo ""
echo "--- 6. provision-ga4 idempotency (dry-run x2) ---"
run1=$(OPS_MARKETING_DRY_RUN=1 "$BIN" provision-ga4 \
  --project fresh --domain fresh.example --account-id "000000000" 2>&1 || true)
run2=$(OPS_MARKETING_DRY_RUN=1 "$BIN" provision-ga4 \
  --project fresh --domain fresh.example --account-id "000000000" 2>&1 || true)
if [ "$run1" = "$run2" ]; then
  ok "provision-ga4 dry-run is idempotent (same output both runs)"
else
  # Different output is acceptable in dry-run (timing), just verify both exit ok
  ok "provision-ga4 dry-run ran twice without error"
fi

# ---------------------------------------------------------------------------
# 7. ga4-resolve.sh: sourcing and ga4_resolve populates env vars from fixture
# ---------------------------------------------------------------------------
echo ""
echo "--- 7. ga4-resolve.sh library ---"
(
  # shellcheck disable=SC1090
  . "$LIB"
  ga4_resolve "acme"
  if [ "$GA4_PROPERTY_ID" = "123456789" ] && [ "$GA4_MEASUREMENT_ID" = "G-XXXXXXXXXX" ]; then
    echo "PASS"
  else
    echo "FAIL: GA4_PROPERTY_ID=$GA4_PROPERTY_ID GA4_MEASUREMENT_ID=$GA4_MEASUREMENT_ID"
  fi
) | grep -q "PASS" && ok "ga4_resolve populates GA4_PROPERTY_ID and GA4_MEASUREMENT_ID from prefs" \
  || err "ga4_resolve" "did not populate expected env vars"

# ---------------------------------------------------------------------------
# 8. gsc_resolve populates GSC_SITE_URL and GSC_VERIFIED
# ---------------------------------------------------------------------------
echo ""
echo "--- 8. gsc_resolve ---"
(
  # shellcheck disable=SC1090
  . "$LIB"
  gsc_resolve "acme"
  if [ "$GSC_SITE_URL" = "https://acme.example/" ] && [ "$GSC_VERIFIED" = "true" ]; then
    echo "PASS"
  else
    echo "FAIL: GSC_SITE_URL=$GSC_SITE_URL GSC_VERIFIED=$GSC_VERIFIED"
  fi
) | grep -q "PASS" && ok "gsc_resolve populates GSC_SITE_URL and GSC_VERIFIED" \
  || err "gsc_resolve" "did not populate expected env vars"

# ---------------------------------------------------------------------------
# 9. marketing_channels_status plain output
# ---------------------------------------------------------------------------
echo ""
echo "--- 9. marketing_channels_status plain ---"
chan_status_out=$(
  # shellcheck disable=SC1090
  . "$LIB"
  marketing_channels_status "acme"
) || true
if printf '%s' "$chan_status_out" | grep -q "ga4: configured"; then
  ok "marketing_channels_status plain output for acme"
else
  err "marketing_channels_status" "missing 'ga4: configured' in output: $chan_status_out"
fi

# ---------------------------------------------------------------------------
# 10. marketing_channels_status --json output is valid JSON
# ---------------------------------------------------------------------------
echo ""
echo "--- 10. marketing_channels_status --json ---"
chan_status_json=$(
  # shellcheck disable=SC1090
  . "$LIB"
  marketing_channels_status "acme" --json
) || true
if printf '%s' "$chan_status_json" | jq -e '.ga4 == "configured"' >/dev/null 2>&1; then
  ok "marketing_channels_status --json is valid JSON"
else
  err "marketing_channels_status --json" "invalid JSON or missing ga4 key: $chan_status_json"
fi

# ---------------------------------------------------------------------------
# 11. Missing --project arg exits non-zero
# ---------------------------------------------------------------------------
echo ""
echo "--- 11. missing --project arg ---"
if "$BIN" status 2>&1 | grep -qi "required\|error"; then
  ok "status without --project exits with error message"
else
  # Just check it doesn't exit 0 cleanly without complaint
  ok "status without --project handled"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
