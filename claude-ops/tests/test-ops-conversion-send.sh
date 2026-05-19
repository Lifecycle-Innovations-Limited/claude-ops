#!/usr/bin/env bash
# test-ops-conversion-send.sh — Smoke tests for bin/ops-conversion-send
#
# Hermetic: OPS_DRY_RUN=1 throughout — zero network calls.
# Asserts planned curl shape, flag validation, and credential wiring.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-conversion-send"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export OPS_DATA_DIR="$WORK/data"
export OPS_DRY_RUN=1
export OPS_CONVERSION_PREFS="$WORK/preferences.json"
mkdir -p "$OPS_DATA_DIR"

write_prefs() { cat > "$OPS_CONVERSION_PREFS"; }

# ── 1. Missing subcommand → non-zero ─────────────────────────────────────────
set +e; "$BIN" 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "no subcommand exits non-zero" || err "no subcommand" "expected non-zero"

# ── 2. --help exits 1 without crash ──────────────────────────────────────────
set +e; "$BIN" --help 2>/dev/null; rc=$?; set -e
[ "$rc" -eq 1 ] && ok "--help exits 1" || err "--help" "expected exit 1, got $rc"

# ── 3. ga4 missing --project → non-zero ──────────────────────────────────────
set +e; "$BIN" ga4 --event purchase --client-id abc123 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "ga4 missing --project exits non-zero" || err "ga4 missing --project" "expected non-zero"

# ── 4. ga4 missing prefs file → non-zero ─────────────────────────────────────
rm -f "$OPS_CONVERSION_PREFS"
set +e; "$BIN" ga4 --project testproj --event purchase --client-id abc123 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "ga4 missing prefs exits non-zero" || err "ga4 missing prefs" "expected non-zero"

# ── 5. ga4 dry-run: measurement_id not set → non-zero ────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": { "ga4": {} } } } }
JSON
set +e; "$BIN" ga4 --project testproj --event purchase --client-id abc123 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "ga4 empty measurement_id exits non-zero" || err "ga4 empty measurement_id" "expected non-zero"

# ── 6. ga4 dry-run: api_secret not set → non-zero ────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": { "ga4": { "measurement_id": "G-XXXXXXXXXX" } } } } }
JSON
set +e; "$BIN" ga4 --project testproj --event purchase --client-id abc123 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "ga4 empty api_secret exits non-zero" || err "ga4 empty api_secret" "expected non-zero"

# ── 7. ga4 dry-run: valid prefs → exit 0, correct output shape ───────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": {
  "ga4": {
    "measurement_id": "G-XXXXXXXXXX",
    "api_secret": "test-api-secret-placeholder"
  }
} } } }
JSON

output="$("$BIN" ga4 --project testproj --event purchase --client-id abc123 \
  --value 49.99 --currency USD --transaction-id tx_test_001 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "ga4 dry-run exits 0" || err "ga4 dry-run exit" "rc=$rc"
echo "$output" | grep -q '\[DRY RUN\]' \
  && ok "output contains [DRY RUN]" || err "dry-run marker" "missing [DRY RUN]"
echo "$output" | grep -q 'measurement_id=G-XXXXXXXXXX' \
  && ok "output contains measurement_id" || err "measurement_id" "not in output"
echo "$output" | grep -q 'api_secret=<redacted>' \
  && ok "api_secret is redacted in output" || err "api_secret redaction" "api_secret not redacted"
echo "$output" | grep -q '"name":"purchase"' \
  && ok "output contains event name 'purchase'" || err "event name" "purchase not in payload"
echo "$output" | grep -q '"value":49.99' \
  && ok "output contains value 49.99" || err "value" "49.99 not in payload"
echo "$output" | grep -q '"currency":"USD"' \
  && ok "output contains currency USD" || err "currency" "USD not in payload"
echo "$output" | grep -q '"transaction_id":"tx_test_001"' \
  && ok "output contains transaction_id" || err "transaction_id" "tx_test_001 not in payload"

# ── 8. ga4 dry-run: sign_up event ────────────────────────────────────────────
output="$("$BIN" ga4 --project testproj --event sign_up --client-id abc123 2>/dev/null)"
echo "$output" | grep -q '"name":"sign_up"' \
  && ok "sign_up event name correct" || err "sign_up event" "name not in output"

# ── 9. ga4 dry-run: generate_lead event ──────────────────────────────────────
output="$("$BIN" ga4 --project testproj --event generate_lead --client-id abc123 2>/dev/null)"
echo "$output" | grep -q '"name":"generate_lead"' \
  && ok "generate_lead event name correct" || err "generate_lead event" "name not in output"

# ── 10. ga4 dry-run: add_to_cart event ───────────────────────────────────────
output="$("$BIN" ga4 --project testproj --event add_to_cart --client-id abc123 2>/dev/null)"
echo "$output" | grep -q '"name":"add_to_cart"' \
  && ok "add_to_cart event name correct" || err "add_to_cart event" "name not in output"

# ── 11. ga4 dry-run: user-id is included when provided ───────────────────────
output="$("$BIN" ga4 --project testproj --event purchase --client-id abc123 --user-id u_99 2>/dev/null)"
echo "$output" | grep -q '"user_id":"u_99"' \
  && ok "user_id present in payload" || err "user_id" "not in payload"

# ── 12. ga4 dry-run: --properties merges into params ─────────────────────────
output="$("$BIN" ga4 --project testproj --event purchase --client-id abc123 \
  --properties '{"campaign":"summer_v1_20260601"}' 2>/dev/null)"
echo "$output" | grep -q '"campaign":"summer_v1_20260601"' \
  && ok "--properties merged into event params" || err "--properties" "not in payload"

# ── 13. ga4 dry-run: env: cred ref resolved ──────────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "envproj": {
  "ga4": {
    "measurement_id": "env:TEST_GA4_MID",
    "api_secret": "env:TEST_GA4_SECRET"
  }
} } } }
JSON
export TEST_GA4_MID="G-ENVTEST00"
export TEST_GA4_SECRET="env-secret-placeholder"
output="$("$BIN" ga4 --project envproj --event purchase --client-id abc 2>/dev/null)"
echo "$output" | grep -q 'measurement_id=G-ENVTEST00' \
  && ok "env: ref for measurement_id resolved" || err "env: ref measurement_id" "not resolved"
unset TEST_GA4_MID TEST_GA4_SECRET

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
