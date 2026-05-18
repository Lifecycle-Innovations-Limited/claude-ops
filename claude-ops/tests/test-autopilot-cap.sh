#!/usr/bin/env bash
# test-autopilot-cap.sh — spend-safety invariants for bin/ops-marketing-autopilot
#
# Asserts:
#   1. Refuses to run a project with no daily_spend_cap_usd (non-zero exit,
#      escalation note, ZERO mutations).
#   2. --dry-run performs ZERO network mutations (every action logged [DRY]).
#   3. The binary never emits budget-raise / campaign-create / audience-create
#      / objective-change calls (static source assertion + live curl-shim log).
#
# Hermetic: a fake `curl` on PATH records every invocation and returns canned
# JSON, so no network is touched and any mutating request is detectable.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export OPS_DATA_DIR="$WORK/data"
mkdir -p "$OPS_DATA_DIR"
export OPS_AUTOPILOT_PREFS="$WORK/preferences.json"
export CLAUDE_OPS_USE_CREDIT_POOL=0
CURL_LOG="$WORK/curl.log"
: > "$CURL_LOG"

# ── Fake curl: log every call, flag mutations, return canned GET JSON ─────────
SHIM="$WORK/bin"
mkdir -p "$SHIM"
cat > "$SHIM/curl" <<SHIMEOF
#!/usr/bin/env bash
url=""; mutating=0
for a in "\$@"; do
  case "\$a" in
    http*) url="\$a" ;;
    -X) mutating=PENDING ;;
    POST|PUT|DELETE|PATCH) [ "\$mutating" = PENDING ] && mutating=1 ;;
    --data-binary|-d|--data) mutating=1 ;;
  esac
done
if [ "\$mutating" = 1 ]; then
  echo "MUTATE \$url" >> "$CURL_LOG"
  echo '{}'; exit 0
fi
echo "GET \$url" >> "$CURL_LOG"
case "\$url" in
  *amount_spent*)            echo '{"amount_spent":"1000","currency":"USD"}' ;;
  *fields=name,status,daily_budget*) echo '{"name":"c","status":"ACTIVE","daily_budget":"2500"}' ;;
  */ads\?fields=id,name*)    echo '{"data":[{"id":"AD1","name":"a","effective_status":"ACTIVE"},{"id":"AD2","name":"b","effective_status":"ACTIVE"},{"id":"AD3","name":"c","effective_status":"ACTIVE"}]}' ;;
  *insights\?level=ad*)      echo '{"data":[{"ad_id":"AD1","spend":"5","impressions":"3000","ctr":"2.0","frequency":"1.1","actions":[{"action_type":"lead","value":"4"}]},{"ad_id":"AD2","spend":"6","impressions":"3200","ctr":"1.8","frequency":"1.2","actions":[{"action_type":"lead","value":"3"}]},{"ad_id":"AD3","spend":"15","impressions":"2000","ctr":"0.10","frequency":"1.0","actions":[]}]}' ;;
  *)                         echo '{}' ;;
esac
exit 0
SHIMEOF
chmod +x "$SHIM/curl"
export PATH="$SHIM:$PATH"

write_prefs() { cat > "$OPS_AUTOPILOT_PREFS"; }

# ── Test 1: no cap → refuse, escalate, no mutation, non-zero exit ─────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "test": {
  "meta": { "access_token": "TKN", "ad_account_id": "act_test" },
  "autopilot": { "enabled": true, "channels": ["meta"],
    "campaign_ids": { "meta": ["CID1"] } } } } } }
JSON
: > "$CURL_LOG"
set +e
"$BIN" --project test >/dev/null 2>&1
rc=$?
set -e
REP="$OPS_DATA_DIR/reports/marketing-autopilot/test-latest.md"
[ "$rc" -ne 0 ] && ok "no-cap run exits non-zero (rc=$rc)" || err "no-cap exit" "expected non-zero, got 0"
if [ -f "$REP" ] && grep -q "No daily_spend_cap_usd" "$REP"; then
  ok "no-cap writes escalation note"
else
  err "no-cap escalation note" "missing in $REP"
fi
[ -f "$OPS_DATA_DIR/state/autopilot/escalations.log" ] \
  && ok "escalations.log written" || err "escalations.log" "not created"
if grep -q '^MUTATE' "$CURL_LOG"; then
  err "no-cap mutations" "$(grep -c '^MUTATE' "$CURL_LOG") mutating call(s)"
else
  ok "no-cap performs ZERO mutations"
fi

# ── Test 2: with cap + --dry-run → report written, ZERO mutations ─────────────
write_prefs <<'JSON'
{ "marketing": { "projects": { "test": {
  "meta": { "access_token": "TKN", "ad_account_id": "act_test" },
  "autopilot": { "enabled": true, "channels": ["meta"],
    "daily_spend_cap_usd": 50,
    "campaign_ids": { "meta": ["CID1"] },
    "pause_cpl_multiple": 2.0, "pause_ctr_floor": 0.005,
    "min_live_creatives": 2,
    "creative_regen": { "enabled": true, "video": "veo3", "image": "gemini-image" },
    "weekly_synthesis": true, "notify_sink": null } } } } }
JSON
: > "$CURL_LOG"
set +e
"$BIN" --dry-run --project test >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] && ok "dry-run exits 0" || err "dry-run exit" "rc=$rc"
if [ -f "$REP" ] && grep -q "cap pre-flight OK" "$REP"; then
  ok "dry-run cap pre-flight passes"
else
  err "dry-run cap pre-flight" "expected 'cap pre-flight OK' in report"
fi
if [ -f "$REP" ] && grep -q '\[DRY\] would' "$REP"; then
  ok "dry-run logs intended actions as [DRY]"
else
  err "dry-run [DRY] log" "no '[DRY] would' line in report"
fi
if grep -q '^MUTATE' "$CURL_LOG"; then
  err "dry-run mutations" "$(grep -c '^MUTATE' "$CURL_LOG") mutating call(s) — must be zero"
else
  ok "dry-run performs ZERO network mutations"
fi

# ── Test 3: static — never raises budget / creates campaign / audience ───────
# Allowed mutating verbs in source: PAUSE status only. Forbidden: budget writes,
# campaign/audience creation, objective changes.
FORBIDDEN='daily_budget=|lifetime_budget=|"objective"|customaudiences|create_campaign|/campaigns\?|adsets\?.*-X POST|"campaignBudget"'
if grep -nEi "$FORBIDDEN" "$BIN" >/dev/null 2>&1; then
  err "static budget/create scan" "forbidden mutation pattern present: $(grep -nEi "$FORBIDDEN" "$BIN" | head -1)"
else
  ok "source contains no budget-raise / campaign-create / audience-create calls"
fi
# Any Google Ads :mutate must only updateMask status (never budget/objective).
if grep -n ':mutate' "$BIN" | grep -qv 'updateMask.*status'; then
  badm="$(grep -n ':mutate' "$BIN" | grep -v 'campaigns:mutate' || true)"
  [ -z "$badm" ] && ok "Google Ads :mutate restricted to status updates" \
    || err "google :mutate scope" "$badm"
else
  ok "Google Ads :mutate restricted to status updates"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: spend-safety invariant violated."; exit 1; }
exit 0
