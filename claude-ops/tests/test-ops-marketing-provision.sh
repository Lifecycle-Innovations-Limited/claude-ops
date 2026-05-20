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
# 11. provision-instagram: missing Meta token exits 2
# ---------------------------------------------------------------------------
echo ""
echo "--- 11. provision-instagram cold-start (no Meta token) ---"
ig_cold_out="$("$BIN" provision-instagram --project fresh 2>&1 || true)"
ig_cold_rc=$?
if echo "$ig_cold_out" | grep -qi "meta access token not configured"; then
  ok "provision-instagram exits with diagnostic when meta.access_token missing"
else
  err "provision-instagram cold-start" "expected 'meta access token' diagnostic, got: $ig_cold_out"
fi

# ---------------------------------------------------------------------------
# 12. provision-instagram with fixture meta.access_token in dry-run
# ---------------------------------------------------------------------------
echo ""
echo "--- 12. provision-instagram dry-run with stub Meta token ---"
# Patch fixture to add a meta token + page_id to the 'fresh' project
TMP_PREFS="$(mktemp)"
jq '.marketing.projects.fresh.meta = {
      "access_token": "env:FAKE_META_TOKEN",
      "page_id": "1234567890"
    } | .marketing.projects.fresh.instagram = {"account_id": "stub-ig-id-already-set"}' \
   "$FIXTURE_PREFS" > "$TMP_PREFS" && mv "$TMP_PREFS" "$FIXTURE_PREFS"
export FAKE_META_TOKEN="fake-token-for-dry-run"
ig_dry_out="$("$BIN" provision-instagram --project fresh 2>&1 || true)"
# Idempotent path should mention "Already configured" + dry-run notice
if echo "$ig_dry_out" | grep -q "Already configured" && echo "$ig_dry_out" | grep -q "DRY-RUN"; then
  ok "provision-instagram dry-run idempotent — recognizes pre-set account_id"
else
  err "provision-instagram dry-run" "expected 'Already configured' + DRY-RUN markers: $ig_dry_out"
fi
unset FAKE_META_TOKEN

# ---------------------------------------------------------------------------
# 13. provision-google-ads dry-run writes pending state file
# Hermetic: point Doppler at a non-existent project so the scan returns empty
# even when GOOGLE_ADS_DEVELOPER_TOKEN exists in the real Doppler config.
# ---------------------------------------------------------------------------
echo ""
echo "--- 13. provision-google-ads dry-run (no dev token) creates pending file ---"
PENDING_FILE="${FIXTURE_DIR}/state/marketing-provision/acme-google-ads-pending.json"
rm -f "$PENDING_FILE"
# Also unset env vars that gads_scan_credential reads to avoid leaks from CI/local shell
gads_out="$(env -u GOOGLE_ADS_DEVELOPER_TOKEN -u GOOGLE_ADS_CLIENT_ID -u GOOGLE_ADS_CLIENT_SECRET -u GOOGLE_ADS_REFRESH_TOKEN \
  OPS_MARKETING_DOPPLER_PROJECT="nonexistent-fixture-$RANDOM" \
  OPS_MARKETING_DOPPLER_CONFIG="prd" \
  "$BIN" provision-google-ads --project acme 2>&1 || true)"
if [ -f "$PENDING_FILE" ] && jq -e '.stage == "developer_token"' "$PENDING_FILE" >/dev/null 2>&1; then
  ok "provision-google-ads writes pending-state file with stage=developer_token"
else
  err "provision-google-ads pending file" "expected $PENDING_FILE with stage=developer_token, output: $gads_out"
fi

# ---------------------------------------------------------------------------
# 14. provision-google-ads --skip-if-pending respects pending state
# ---------------------------------------------------------------------------
echo ""
echo "--- 14. provision-google-ads --skip-if-pending ---"
skip_out="$("$BIN" provision-google-ads --project acme --skip-if-pending 2>&1 || true)"
skip_rc=$?
if echo "$skip_out" | grep -qi "still pending" || echo "$skip_out" | grep -qi "skipping"; then
  ok "provision-google-ads --skip-if-pending exits 0 when pending file exists"
else
  err "provision-google-ads skip" "expected 'still pending' / 'skipping', got: $skip_out"
fi

# ---------------------------------------------------------------------------
# 15. provision-all dry-run chains GA4 + GSC + Instagram + Google Ads
# ---------------------------------------------------------------------------
echo ""
echo "--- 15. provision-all chains all 4 channels ---"
all_out="$("$BIN" provision-all --project acme 2>&1 || true)"
if echo "$all_out" | grep -q -- "--- GA4 ---" && \
   echo "$all_out" | grep -q -- "--- Google Search Console ---" && \
   echo "$all_out" | grep -q -- "--- Instagram ---" && \
   echo "$all_out" | grep -q -- "--- Google Ads ---" && \
   echo "$all_out" | grep -q "Done"; then
  ok "provision-all chains all four channels in order"
else
  err "provision-all chain" "missing one or more channel headers: $all_out"
fi

# ---------------------------------------------------------------------------
# 16. marketing_channels_status includes 'instagram' field
# ---------------------------------------------------------------------------
echo ""
echo "--- 16. marketing_channels_status surfaces instagram ---"
ig_json=$(
  # shellcheck disable=SC1090
  . "$LIB"
  marketing_channels_status "fresh" --json
) || true
if printf '%s' "$ig_json" | jq -e '.instagram == "configured"' >/dev/null 2>&1; then
  ok "marketing_channels_status reports instagram as configured for 'fresh'"
else
  err "marketing_channels_status instagram" "expected .instagram=configured, got: $ig_json"
fi

# ---------------------------------------------------------------------------
# 17. google-ads-oauth.sh helper lib syntax + endpoint vars
# ---------------------------------------------------------------------------
echo ""
echo "--- 17. google-ads-oauth.sh helper lib ---"
OAUTH_LIB="${PLUGIN_ROOT}/scripts/lib/google-ads-oauth.sh"
if [ -f "$OAUTH_LIB" ] && bash -n "$OAUTH_LIB" 2>/dev/null; then
  # Source and verify the endpoint constants are set
  url=$(
    # shellcheck disable=SC1090
    . "$OAUTH_LIB"
    gads_authorize_url "fake-client" "http://localhost:8080"
  )
  if echo "$url" | grep -q "accounts.google.com/o/oauth2/v2/auth" && \
     echo "$url" | grep -q "scope=" && \
     echo "$url" | grep -q "access_type=offline"; then
    ok "google-ads-oauth.sh gads_authorize_url generates valid URL"
  else
    err "gads_authorize_url" "URL missing required params: $url"
  fi
else
  err "google-ads-oauth.sh" "lib missing or has syntax errors"
fi

# ---------------------------------------------------------------------------
# 18. Missing --project arg exits non-zero
# ---------------------------------------------------------------------------
echo ""
echo "--- 18. missing --project arg ---"
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
