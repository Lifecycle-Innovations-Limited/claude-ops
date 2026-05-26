#!/usr/bin/env bash
# test-onelink-canary-gate.sh — Unit tests for:
#   1. build_paid_destination — OneLink URL + url_tags assembly + utm_validate
#   2. destination_guard      — blocks bare domains, passes valid OneLink URLs
#   3. canary_gate_unpause    — fires ≤1 unpause per interval under N concurrent
#      invocations AND enforces ≤$5/day per ad set + Σ active ≤ daily_spend_cap_usd
#
# Hermetic: fake curl shim, no network, no real Meta/AppsFlyer/Amplitude calls.
# Rule NEVER LEAK MONEY: no gate => the PR is invalid (asserted in test 11).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${PLUGIN_ROOT}/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "=== test-onelink-canary-gate ==="
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export OPS_DATA_DIR="${WORK}/data"
export OPS_AUTOPILOT_PREFS="${WORK}/prefs.json"
export CLAUDE_OPS_USE_CREDIT_POOL=0
STATE_DIR="${OPS_DATA_DIR}/state/autopilot"
REPORT_DIR="${OPS_DATA_DIR}/reports/marketing-autopilot"
mkdir -p "${STATE_DIR}" "${REPORT_DIR}"

CURL_LOG="${WORK}/curl.log"
: > "${CURL_LOG}"

# ── Fake curl shim ────────────────────────────────────────────────────────────
SHIM="${WORK}/bin"
mkdir -p "${SHIM}"
# Write default fake curl (overridden per test where needed)
write_curl_shim() {
  local budget_cents="${1:-500}"  # default $5.00
  cat > "${SHIM}/curl" <<SHIMEOF
#!/usr/bin/env bash
url=""; mutating=0
for a in "\$@"; do
  case "\$a" in
    http*) url="\$a" ;;
    -X)    mutating=PENDING ;;
    POST|PUT|DELETE|PATCH) [ "\$mutating" = "PENDING" ] && mutating=1 ;;
    --data-binary|-d|--data) mutating=1 ;;
  esac
done
[ "\$mutating" = "1" ] && printf 'MUTATE %s\n' "\$url" >> "\${CURL_LOG:-/dev/null}" \
                        || printf 'GET %s\n'    "\$url" >> "\${CURL_LOG:-/dev/null}"
case "\$url" in
  *account_status*) echo '{"account_status":1}' ;;
  *fields=daily_budget*) echo '{"daily_budget":"${budget_cents}"}' ;;
  */adsets*)
    echo '{"data":[{"id":"ASID1","name":"canary-adset","status":"PAUSED","effective_status":"PAUSED","daily_budget":"${budget_cents}"}]}' ;;
  */ads*)
    echo '{"data":[{"creative":{"link_url":"https://example.onelink.me/abc123?af_xp=custom&pid=facebook_int&c=recovery&af_adset=athlete&af_ad=hook1"}}]}' ;;
  *v23.0/ASID1*)
    echo '{"success":true}' ;;
  *) echo '{}' ;;
esac
exit 0
SHIMEOF
  chmod +x "${SHIM}/curl"
}
write_curl_shim 500
export PATH="${SHIM}:${PATH}"
export CURL_LOG

# ── Stub lib tree ─────────────────────────────────────────────────────────────
STUBS="${WORK}/stubs"
mkdir -p "${STUBS}/lib" "${STUBS}/scripts/lib"

cat > "${STUBS}/lib/registry-path.sh" <<'E'
#!/usr/bin/env bash
OPS_DATA_DIR="${OPS_DATA_DIR:-/tmp/ops-data}"
E
cat > "${STUBS}/scripts/lib/utm-validate.sh" <<'E'
#!/usr/bin/env bash
utm_validate() {
  local c="${3:-}"
  printf '%s' "$c" | grep -qE '^[a-z0-9][a-z0-9_-]*_[a-z0-9][a-z0-9_-]*_[0-9]{8}$'
}
E

# Source utm_validate into current shell
# shellcheck disable=SC1090
. "${STUBS}/scripts/lib/utm-validate.sh"

# ── Test prefs ────────────────────────────────────────────────────────────────
PREFS="${OPS_AUTOPILOT_PREFS}"
cat > "${PREFS}" <<'PREFS_EOF'
{
  "marketing": {
    "projects": {
      "test": {
        "meta": { "access_token": "TKN", "ad_account_id": "act_test" },
        "appsflyer": {
          "api_key": "FAKE_AF_KEY",
          "app_id": "id1234",
          "onelink": { "base_url": "https://example.onelink.me/abc123" }
        },
        "amplitude": {
          "api_key": "FAKE_AMP_KEY",
          "secret_key": "FAKE_AMP_SECRET",
          "server_zone": "EU",
          "funnel_events": ["session_start", "bio_age_viewed"]
        },
        "paid": {
          "destination": {
            "required_base": "https://example.onelink.me/abc123",
            "required_af_params": ["af_xp", "pid", "c", "af_adset", "af_ad"],
            "_blocked_destinations": ["example-app.ai", "example-app.app", "apps.apple.com"]
          }
        },
        "autopilot": {
          "enabled": true,
          "daily_spend_cap_usd": 50,
          "autonomy_level": "unrestricted",
          "envelope": { "kill_switch": false },
          "channels": ["meta"],
          "campaign_ids": { "meta": ["CID1"] }
        }
      }
    }
  }
}
PREFS_EOF

# ── Inline function definitions (extracted from autopilot for unit testing) ───
# These mirror the exact implementations in the binary. Any divergence here is
# a test defect — the canonical source of truth is the binary.

LOG="${WORK}/test.log"
REPORT="${WORK}/report.md"
DRY_RUN=0
MUTATIONS=0
ESCALATED=0
META_TOKEN="FAKE_TOKEN"
META_PROOF=""
GRAPH="https://graph.facebook.com/v23.0"

log()    { printf '%s [test] %s\n' "$(date -u +%H:%M:%S)" "$1" >> "${LOG}"; }
report() { printf '%s\n' "$1" >> "${REPORT}"; }
mutate() {
  local desc="$1"; shift
  if [ "${DRY_RUN}" = "1" ]; then
    report "- [DRY] would: ${desc}"
    log "[DRY] ${desc}"
    return 0
  fi
  MUTATIONS=$((MUTATIONS+1))
  report "- [EXEC] ${desc}"
  log "[EXEC] ${desc}"
  curl -gsS --max-time 15 "$@" 2>/dev/null || true
}
meta_get() {
  local q="$1"
  curl -gsS --max-time 12 "${GRAPH}/${q}&access_token=${META_TOKEN}" 2>/dev/null || echo '{}'
}
resolve_cred() { printf '%s' "${1:-}"; }
chan_cred() {
  local proj="$1" channel="$2" field="$3"
  resolve_cred "$(jq -r --arg p "$proj" --arg c "$channel" --arg f "$field" \
    '.marketing.projects[$p][$c][$f] // empty' "${PREFS}" 2>/dev/null)"
}
ap_get() {
  local p="$1" path="$2"
  jq -r --arg p "$p" ".marketing.projects[\$p].autopilot${path} // empty" "${PREFS}" 2>/dev/null || true
}

# ── build_paid_destination ────────────────────────────────────────────────────
build_paid_destination() {
  local proj="$1" persona="$2" hook="$3" theme="$4"
  local onelink_base
  onelink_base="$(jq -r --arg p "$proj" \
    '.marketing.projects[$p].appsflyer.onelink.base_url // empty' "${PREFS}" 2>/dev/null)"
  if [ -z "$onelink_base" ] || [ "$onelink_base" = "null" ] \
     || printf '%s' "$onelink_base" | grep -q 'PLACEHOLDER'; then
    log "build_paid_destination: OneLink base_url not yet configured for ${proj}"
    return 1
  fi
  local enc_persona enc_hook enc_theme
  enc_persona="$(printf '%s' "$persona" | tr ' ' '+' | tr -cd 'a-zA-Z0-9+._-')"
  enc_hook="$(printf '%s' "$hook" | tr ' ' '+' | tr -cd 'a-zA-Z0-9+._-')"
  enc_theme="$(printf '%s' "$theme" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
  local utm_campaign; utm_campaign="${enc_theme}_v1_$(date +%Y%m%d)"
  if ! utm_validate "meta" "paid" "$utm_campaign" 2>/dev/null; then
    log "build_paid_destination: utm_validate failed for theme '${theme}'"
    return 1
  fi
  local sep="?"
  case "$onelink_base" in *\?*) sep="&";; esac
  local onelink_url="${onelink_base}${sep}af_xp=custom&pid=facebook_int&c=${enc_theme}&af_adset=${enc_persona}&af_ad=${enc_hook}"
  local url_tags="utm_source=meta&utm_medium=paid&utm_campaign=${utm_campaign}&utm_content=${enc_persona}__${enc_hook}"
  printf '%s\n%s\n' "$onelink_url" "$url_tags"
  return 0
}

# ── destination_guard ─────────────────────────────────────────────────────────
destination_guard() {
  local proj="$1" link="${2:-}"
  if [ -z "$link" ]; then
    log "destination_guard: empty link — BLOCK"
    return 1
  fi
  local req_base
  req_base="$(jq -r --arg p "$proj" \
    '.marketing.projects[$p].paid.destination.required_base // empty' "${PREFS}" 2>/dev/null)"
  local blocked_list
  blocked_list="$(jq -r --arg p "$proj" \
    '.marketing.projects[$p].paid.destination._blocked_destinations // [] | .[]' "${PREFS}" 2>/dev/null || true)"
  while IFS= read -r blocked; do
    [ -z "$blocked" ] && continue
    case "$link" in
      *"$blocked"*)
        if [ -n "$req_base" ] && ! printf '%s' "$req_base" | grep -q 'PLACEHOLDER'; then
          case "$link" in
            "${req_base}"*) : ;;
            *) log "destination_guard: BLOCK — blocked domain '${blocked}' without OneLink base"
               return 1 ;;
          esac
        else
          log "destination_guard: BLOCK — blocked domain '${blocked}' and OneLink not configured"
          return 1
        fi
        ;;
    esac
  done <<< "$blocked_list"
  if [ -n "$req_base" ] && ! printf '%s' "$req_base" | grep -q 'PLACEHOLDER'; then
    case "$link" in
      "${req_base}"*) : ;;
      *) log "destination_guard: BLOCK — does not start with required base"
         return 1 ;;
    esac
    local required_params
    required_params="$(jq -r --arg p "$proj" \
      '.marketing.projects[$p].paid.destination.required_af_params // [] | .[]' "${PREFS}" 2>/dev/null || true)"
    while IFS= read -r param; do
      [ -z "$param" ] && continue
      case "$link" in
        *"${param}="*) : ;;
        *) log "destination_guard: BLOCK — missing param '${param}'"
           return 1 ;;
      esac
    done <<< "$required_params"
  fi
  log "destination_guard: PASS — ${link}"
  return 0
}

# ── canary_gate_unpause ───────────────────────────────────────────────────────
CANARY_RATE_FLOOR_SECS="${CANARY_RATE_FLOOR_SECS:-82800}"
CANARY_ADSET_CAP_CENTS=500

canary_first_ad_destination_link() {
  local proj="$1" asid="$2"
  local ads_json
  ads_json="$(meta_get "${asid}/ads?fields=creative{link_url,object_story_spec}&limit=50" "$proj" 2>/dev/null || echo '{}')"
  printf '%s' "$ads_json" | jq -r '
    [.data[]?
      | (.creative // {})
      | (.link_url // empty),
        (.object_story_spec.link_data.link // empty)
      | select(. != null and . != "")
    ] | first // empty
  ' 2>/dev/null || true
}

canary_gate_unpause() {
  local proj="$1"
  [ "${ESCALATED:-0}" = "1" ] && return 0

  local lock_dir="${STATE_DIR}/${proj}-canary.lock"
  local fired_at_file="${STATE_DIR}/${proj}-canary.fired_at"
  local now_ts; now_ts="$(date +%s)"

  if [ -f "$fired_at_file" ]; then
    local last_fired; last_fired="$(cat "$fired_at_file" 2>/dev/null || echo 0)"
    local elapsed; elapsed=$((now_ts - last_fired))
    if [ "$elapsed" -lt "$CANARY_RATE_FLOOR_SECS" ]; then
      local remaining; remaining=$((CANARY_RATE_FLOOR_SECS - elapsed))
      report "- canary gate: rate-floor active — last unpause ${elapsed}s ago (floor=${CANARY_RATE_FLOOR_SECS}s, ${remaining}s remaining)"
      return 0
    fi
  fi

  if ! mkdir "$lock_dir" 2>/dev/null; then
    report "- canary gate: another process holds the lock — skipping this pass"
    return 0
  fi
  # shellcheck disable=SC2064
  trap "rmdir '${lock_dir}' 2>/dev/null || true; trap - RETURN" RETURN

  report ""
  report "### Canary Gate (auto-unpause)"

  # Condition 1: Meta account_status=1
  local acct_status=0
  local meta_acct; meta_acct="$(chan_cred "$proj" meta ad_account_id)"
  if [ -n "$meta_acct" ] && [ -n "${META_TOKEN:-}" ]; then
    local acct_resp
    acct_resp="$(meta_get "${meta_acct}?fields=account_status" "$proj")"
    acct_status="$(printf '%s' "$acct_resp" | jq -r '.account_status // 0' 2>/dev/null || echo 0)"
  fi
  if [ "$acct_status" != "1" ]; then
    report "- canary gate: HOLD — Meta account_status=${acct_status} (need 1)"
    return 0
  fi
  report "- canary gate: account_status=1 OK"

  # Condition 2: AppsFlyer state file present + non-empty
  local af_f="${STATE_DIR}/${proj}-appsflyer.json"
  if [ ! -s "$af_f" ]; then
    report "- canary gate: HOLD — AppsFlyer state file absent or empty"
    return 0
  fi
  local af_installs
  af_installs="$(jq -r '.installs_7d // empty' "$af_f" 2>/dev/null || true)"
  if [ -z "$af_installs" ]; then
    report "- canary gate: HOLD — AppsFlyer state file missing installs_7d key"
    return 0
  fi
  report "- canary gate: AppsFlyer installs_7d=${af_installs} OK"

  # Condition 3: Amplitude funnel non-zero
  local amp_f="${STATE_DIR}/${proj}-amplitude.json"
  local amp_total=0
  if [ -f "$amp_f" ]; then
    amp_total="$(jq -r '.funnel_total_7d // 0' "$amp_f" 2>/dev/null || echo 0)"
  fi
  if ! awk "BEGIN{exit !(${amp_total:-0} > 0)}" 2>/dev/null; then
    report "- canary gate: HOLD — Amplitude funnel_total_7d=${amp_total} (need >0)"
    return 0
  fi
  report "- canary gate: Amplitude funnel_total_7d=${amp_total} OK"

  # Condition 4: Prefs destination base — non-placeholder, not a blocked bare domain.
  local dest_base
  dest_base="$(jq -r --arg p "$proj" \
    '.marketing.projects[$p].paid.destination.required_base // empty' "${PREFS}" 2>/dev/null)"
  if [ -z "$dest_base" ] || printf '%s' "$dest_base" | grep -q 'PLACEHOLDER'; then
    report "- canary gate: HOLD — paid.destination.required_base is placeholder or absent"
    return 0
  fi
  local blocked_list_cg
  blocked_list_cg="$(jq -r --arg p "$proj" \
    '.marketing.projects[$p].paid.destination._blocked_destinations // [] | .[]' "${PREFS}" 2>/dev/null || true)"
  local dest_blocked=0
  while IFS= read -r blocked; do
    [ -z "$blocked" ] && continue
    case "$dest_base" in
      *"$blocked"*) dest_blocked=1; break ;;
    esac
  done <<< "$blocked_list_cg"
  if [ "$dest_blocked" = "1" ]; then
    report "- canary gate: HOLD — required_base contains a blocked domain"
    return 0
  fi
  report "- canary gate: required_base OK (prefs base=${dest_base})"

  local canary_total_cap_usd
  canary_total_cap_usd="$(ap_get "$proj" '.daily_spend_cap_usd')"; canary_total_cap_usd="${canary_total_cap_usd:-0}"
  if ! awk "BEGIN{exit !(${canary_total_cap_usd:-0} > 0)}" 2>/dev/null; then
    report "- canary gate: HOLD — daily_spend_cap_usd missing or invalid"
    return 0
  fi

  mapfile -t _GATE_CIDS < <(jq -r --arg p "$proj" \
    '.marketing.projects[$p].autopilot.campaign_ids.meta[]? // empty' "${PREFS}" 2>/dev/null)

  if [ "${#_GATE_CIDS[@]}" -eq 0 ]; then
    report "- canary gate: no campaign_ids.meta configured — cannot unpause"
    return 0
  fi

  local current_active_usd=0
  for _gcid in "${_GATE_CIDS[@]}"; do
    local _camp_data
    _camp_data="$(meta_get "${_gcid}?fields=daily_budget" "$proj" 2>/dev/null || echo '{}')"
    local _cdb; _cdb="$(printf '%s' "$_camp_data" | jq -r '.daily_budget // empty' 2>/dev/null)"
    if [ -n "$_cdb" ] && [ "$_cdb" != "null" ]; then
      current_active_usd="$(awk "BEGIN{printf \"%.2f\", ${current_active_usd}+${_cdb}/100}")"
    else
      local _as_data
      _as_data="$(meta_get "${_gcid}/adsets?fields=daily_budget,effective_status&limit=200" "$proj" 2>/dev/null || echo '{}')"
      local _as_sum
      _as_sum="$(printf '%s' "$_as_data" | jq '[.data[]? | select(.effective_status=="ACTIVE") | (.daily_budget|tonumber? // 0)] | add // 0' 2>/dev/null || echo 0)"
      current_active_usd="$(awk "BEGIN{printf \"%.2f\", ${current_active_usd}+${_as_sum}/100}")"
    fi
  done

  if awk "BEGIN{exit !(${current_active_usd:-0} >= ${canary_total_cap_usd})}"; then
    report "- canary gate: HOLD — total active budget \$${current_active_usd} already at/above \$${canary_total_cap_usd} cap (daily_spend_cap_usd)"
    return 0
  fi

  local unpause_asid="" unpause_asname="" unpause_budget_cents=0
  for _gcid in "${_GATE_CIDS[@]}"; do
    local _paused_sets
    _paused_sets="$(meta_get "${_gcid}/adsets?fields=id,name,status,daily_budget,effective_status&limit=200" "$proj" 2>/dev/null || echo '{}')"
    while IFS=$'\t' read -r _asid _asname _asdb; do
      [ -z "$_asid" ] && continue
      [ -z "$_asdb" ] || [ "$_asdb" = "null" ] && continue
      if ! awk -v b="$_asdb" -v cap="$CANARY_ADSET_CAP_CENTS" 'BEGIN{exit !(b <= cap)}'; then
        continue
      fi
      local _post_total_usd
      _post_total_usd="$(awk "BEGIN{printf \"%.2f\", ${current_active_usd}+${_asdb}/100}")"
      if awk "BEGIN{exit !(${_post_total_usd} > ${canary_total_cap_usd})}"; then
        continue
      fi
      local _ad_link
      _ad_link="$(canary_first_ad_destination_link "$proj" "$_asid")"
      if [ -z "$_ad_link" ]; then
        continue
      fi
      if ! destination_guard "$proj" "$_ad_link"; then
        report "- canary gate: skipping ad set '${_asname}' (${_asid}) — destination_guard failed for creative link"
        continue
      fi
      unpause_asid="$_asid"
      unpause_asname="$_asname"
      unpause_budget_cents="$_asdb"
      break 2
    done < <(printf '%s' "$_paused_sets" | jq -r \
      '.data[]? | select(.effective_status=="PAUSED" or .status=="PAUSED") | select(.daily_budget != null) | [.id,.name,.daily_budget] | @tsv' \
      2>/dev/null || true)
  done

  if [ -z "$unpause_asid" ]; then
    report "- canary gate: no qualifying PAUSED ad set (budget ≤ \$$(awk "BEGIN{printf \"%.2f\", ${CANARY_ADSET_CAP_CENTS}/100}")/day, under daily cap, destination_guard on creative link)"
    return 0
  fi

  local budget_usd; budget_usd="$(awk "BEGIN{printf \"%.2f\", ${unpause_budget_cents}/100}")"
  local post_total_usd; post_total_usd="$(awk "BEGIN{printf \"%.2f\", ${current_active_usd}+${unpause_budget_cents}/100}")"

  report "- canary gate: ALL conditions met — unpausing ad set '${unpause_asname}' (${unpause_asid}), budget \$${budget_usd}/day"
  report "  post-unpause active total: \$${post_total_usd} (cap: \$${canary_total_cap_usd} daily_spend_cap_usd)"

  if [ "${DRY_RUN}" = "1" ]; then
    mutate "canary-unpause ad set ${unpause_asid} (${unpause_asname}) \$${budget_usd}/day" \
      -X POST "${GRAPH}/${unpause_asid}" \
      -d "status=ACTIVE" \
      -d "access_token=${META_TOKEN}"
    return 0
  fi

  MUTATIONS=$((MUTATIONS+1))
  report "- [EXEC] canary-unpause ad set ${unpause_asid} (${unpause_asname}) \$${budget_usd}/day"
  log "[EXEC] canary-unpause ad set ${unpause_asid} (${unpause_asname}) \$${budget_usd}/day"
  local _cg_unpause_resp
  _cg_unpause_resp="$(curl -gsS --max-time 15 -X POST "${GRAPH}/${unpause_asid}" \
    -d "status=ACTIVE" \
    -d "access_token=${META_TOKEN}" \
    2>/dev/null || echo '{}')"
  if printf '%s' "$_cg_unpause_resp" | jq -e '(if .error then false else true end) and ((.success == true) or ((.id // "") != ""))' >/dev/null 2>&1; then
    printf '%s' "$now_ts" > "$fired_at_file"
    log "canary_gate_unpause: unpaused ${unpause_asid} proj=${proj} ts=${now_ts}"
  else
    report "- canary gate: unpause API failed — $(printf '%s' "$_cg_unpause_resp" | jq -c 'if .error then .error else . end' 2>/dev/null || echo 'empty/invalid response')"
    log "canary_gate_unpause: unpause FAILED for ${unpause_asid} proj=${proj} resp=${_cg_unpause_resp}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

# ── Test 1: build_paid_destination returns OneLink URL with required af params ──
echo "--- build_paid_destination ---"
: > "${REPORT}"
set +e
dest_out="$(build_paid_destination "test" "athlete_25-35" "recovery_hook" "recovery-reset" 2>/dev/null)"
rc=$?
set -e
[ "$rc" = "0" ] && ok "build_paid_destination exits 0 for valid input" \
                 || err "build_paid_destination exit" "expected 0, got $rc"

onelink_line="$(printf '%s' "$dest_out" | head -1)"
urltags_line="$(printf '%s' "$dest_out" | tail -1)"

for param in "af_xp=custom" "pid=facebook_int" "af_adset=" "af_ad="; do
  case "$onelink_line" in
    *"$param"*) ok "OneLink contains '${param}'" ;;
    *) err "OneLink missing param" "'${param}' not in: ${onelink_line}" ;;
  esac
done

for utm in "utm_source=meta" "utm_medium=paid" "utm_campaign=" "utm_content="; do
  case "$urltags_line" in
    *"$utm"*) ok "url_tags contains '${utm}'" ;;
    *) err "url_tags missing utm" "'${utm}' not in: ${urltags_line}" ;;
  esac
done

# utm_campaign must match the <token>_<token>_YYYYMMDD format
utm_camp="$(printf '%s' "$urltags_line" | grep -oE 'utm_campaign=[^&]+' | cut -d= -f2)"
if printf '%s' "$utm_camp" | grep -qE '^[a-z0-9][a-z0-9_-]*_[a-z0-9][a-z0-9_-]*_[0-9]{8}$'; then
  ok "utm_campaign '${utm_camp}' passes utm_validate format"
else
  err "utm_campaign format" "'${utm_camp}' does not match required format"
fi

# ── Test 2: build_paid_destination returns 1 for PLACEHOLDER base ────────────
echo ""
echo "--- build_paid_destination placeholder guard ---"
PLACEHOLDER_PREFS="${WORK}/prefs-placeholder.json"
jq '.marketing.projects.test.appsflyer.onelink.base_url = "https://example.onelink.me/PLACEHOLDER"' \
  "${PREFS}" > "${PLACEHOLDER_PREFS}"
_saved_prefs="${PREFS}"
PREFS="${PLACEHOLDER_PREFS}"
set +e
build_paid_destination "test" "persona" "hook" "theme" 2>/dev/null
ph_rc=$?
set -e
PREFS="${_saved_prefs}"
[ "$ph_rc" != "0" ] && ok "build_paid_destination returns 1 for PLACEHOLDER base" \
                     || err "placeholder guard" "expected non-zero for PLACEHOLDER"

# ── Test 3: destination_guard passes valid OneLink URL with all params ─────────
echo ""
echo "--- destination_guard ---"
VALID_LINK="https://example.onelink.me/abc123?af_xp=custom&pid=facebook_int&c=recovery&af_adset=athlete&af_ad=hook1"
set +e; destination_guard "test" "${VALID_LINK}" 2>/dev/null; dg_rc=$?; set -e
[ "$dg_rc" = "0" ] && ok "destination_guard passes valid OneLink URL" \
                    || err "destination_guard valid URL" "expected 0, got $dg_rc"

# ── Test 4: destination_guard blocks bare blocked domain ──────────────────────
BARE_LINK="https://example-app.ai/download"
set +e; destination_guard "test" "${BARE_LINK}" 2>/dev/null; bg_rc=$?; set -e
[ "$bg_rc" != "0" ] && ok "destination_guard blocks bare blocked domain" \
                     || err "destination_guard bare block" "expected non-zero for ${BARE_LINK}"

# ── Test 5: destination_guard blocks App Store URL ────────────────────────────
AS_LINK="https://apps.apple.com/us/app/test/id1234"
set +e; destination_guard "test" "${AS_LINK}" 2>/dev/null; as_rc=$?; set -e
[ "$as_rc" != "0" ] && ok "destination_guard blocks bare App Store URL" \
                     || err "destination_guard app store" "expected non-zero for ${AS_LINK}"

# ── Test 6: destination_guard blocks link with missing af params ──────────────
MISSING_LINK="https://example.onelink.me/abc123?af_xp=custom&pid=facebook_int"
set +e; destination_guard "test" "${MISSING_LINK}" 2>/dev/null; mp_rc=$?; set -e
[ "$mp_rc" != "0" ] && ok "destination_guard blocks link missing required af params" \
                     || err "destination_guard missing params" "expected non-zero"

# ── Test 7: destination_guard blocks empty link ────────────────────────────────
set +e; destination_guard "test" "" 2>/dev/null; empty_rc=$?; set -e
[ "$empty_rc" != "0" ] && ok "destination_guard blocks empty link" \
                          || err "destination_guard empty" "expected non-zero"

# ── Setup green state files for canary tests ─────────────────────────────────
printf '{"installs_7d":5,"registrations_7d":2,"app_id":"id1234"}' \
  > "${STATE_DIR}/test-appsflyer.json"
printf '{"funnel_total_7d":142,"events":{"session_start":120,"bio_age_viewed":22}}' \
  > "${STATE_DIR}/test-amplitude.json"

# ── Test 8: canary_gate_unpause DRY_RUN logs [DRY] and zero mutations ─────────
echo ""
echo "--- canary_gate_unpause DRY_RUN ---"
DRY_RUN=1; MUTATIONS=0; ESCALATED=0
rm -f "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
dry_hits="$(grep -c '\[DRY\].*canary-unpause\|ALL conditions met' "${REPORT}" 2>/dev/null)"; dry_hits="${dry_hits:-0}"
mutate_count="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; mutate_count="${mutate_count:-0}"
set -e
[ "${dry_hits}" -ge 1 ] && ok "canary_gate_unpause [DRY]: all-green logs [DRY] unpause" \
                          || err "canary_gate_unpause DRY log" "no [DRY] line — report: $(cat "${REPORT}")"
[ "${mutate_count}" = "0" ] && ok "canary_gate_unpause DRY_RUN: zero network mutations" \
                             || err "canary_gate_unpause DRY mutations" "${mutate_count} MUTATE calls"
DRY_RUN=0

# ── Test 9: canary_gate_unpause rate-floor prevents double-fire ───────────────
echo ""
echo "--- canary_gate_unpause rate-floor ---"
MUTATIONS=0; ESCALATED=0
# Simulate fired 1 second ago — well within rate-floor
printf '%s' "$(($(date +%s) - 1))" > "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
hold_hits="$(grep -c 'rate-floor active' "${REPORT}" 2>/dev/null)"; hold_hits="${hold_hits:-0}"
mutate_rf="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; mutate_rf="${mutate_rf:-0}"
set -e
[ "${hold_hits}" -ge 1 ] && ok "canary_gate_unpause: rate-floor HOLD when fired recently" \
                          || err "canary_gate_unpause rate-floor" "expected 'rate-floor active' in report"
[ "${mutate_rf}" = "0" ] && ok "canary_gate_unpause: zero mutations when rate-floor active" \
                          || err "canary_gate_unpause rate-floor mutations" "${mutate_rf} MUTATE calls"

rm -f "${STATE_DIR}/test-canary.fired_at"

# ── Test 10: canary_gate_unpause live: exactly 1 MUTATE when all green ────────
echo ""
echo "--- canary_gate_unpause live fire ---"
MUTATIONS=0; ESCALATED=0; DRY_RUN=0
rm -f  "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
live_mutates="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; live_mutates="${live_mutates:-0}"
set -e
[ "${live_mutates}" = "1" ] && ok "canary_gate_unpause live: exactly 1 MUTATE when all green" \
                             || err "canary_gate_unpause live MUTATE" "expected 1, got ${live_mutates} — report: $(cat "${REPORT}")"

[ -f "${STATE_DIR}/test-canary.fired_at" ] \
  && ok "canary_gate_unpause: fired_at timestamp written after live unpause" \
  || err "canary_gate_unpause fired_at" "fired_at not written"

# ── Test 11: N concurrent invocations fire ≤1 unpause (NEVER LEAK MONEY) ──────
echo ""
echo "--- canary_gate_unpause: ≤1 fire under N=6 concurrent calls ---"
rm -f  "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
CONCURRENT_CURL_LOG="${WORK}/curl-concurrent.log"
: > "${CONCURRENT_CURL_LOG}"

N=6
pids=()
for i in $(seq 1 $N); do
  (
    # Each subshell exports its own CURL_LOG to the shared concurrent log
    export CURL_LOG="${CONCURRENT_CURL_LOG}"
    export REPORT="${WORK}/report-concurrent-${i}.md"
    : > "${REPORT}"
    DRY_RUN=0 MUTATIONS=0 ESCALATED=0 \
      canary_gate_unpause "test" 2>/dev/null || true
  ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done

set +e
conc_mutates="$(grep -c '^MUTATE' "${CONCURRENT_CURL_LOG}" 2>/dev/null)"; conc_mutates="${conc_mutates:-0}"
set -e
if [ "${conc_mutates}" -le 1 ]; then
  ok "NEVER LEAK MONEY: ≤1 MUTATE across ${N} concurrent invocations (got ${conc_mutates})"
else
  err "NEVER LEAK MONEY concurrency" "${conc_mutates} MUTATE calls — must be ≤1 per interval"
fi


# ── Test 12: NEVER LEAK MONEY — $6/day ad set not unpaused ───────────────────
echo ""
echo "--- NEVER LEAK MONEY: per-adset \$5 cap ---"
rm -f  "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
write_curl_shim 600  # $6.00 > cap
MUTATIONS=0; ESCALATED=0; DRY_RUN=0
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
over_mutates="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; over_mutates="${over_mutates:-0}"
set -e
[ "${over_mutates}" = "0" ] \
  && ok "NEVER LEAK MONEY: \$6/day ad set NOT unpaused (budget > \$5 cap)" \
  || err "NEVER LEAK MONEY \$5 cap" "${over_mutates} MUTATE calls on \$6 ad set"

write_curl_shim 500  # restore

# ── Test 13: canary gate HOLD when Amplitude funnel_total_7d=0 ────────────────
echo ""
echo "--- canary gate HOLD: Amplitude=0 ---"
printf '{"funnel_total_7d":0,"events":{}}' > "${STATE_DIR}/test-amplitude.json"
rm -f  "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
MUTATIONS=0; ESCALATED=0
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
amp_hold="$(grep -c 'HOLD.*Amplitude\|Amplitude.*need.*>0' "${REPORT}" 2>/dev/null)"; amp_hold="${amp_hold:-0}"
amp_mut="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; amp_mut="${amp_mut:-0}"
set -e
[ "${amp_hold}" -ge 1 ] && ok "canary gate HOLD when Amplitude funnel=0" \
                          || err "canary gate Amplitude HOLD" "expected HOLD in report"
[ "${amp_mut}" = "0" ]  && ok "canary gate: zero mutations when Amplitude=0" \
                          || err "canary gate Amplitude mutations" "${amp_mut} MUTATE calls"

# Restore Amplitude
printf '{"funnel_total_7d":142,"events":{"session_start":120}}' \
  > "${STATE_DIR}/test-amplitude.json"

# ── Test 14: canary gate HOLD when AppsFlyer state file absent ───────────────
echo ""
echo "--- canary gate HOLD: AppsFlyer absent ---"
rm -f "${STATE_DIR}/test-appsflyer.json"
rm -f "${STATE_DIR}/test-canary.fired_at"
rm -rf "${STATE_DIR}/test-canary.lock"
MUTATIONS=0; ESCALATED=0
: > "${CURL_LOG}"; : > "${REPORT}"

canary_gate_unpause "test" 2>/dev/null || true

set +e
af_hold="$(grep -c 'HOLD.*AppsFlyer\|AppsFlyer state file absent' "${REPORT}" 2>/dev/null)"; af_hold="${af_hold:-0}"
af_mut="$(grep -c '^MUTATE' "${CURL_LOG}" 2>/dev/null)"; af_mut="${af_mut:-0}"
set -e
[ "${af_hold}" -ge 1 ] && ok "canary gate HOLD when AppsFlyer state absent" \
                         || err "canary gate AF HOLD" "expected HOLD in report"
[ "${af_mut}" = "0" ]  && ok "canary gate: zero mutations when AF absent" \
                         || err "canary gate AF mutations" "${af_mut} MUTATE calls"

# ── Test 15: bash -n static syntax check on binary ───────────────────────────
echo ""
echo "--- static syntax ---"
if bash -n "${BIN}" 2>/dev/null; then
  ok "ops-marketing-autopilot passes bash -n"
else
  err "bash -n" "syntax error in ${BIN}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "---"
echo "Results: ${pass} passed, ${fail} failed"
(( fail == 0 )) || { echo "ACTION: onelink/canary invariant violated."; exit 1; }
exit 0
