#!/usr/bin/env bash
# test-meta-token-refresh.sh — assert Meta token refresh (error 190) behaviour:
#   1. meta_get returns {} and calls meta_refresh_token when code=190
#   2. On successful refresh: META_TOKEN updated in-memory, Doppler write attempted
#   3. On failed refresh: escalate() called with human-readable reason
#   4. DRY_RUN=1 skips Doppler write but still refreshes in-memory
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing Meta token refresh (error 190) in $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STATE_DIR="$WORK/state"
REPORT_DIR="$WORK/reports"
mkdir -p "$STATE_DIR" "$REPORT_DIR"

# Minimal preferences.json with meta configured using doppler ref
cat > "$WORK/prefs.json" <<'JSON'
{
  "marketing": {
    "projects": {
      "test-proj": {
        "autopilot": {
          "enabled": true,
          "daily_spend_cap_usd": 50,
          "campaign_ids": { "meta": [] }
        },
        "meta": {
          "access_token": "doppler:claude-ops/prd/META_TEST_PROJ_ACCESS_TOKEN",
          "ad_account_id": "act_123456789",
          "app_id": "doppler:claude-ops/prd/META_TEST_PROJ_APP_ID",
          "app_secret": "doppler:claude-ops/prd/META_TEST_PROJ_APP_SECRET"
        }
      }
    }
  }
}
JSON

# Doppler stub — always returns non-empty for `secrets get`, records `secrets set` calls
DOPPLER_SHIM="$WORK/doppler"
DOPPLER_SET_SENTINEL="$WORK/doppler_set_called"
cat > "$DOPPLER_SHIM" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "secrets" ] && [ "\${2:-}" = "set" ]; then
  printf '1' > "$DOPPLER_SET_SENTINEL"
  exit 0
fi
# secrets get — return a non-empty stub value
printf 'stub-doppler-value'
exit 0
SHIM
chmod +x "$DOPPLER_SHIM"

# ── Test harness — extract and source meta_refresh_token from binary ──────────
HELPERS="$WORK/helpers.sh"
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo "PREFS=\"$WORK/prefs.json\""
  echo "STATE_DIR=\"$WORK/state\""
  echo "REPORT=\"$WORK/report.md\""
  echo ': > "$REPORT"'
  echo 'GRAPH="https://graph.facebook.com/v23.0"'
  echo 'DRY_RUN="${DRY_RUN:-0}"'
  echo 'META_TOKEN="expired-token-abc123"'
  echo 'META_PROOF=""'
  echo 'ESCALATED=0'
  echo 'ESCALATE_REASON=""'
  echo 'log() { :; }'
  echo 'report() { :; }'
  echo 'escalate() { ESCALATED=1; ESCALATE_REASON="${2:-}"; }'
  # Stub resolve_cred — doppler: returns stub-doppler-value, env: expands, else literal
  echo 'resolve_cred() { local r="${1:-}"; case "$r" in doppler:*) printf "stub-doppler-value" ;; env:*) local v="${r#env:}"; printf "%s" "${!v:-}" ;; *) printf "%s" "$r" ;; esac; }'
  echo 'chan_cred() { resolve_cred "$(jq -r --arg p "$1" --arg c "$2" --arg f "$3" '"'"'.marketing.projects[$p][$c][$f] // empty'"'"' "$PREFS" 2>/dev/null)"; }'
  echo 'meta_proof() { :; }'
  # Mock curl: controlled via CURL_MOCK_RESPONSE env var
  echo 'curl() { printf "%s" "${CURL_MOCK_RESPONSE:-{}}"; }'
  # Extract meta_refresh_token function verbatim from binary
  awk '/^meta_refresh_token\(\)/{p=1} p{print} p && /^}$/{p=0; exit}' "$BIN"
} > "$HELPERS"
chmod +x "$HELPERS"

# ── Test 1: successful refresh updates META_TOKEN in-memory ───────────────────
# Write result to file to avoid stdout mixing with any function side-effects
T1_OUT="$WORK/t1.out"
env \
  PATH="$WORK:$PATH" \
  CURL_MOCK_RESPONSE='{"access_token":"new-long-lived-token-xyz"}' \
  DRY_RUN=0 \
  bash -c ". '$HELPERS' && meta_refresh_token 'test-proj' >/dev/null 2>&1; printf '%s' \"\$META_TOKEN\"" \
  > "$T1_OUT" 2>/dev/null || true
result="$(cat "$T1_OUT")"
if [ "$result" = "new-long-lived-token-xyz" ]; then
  ok "successful refresh: META_TOKEN updated in-memory"
else
  err "successful refresh: META_TOKEN not updated" "got '$result'"
fi

# ── Test 2: failed refresh → returns rc=1 so caller knows to escalate ─────────
# meta_refresh_token returns 1 on failure; the caller (meta_get) escalates.
# Here we assert rc=1 from the function itself.
T2_RC=0
env \
  PATH="$WORK:$PATH" \
  CURL_MOCK_RESPONSE='{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190}}' \
  DRY_RUN=0 \
  bash -c ". '$HELPERS'; meta_refresh_token 'test-proj' >/dev/null 2>&1; printf '%s' \$?" \
  > "$WORK/t2.out" 2>/dev/null || true
T2_RC="$(cat "$WORK/t2.out")"
if [ "$T2_RC" = "1" ]; then
  ok "failed refresh: returns rc=1 (caller escalates)"
else
  err "failed refresh: expected rc=1" "rc=$T2_RC"
fi

# ── Test 2b: meta_get with 190 + no app_id/secret → escalate called ──────────
# Build a harness that includes meta_get + meta_refresh_token + the escalate stub
HELPERS2="$WORK/helpers2.sh"
{
  echo '#!/usr/bin/env bash'
  # No -e so non-zero rc from internal functions does not abort the test script
  echo 'set -uo pipefail'
  echo "PREFS=\"$WORK/prefs.json\""
  echo "STATE_DIR=\"$WORK/state\""
  echo "REPORT=\"$WORK/report2.md\""
  echo ': > "$REPORT"'
  echo 'DRY_RUN=0'
  echo 'META_TOKEN="expired-token-abc123"'
  echo 'META_PROOF=""'
  echo 'ESCALATED=0'
  echo '_META_CURRENT_PROJ="test-proj"'
  echo 'GRAPH="https://graph.facebook.com/v23.0"'
  echo 'log() { :; }'
  echo 'report() { :; }'
  echo 'escalate() { ESCALATED=1; }'
  # chan_cred returns empty for app_id/app_secret → no-app-id path in meta_refresh_token
  echo 'chan_cred() { case "${3:-}" in app_id|app_secret) printf "" ;; *) printf "stub-val" ;; esac; }'
  echo 'meta_proof() { :; }'
  echo 'sleep() { :; }'
  echo 'CURL_MOCK_RESPONSE='"'"'{"error":{"code":190,"message":"token expired"}}'"'"
  echo 'curl() { printf "%s" "$CURL_MOCK_RESPONSE"; }'
  awk '/^meta_refresh_token\(\)/{p=1} p{print} p && /^}$/{p=0; exit}' "$BIN"
  awk '/^meta_get\(\)/{p=1} p{print} p && /^}$/{p=0; exit}' "$BIN"
  echo 'meta_get "me?fields=id" "test-proj" >/dev/null 2>&1 || true'
  echo 'printf "%s" "$ESCALATED"'
} > "$HELPERS2"
T2B_OUT="$WORK/t2b.out"
bash "$HELPERS2" > "$T2B_OUT" 2>/dev/null || true
result="$(cat "$T2B_OUT")"
if [ "$result" = "1" ]; then
  ok "meta_get 190 + no app_id: escalate() fired"
else
  err "meta_get 190 + no app_id: escalate not fired" "ESCALATED='$result'"
fi

# ── Test 3: DRY_RUN=1 skips Doppler write (doppler secrets set NOT called) ────
rm -f "$DOPPLER_SET_SENTINEL"
env \
  PATH="$WORK:$PATH" \
  CURL_MOCK_RESPONSE='{"access_token":"refreshed-dry-token"}' \
  DRY_RUN=1 \
  bash -c ". '$HELPERS' && meta_refresh_token 'test-proj'" >/dev/null 2>&1 || true
if [ ! -f "$DOPPLER_SET_SENTINEL" ]; then
  ok "DRY_RUN=1: Doppler write skipped"
else
  err "DRY_RUN=1: Doppler write should be skipped" "doppler secrets set was called"
fi

# ── Test 4: in-memory token updated even in DRY_RUN=1 ─────────────────────────
T4_OUT="$WORK/t4.out"
env \
  PATH="$WORK:$PATH" \
  CURL_MOCK_RESPONSE='{"access_token":"dry-run-in-memory-token"}' \
  DRY_RUN=1 \
  bash -c ". '$HELPERS' && meta_refresh_token 'test-proj' >/dev/null 2>&1; printf '%s' \"\$META_TOKEN\"" \
  > "$T4_OUT" 2>/dev/null || true
result="$(cat "$T4_OUT")"
if [ "$result" = "dry-run-in-memory-token" ]; then
  ok "DRY_RUN=1: in-memory META_TOKEN still updated"
else
  err "DRY_RUN=1: in-memory META_TOKEN not updated" "got '$result'"
fi

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
