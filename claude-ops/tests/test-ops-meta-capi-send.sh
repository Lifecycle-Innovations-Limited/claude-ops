#!/usr/bin/env bash
# test-ops-meta-capi-send.sh — Smoke tests for bin/ops-meta-capi-send
#
# Hermetic: OPS_DRY_RUN=1 throughout — zero network calls.
# Asserts payload shape, SHA-256 hashing of em/ph, and credential wiring.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-meta-capi-send"

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

# Expected SHA-256 hashes for known test inputs (lowercase-normalised)
# echo -n "user@example.com" | shasum -a 256 | awk '{print $1}'
EXPECTED_EMAIL_HASH="b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514"
# echo -n "+15551234567" | shasum -a 256 | awk '{print $1}'
EXPECTED_PHONE_HASH="$(printf '%s' '+15551234567' | shasum -a 256 | awk '{print $1}')"

# ── 1. Missing subcommand → non-zero ─────────────────────────────────────────
set +e; "$BIN" 2>/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "no subcommand exits non-zero" || err "no subcommand" "expected non-zero"

# ── 2. --help exits 1 ─────────────────────────────────────────────────────────
set +e; "$BIN" --help 2>/dev/null; rc=$?; set -e
[ "$rc" -eq 1 ] && ok "--help exits 1" || err "--help" "expected exit 1, got $rc"

# ── 3. event missing --project → non-zero ────────────────────────────────────
set +e
"$BIN" event --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null
rc=$?; set -e
[ "$rc" -ne 0 ] && ok "event missing --project exits non-zero" || err "missing --project" "expected non-zero"

# ── 4. event missing prefs → non-zero ────────────────────────────────────────
rm -f "$OPS_CONVERSION_PREFS"
set +e
"$BIN" event --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null
rc=$?; set -e
[ "$rc" -ne 0 ] && ok "event missing prefs exits non-zero" || err "missing prefs" "expected non-zero"

# ── 5. event missing pixel_id → non-zero ─────────────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": { "meta": {} } } } }
JSON
set +e
"$BIN" event --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null
rc=$?; set -e
[ "$rc" -ne 0 ] && ok "event empty pixel_id exits non-zero" || err "empty pixel_id" "expected non-zero"

# ── 6. event missing access_token → non-zero ─────────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": { "meta": { "pixel_id": "<YOUR_PIXEL_ID>" } } } } }
JSON
set +e
"$BIN" event --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null
rc=$?; set -e
[ "$rc" -ne 0 ] && ok "event empty access_token exits non-zero" || err "empty access_token" "expected non-zero"

# ── Write valid prefs for remaining tests ─────────────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": {
  "meta": {
    "pixel_id": "<YOUR_PIXEL_ID>",
    "access_token": "test-access-token-placeholder"
  }
} } } }
JSON

# ── 7. dry-run Purchase event → exit 0, correct shape ────────────────────────
output="$("$BIN" event \
  --project testproj \
  --event-name Purchase \
  --event-time 1716000000 \
  --action-source website \
  --event-source-url "https://<your-domain.com>" \
  --value 49.99 --currency USD 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "dry-run exits 0" || err "dry-run exit" "rc=$rc"
echo "$output" | grep -q '\[DRY RUN\]' \
  && ok "output contains [DRY RUN]" || err "dry-run marker" "missing [DRY RUN]"
echo "$output" | grep -q '"event_name":"Purchase"' \
  && ok "payload contains event_name=Purchase" || err "event_name" "not in payload"
echo "$output" | grep -q '"event_time":1716000000' \
  && ok "payload contains event_time" || err "event_time" "not in payload"
echo "$output" | grep -q '"action_source":"website"' \
  && ok "payload contains action_source" || err "action_source" "not in payload"
echo "$output" | grep -q '"value":49.99' \
  && ok "payload contains value 49.99" || err "value" "not in payload"
echo "$output" | grep -q '"currency":"USD"' \
  && ok "payload contains currency USD" || err "currency" "not in payload"
echo "$output" | grep -q 'access_token=<redacted>' \
  && ok "access_token is redacted in output" || err "access_token redaction" "not redacted"

# ── 8. SHA-256 hashing of email ───────────────────────────────────────────────
output="$("$BIN" event \
  --project testproj \
  --event-name Purchase \
  --event-time 1716000000 \
  --action-source website \
  --event-source-url "https://<your-domain.com>" \
  --email "user@example.com" 2>/dev/null)"
echo "$output" | grep -q "user_data.em: ${EXPECTED_EMAIL_HASH}" \
  && ok "email SHA-256 hash correct (${EXPECTED_EMAIL_HASH:0:16}...)" \
  || err "email SHA-256 hash" "expected ${EXPECTED_EMAIL_HASH:0:16}... got: $(echo "$output" | grep 'user_data.em' | head -1)"

# ── 9. SHA-256 hashing of phone ───────────────────────────────────────────────
output="$("$BIN" event \
  --project testproj \
  --event-name Purchase \
  --event-time 1716000000 \
  --action-source website \
  --event-source-url "https://<your-domain.com>" \
  --phone "+15551234567" 2>/dev/null)"
echo "$output" | grep -q "user_data.ph: ${EXPECTED_PHONE_HASH}" \
  && ok "phone SHA-256 hash correct (${EXPECTED_PHONE_HASH:0:16}...)" \
  || err "phone SHA-256 hash" "expected ${EXPECTED_PHONE_HASH:0:16}... got: $(echo "$output" | grep 'user_data.ph' | head -1)"

# ── 10. SHA-256: uppercase email normalised before hashing ───────────────────
output_lower="$("$BIN" event \
  --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" \
  --email "user@example.com" 2>/dev/null)"
output_upper="$("$BIN" event \
  --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" \
  --email "USER@EXAMPLE.COM" 2>/dev/null)"
hash_lower="$(echo "$output_lower" | grep 'user_data.em:' | awk '{print $NF}')"
hash_upper="$(echo "$output_upper" | grep 'user_data.em:' | awk '{print $NF}')"
[ "$hash_lower" = "$hash_upper" ] && [ -n "$hash_lower" ] \
  && ok "uppercase email normalised to same hash as lowercase" \
  || err "case normalisation" "lower='$hash_lower' upper='$hash_upper'"

# ── 11. fbp / fbc forwarded into user_data ───────────────────────────────────
output="$("$BIN" event \
  --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" \
  --fbp "fb.1.1234567890.987654321" \
  --fbc "fb.1.1234567890.AbCdEfGhIjKlMnOp" 2>/dev/null)"
echo "$output" | grep -q '"fbp":"fb.1.1234567890.987654321"' \
  && ok "fbp forwarded into user_data" || err "fbp" "not in payload"
echo "$output" | grep -q '"fbc":"fb.1.1234567890.AbCdEfGhIjKlMnOp"' \
  && ok "fbc forwarded into user_data" || err "fbc" "not in payload"

# ── 12. client_ip and user_agent in user_data ────────────────────────────────
output="$("$BIN" event \
  --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" \
  --client-ip "203.0.113.1" \
  --user-agent "Mozilla/5.0 (compatible; test)" 2>/dev/null)"
echo "$output" | grep -q '"client_ip_address":"203.0.113.1"' \
  && ok "client_ip in user_data" || err "client_ip" "not in payload"
echo "$output" | grep -q '"client_user_agent":"Mozilla/5.0 (compatible; test)"' \
  && ok "user_agent in user_data" || err "user_agent" "not in payload"

# ── 13. test_event_code injected when set in prefs ────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "testproj": {
  "meta": {
    "pixel_id": "<YOUR_PIXEL_ID>",
    "access_token": "test-access-token-placeholder",
    "test_event_code": "TEST12345"
  }
} } } }
JSON
output="$("$BIN" event \
  --project testproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null)"
echo "$output" | grep -q '"test_event_code":"TEST12345"' \
  && ok "test_event_code injected from prefs" || err "test_event_code" "not in payload"

# ── 14. env: cred ref for access_token ───────────────────────────────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "envproj": {
  "meta": {
    "pixel_id": "env:TEST_META_PIXEL",
    "access_token": "env:TEST_META_TOKEN"
  }
} } } }
JSON
export TEST_META_PIXEL="<YOUR_PIXEL_ID>"
export TEST_META_TOKEN="env-token-placeholder"
output="$("$BIN" event \
  --project envproj --event-name Purchase --event-time 1716000000 \
  --action-source website --event-source-url "https://<your-domain.com>" 2>/dev/null)"
echo "$output" | grep -q 'access_token=<redacted>' \
  && ok "env: ref for access_token resolved (and redacted)" || err "env: access_token" "not resolved or not redacted"
unset TEST_META_PIXEL TEST_META_TOKEN

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
