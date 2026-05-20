#!/usr/bin/env bash
# tests/test-ops-marketing-link-prewarm.sh — hermetic tests for ops-marketing-link-prewarm
#
# PUBLIC REPO: no real project names, tokens, or paths.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${REPO_ROOT}/bin/ops-marketing-link-prewarm"

PASS=0
FAIL=0

_pass() { echo "  PASS: $1"; (( PASS++ )) || true; }
_fail() { echo "  FAIL: $1"; (( FAIL++ )) || true; }

# ── test setup ────────────────────────────────────────────────────────────────
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

FAKE_CACHE="${TMPDIR_TEST}/marketing-auth-prewarm.json"
FAKE_PREFS="${TMPDIR_TEST}/preferences.json"

# Minimal prewarm cache with test-fixture project
cat > "$FAKE_CACHE" <<'EOF'
{
  "generated_at": "2026-01-01T04:23:00Z",
  "by_project": {
    "test-fixture": {
      "analytics_ga4": [
        {"key": "property_id", "project": "test-fixture", "config": "prd"}
      ],
      "payments_stripe": [
        {"key": "secret_key", "project": "test-fixture", "config": "prd"}
      ],
      "analytics_amplitude": [
        {"key": "api_key", "project": "test-fixture", "config": "prd"}
      ],
      "ads_meta": [
        {"key": "access_token", "project": "test-fixture", "config": "prd"},
        {"key": "ad_account_id", "project": "test-fixture", "config": "prd"}
      ]
    }
  }
}
EOF

# Minimal prefs with empty marketing section
cat > "$FAKE_PREFS" <<'EOF'
{
  "marketing": {
    "projects": {}
  }
}
EOF

# ── test 1: dry-run prints planned writes, does NOT modify prefs ──────────────
echo "test 1: dry-run does not modify prefs"
prefs_before="$(cat "$FAKE_PREFS")"
out="$(OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" OPS_MARKETING_DRY_RUN=1 \
  "$BIN" --project test-fixture 2>&1)"
prefs_after="$(cat "$FAKE_PREFS")"

if echo "$out" | grep -q "\[would set\]"; then
  _pass "dry-run output contains [would set] lines"
else
  _fail "dry-run output missing [would set] lines (got: $out)"
fi

if [[ "$prefs_before" == "$prefs_after" ]]; then
  _pass "dry-run did not modify preferences.json"
else
  _fail "dry-run modified preferences.json"
fi

if echo "$out" | grep -q "test-fixture.ga4.property_id"; then
  _pass "dry-run shows ga4.property_id mapping"
else
  _fail "dry-run missing ga4.property_id mapping (got: $out)"
fi

if echo "$out" | grep -q "test-fixture.stripe.secret_key"; then
  _pass "dry-run shows stripe.secret_key mapping"
else
  _fail "dry-run missing stripe.secret_key mapping (got: $out)"
fi

# ── test 2: --dry-run flag equivalent to env var ─────────────────────────────
echo "test 2: --dry-run flag"
out2="$(OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --project test-fixture --dry-run 2>&1)"
if echo "$out2" | grep -q "\[would set\]"; then
  _pass "--dry-run flag produces [would set] output"
else
  _fail "--dry-run flag did not produce [would set] output (got: $out2)"
fi

# ── test 3: live run writes prefs atomically ──────────────────────────────────
echo "test 3: live run writes prefs"
OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --project test-fixture > /dev/null 2>&1

ga4_val="$(jq -r '.marketing.projects["test-fixture"].ga4.property_id // "null"' "$FAKE_PREFS" 2>/dev/null)"
stripe_val="$(jq -r '.marketing.projects["test-fixture"].stripe.secret_key // "null"' "$FAKE_PREFS" 2>/dev/null)"
amplitude_val="$(jq -r '.marketing.projects["test-fixture"].amplitude.api_key // "null"' "$FAKE_PREFS" 2>/dev/null)"
meta_val="$(jq -r '.marketing.projects["test-fixture"].meta.access_token // "null"' "$FAKE_PREFS" 2>/dev/null)"

if [[ "$ga4_val" == "doppler:test-fixture/prd/property_id" ]]; then
  _pass "ga4.property_id written as doppler cred-ref"
else
  _fail "ga4.property_id wrong value: ${ga4_val}"
fi

if [[ "$stripe_val" == "doppler:test-fixture/prd/secret_key" ]]; then
  _pass "stripe.secret_key written as doppler cred-ref"
else
  _fail "stripe.secret_key wrong value: ${stripe_val}"
fi

if [[ "$amplitude_val" == "doppler:test-fixture/prd/api_key" ]]; then
  _pass "amplitude.api_key written as doppler cred-ref"
else
  _fail "amplitude.api_key wrong value: ${amplitude_val}"
fi

if [[ "$meta_val" == "doppler:test-fixture/prd/access_token" ]]; then
  _pass "meta.access_token written as doppler cred-ref"
else
  _fail "meta.access_token wrong value: ${meta_val}"
fi

# ── test 4: idempotency — re-run is a no-op ───────────────────────────────────
echo "test 4: idempotency"
prefs_after_first="$(cat "$FAKE_PREFS")"
OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --project test-fixture > /dev/null 2>&1
prefs_after_second="$(cat "$FAKE_PREFS")"

if [[ "$prefs_after_first" == "$prefs_after_second" ]]; then
  _pass "second run is a no-op (idempotent)"
else
  _fail "second run modified prefs (not idempotent)"
fi

# ── test 5: --category filter only links requested category ──────────────────
echo "test 5: --category filter"
# Reset prefs
cat > "$FAKE_PREFS" <<'EOF'
{"marketing":{"projects":{}}}
EOF
OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --project test-fixture --category analytics_ga4 > /dev/null 2>&1

ga4_after="$(jq -r '.marketing.projects["test-fixture"].ga4.property_id // "null"' "$FAKE_PREFS" 2>/dev/null)"
stripe_after="$(jq -r '.marketing.projects["test-fixture"].stripe.secret_key // "null"' "$FAKE_PREFS" 2>/dev/null)"

if [[ "$ga4_after" != "null" ]]; then
  _pass "--category analytics_ga4 writes ga4 slot"
else
  _fail "--category analytics_ga4 did not write ga4 slot"
fi

if [[ "$stripe_after" == "null" ]]; then
  _pass "--category analytics_ga4 skips stripe slot"
else
  _fail "--category analytics_ga4 incorrectly wrote stripe slot"
fi

# ── test 6: missing cache exits with error ────────────────────────────────────
echo "test 6: missing cache exits non-zero"
if ! OPS_DATA_DIR="/nonexistent_dir_$$" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --project test-fixture > /dev/null 2>&1; then
  _pass "missing cache exits non-zero"
else
  _fail "missing cache should have exited non-zero"
fi

# ── test 7: --all-projects links all prewarm projects ────────────────────────
echo "test 7: --all-projects"
# Add a second project to prewarm cache
jq '.by_project["second-fixture"] = {
  "payments_stripe": [{"key": "secret_key", "project": "second-fixture", "config": "prd"}]
}' "$FAKE_CACHE" > "${FAKE_CACHE}.tmp" && mv "${FAKE_CACHE}.tmp" "$FAKE_CACHE"

cat > "$FAKE_PREFS" <<'EOF'
{"marketing":{"projects":{}}}
EOF

OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
  "$BIN" --all-projects > /dev/null 2>&1

second_stripe="$(jq -r '.marketing.projects["second-fixture"].stripe.secret_key // "null"' "$FAKE_PREFS" 2>/dev/null)"
if [[ "$second_stripe" == "doppler:second-fixture/prd/secret_key" ]]; then
  _pass "--all-projects links second project"
else
  _fail "--all-projects did not link second project: ${second_stripe}"
fi

# ── test 8: skip if lib files missing (graceful) ─────────────────────────────
echo "test 8: graceful if lib deps not present (portfolio --prewarm-status)"
PORTFOLIO="${REPO_ROOT}/bin/ops-marketing-portfolio"
if [[ -f "$PORTFOLIO" ]]; then
  out="$(OPS_DATA_DIR="$TMPDIR_TEST" PREFS_PATH="$FAKE_PREFS" \
    "$PORTFOLIO" --prewarm-status 2>&1)"
  if [[ $? -eq 0 ]]; then
    _pass "portfolio --prewarm-status exits 0 with fake cache"
  else
    _fail "portfolio --prewarm-status exited non-zero"
  fi
else
  echo "  SKIP: ops-marketing-portfolio not found (other agent in-flight)"
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
