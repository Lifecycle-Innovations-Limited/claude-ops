#!/usr/bin/env bash
# test-autopilot-autonomy.sh — autonomy-level + envelope + gen-spend invariants
# for bin/ops-marketing-autopilot and scripts/lib/creative/generate.sh.
#
# Asserts the create_object() autonomy gate:
#   1. create_once (no token)          → stages, ZERO creation
#   2. create_once (token present)     → creation attempted, token NOT consumed
#   3. sandbox out-of-envelope         → escalation, ZERO creation
#   4. sandbox within envelope         → creation attempted, no escalation
#   5. unrestricted still cap-bounded  → daily_spend_cap_usd still blocks
#   6. kill_switch                     → stage-only, ZERO creation
#   7. gen-spend ceiling ≤ cap under N concurrent creative_generate calls
#
# NOTE: objective_allowlist / geo_allowlist are documented in preferences but
# the create_object() gate enforces the spend envelope (max_daily_budget_usd,
# max_campaigns, daily_spend_cap_usd, kill_switch). Cases 3 & 5 therefore drive
# escalation through the *budget* envelope, which is the money-leak guard that
# actually matters (NEVER LEAK MONEY).
#
# Hermetic: a fake `curl` on PATH records every creation/mutation and returns
# canned JSON, so no network is touched.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"
GEN_LIB="$PLUGIN_ROOT/scripts/lib/creative/generate.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $BIN (autonomy gate) + $GEN_LIB (gen-spend)"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export OPS_DATA_DIR="$WORK/data"
mkdir -p "$OPS_DATA_DIR"
export OPS_AUTOPILOT_PREFS="$WORK/preferences.json"
export CLAUDE_OPS_USE_CREDIT_POOL=0
CURL_LOG="$WORK/curl.log"
: > "$CURL_LOG"

# ── Fake curl: log calls; flag object-creation POSTs distinctly from GETs ─────
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
case "\$url" in
  *generativelanguage.googleapis.com*)
    # Stubbed Gemini media response (image): inline base64 of "x"
    echo '{"candidates":[{"content":{"parts":[{"inlineData":{"data":"eA==","mimeType":"image/png"}}]}}]}'
    exit 0 ;;
esac
if [ "\$mutating" = 1 ]; then
  case "\$url" in
    */campaigns|*/customaudiences|*campaigns:mutate)
      echo "CREATE \$url" >> "$CURL_LOG"
      echo '{"id":"NEWOBJ123"}'; exit 0 ;;
  esac
  echo "MUTATE \$url" >> "$CURL_LOG"
  echo '{}'; exit 0
fi
echo "GET \$url" >> "$CURL_LOG"
case "\$url" in
  *) echo '{}' ;;
esac
exit 0
SHIMEOF
chmod +x "$SHIM/curl"
export PATH="$SHIM:$PATH"

write_prefs() { cat > "$OPS_AUTOPILOT_PREFS"; }
STATE_DIR="$OPS_DATA_DIR/state/autopilot"

# Touch the install marker so runs are NOT forced-dry (we want to exercise the
# real autonomy gate, not the first-run dry override).
mark_installed() { mkdir -p "$STATE_DIR"; date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/.installed"; }

reset_run() {
  rm -rf "$OPS_DATA_DIR/reports" "$STATE_DIR"
  : > "$CURL_LOG"
  mark_installed
}
REP() { cat "$OPS_DATA_DIR/reports/marketing-autopilot/scratch-latest.md" 2>/dev/null || echo ""; }
n_create() { local c; c="$(grep -c '^CREATE' "$CURL_LOG" 2>/dev/null)" || c=0; printf '%s' "${c:-0}"; }
n_mutate() { local c; c="$(grep -c '^MUTATE' "$CURL_LOG" 2>/dev/null)" || c=0; printf '%s' "${c:-0}"; }

prefs_for() {
  # $1 = autonomy_level, $2 = cap, $3 = extra autopilot json object (merged)
  local lvl="$1" cap="$2" extra="$3"
  local ap
  ap="$(jq -n --arg lvl "$lvl" --argjson cap "$cap" --argjson extra "$extra" '
    { enabled: true, channels: ["meta"], daily_spend_cap_usd: $cap,
      autonomy_level: $lvl, source: { url: "https://example.com" } } * $extra')"
  cat > "$OPS_AUTOPILOT_PREFS" <<JSON
{ "marketing": { "projects": { "scratch": {
  "meta": { "access_token": "TKN", "ad_account_id": "act_scratch" },
  "autopilot": ${ap}
} } } }
JSON
}

# ── Case 1: create_once, no token → stages, ZERO creation ────────────────────
reset_run
prefs_for create_once 100 '{"envelope":{"kill_switch":false}}'
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case1: onboard exits 0" || err "case1 exit" "rc=$rc"
if REP | grep -q "## Requires human action"; then
  ok "case1: report has '## Requires human action'"
else
  err "case1 requires-human" "missing in report"
fi
if [ "$(n_create)" -eq 0 ] && [ "$(n_mutate)" -eq 0 ]; then
  ok "case1: ZERO creation/mutation curl"
else
  err "case1 zero-create" "create=$(n_create) mutate=$(n_mutate)"
fi

# ── Case 2: create_once WITH token → creation attempted, token persists ──────
reset_run
prefs_for create_once 100 '{"envelope":{"kill_switch":false}}'
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/scratch.create-ok"
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case2: onboard exits 0" || err "case2 exit" "rc=$rc"
if [ "$(n_create)" -ge 1 ]; then
  ok "case2: creation curl attempted with token present ($(n_create))"
else
  err "case2 create-attempted" "expected ≥1 CREATE, got $(n_create)"
fi
if [ -f "$STATE_DIR/scratch.create-ok" ]; then
  ok "case2: create-once token NOT consumed (persists for daily loop)"
else
  err "case2 token-persist" "token file was removed"
fi

# ── Case 3: sandbox out-of-envelope (budget > max_daily_budget_usd) ──────────
# Default scaffold budget is \$20/day; envelope caps it at \$5 → escalation.
reset_run
prefs_for sandbox 100 '{"envelope":{"kill_switch":false,"max_campaigns":5,"max_new_audiences":5,"max_daily_budget_usd":5,"objective_allowlist":["OUTCOME_LEADS"],"geo_allowlist":["US"]}}'
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case3: onboard exits 0" || err "case3 exit" "rc=$rc"
if REP | grep -q "⛔ ESCALATION"; then
  ok "case3: report has '⛔ ESCALATION'"
else
  err "case3 escalation-report" "missing ESCALATION banner"
fi
if [ -f "$STATE_DIR/escalations.log" ] && grep -q "sandbox" "$STATE_DIR/escalations.log"; then
  ok "case3: escalations.log row written"
else
  err "case3 escalations.log" "no sandbox escalation row"
fi
if [ "$(n_create)" -eq 0 ]; then
  ok "case3: ZERO creation curl (sandbox blocked out-of-envelope)"
else
  err "case3 zero-create" "create=$(n_create)"
fi

# ── Case 4: sandbox within envelope → creation attempted, no escalation ──────
reset_run
prefs_for sandbox 100 '{"envelope":{"kill_switch":false,"max_campaigns":5,"max_new_audiences":5,"max_daily_budget_usd":50,"objective_allowlist":["OUTCOME_LEADS"],"geo_allowlist":["US"]}}'
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case4: onboard exits 0" || err "case4 exit" "rc=$rc"
if [ "$(n_create)" -ge 1 ]; then
  ok "case4: creation curl attempted within envelope ($(n_create))"
else
  err "case4 create-attempted" "expected ≥1 CREATE, got $(n_create)"
fi
if REP | grep -q "⛔ ESCALATION"; then
  err "case4 no-escalation" "unexpected ESCALATION within envelope"
else
  ok "case4: no escalation within envelope"
fi

# ── Case 5: unrestricted STILL cap-bounded (daily_spend_cap_usd) ─────────────
# Default scaffold budget \$20/day; cap \$5 → unrestricted must still block.
reset_run
prefs_for unrestricted 5 '{"envelope":{"kill_switch":false}}'
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case5: onboard exits 0" || err "case5 exit" "rc=$rc"
if REP | grep -q "⛔ ESCALATION"; then
  ok "case5: unrestricted still escalates over daily_spend_cap_usd"
else
  err "case5 cap-bound" "unrestricted bypassed cap (no ESCALATION)"
fi
if [ "$(n_create)" -eq 0 ]; then
  ok "case5: ZERO runaway creation (cap held under unrestricted)"
else
  err "case5 zero-create" "create=$(n_create) — cap bypassed"
fi

# ── Case 6: kill_switch halts everything (any level) ─────────────────────────
reset_run
prefs_for unrestricted 100 '{"envelope":{"kill_switch":true}}'
set +e; "$BIN" --onboard --project scratch >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "case6: onboard exits 0" || err "case6 exit" "rc=$rc"
if REP | grep -qi "kill_switch"; then
  ok "case6: report notes kill_switch"
else
  err "case6 kill-switch-note" "no kill_switch mention in report"
fi
if [ "$(n_create)" -eq 0 ] && [ "$(n_mutate)" -eq 0 ]; then
  ok "case6: ZERO creation/mutation under kill_switch"
else
  err "case6 zero-create" "create=$(n_create) mutate=$(n_mutate)"
fi

# ── Case 7: gen-spend ceiling ≤ cap under N concurrent creative_generate ─────
# Cap = \$0.10; Gemini image unit cost = \$0.04. 8 concurrent generators on the
# same project/day would spend \$0.32 if the accumulator were not guarded —
# the flock (or mkdir-mutex) floor must clamp Σ ≤ \$0.10 (only 2 fit).
GEN_PROJ="genscratch"
cat > "$OPS_AUTOPILOT_PREFS" <<JSON
{ "marketing": { "projects": { "$GEN_PROJ": {
  "autopilot": { "enabled": true, "channels": ["meta"], "daily_spend_cap_usd": 100,
    "creative_gen": { "enabled": true, "daily_gen_spend_cap_usd": 0.10,
      "max_gens_per_pass": 9999, "api_key": "env:GEMINI_API_KEY" } } } } } }
JSON
export GEMINI_API_KEY="fake-key-for-test"
# shellcheck disable=SC1090
. "$GEN_LIB"

GEN_STATE="$OPS_DATA_DIR/autopilot_state/${GEN_PROJ}"
ACC_FILE="$GEN_STATE/.gen-spend-$(date +%F)"
rm -rf "$GEN_STATE"

# generate.sh is explicitly NOT set -e safe ("callers control failure
# semantics"); disable errexit for the concurrent launch so subshells run the
# full accumulator+cap path instead of aborting on the first non-zero rc.
N=8
pids=()
set +e
for i in $(seq 1 "$N"); do
  ( creative_generate "$GEN_PROJ" '{"prompt":"test ad","type":"image"}' "$WORK/gen_out_$i" >/dev/null 2>&1 ) &
  pids+=("$!")
done
for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
set -e

acc_val="$(cat "$ACC_FILE" 2>/dev/null || echo 0)"
unit="0.04"; cap="0.10"
over="$(python3 -c "print(1 if float('${acc_val:-0}') > float('$cap') + 1e-9 else 0)" 2>/dev/null || echo 1)"
if [ "$over" = "0" ]; then
  ok "case7: gen-spend accumulator \$${acc_val} ≤ cap \$${cap} under ${N} concurrent"
else
  err "case7 gen-spend-cap" "accumulator \$${acc_val} EXCEEDS cap \$${cap} (money leak under concurrency)"
fi
# Independent cross-check: success count × unit cost ≤ cap.
succ="$(find "$WORK" -path "*/gen_out_*/*" -type f 2>/dev/null | wc -l | tr -d ' ')"
spend_calc="$(python3 -c "print(round($succ * $unit, 4))" 2>/dev/null || echo 999)"
le="$(python3 -c "print(1 if $spend_calc <= float('$cap') + 1e-9 else 0)" 2>/dev/null || echo 0)"
if [ "$le" = "1" ]; then
  ok "case7: ${succ} successful gens × \$${unit} = \$${spend_calc} ≤ cap (flock floor held)"
else
  err "case7 success-cost" "${succ} gens × \$${unit} = \$${spend_calc} > cap \$${cap}"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: autonomy/gen-spend invariant violated."; exit 1; }
exit 0
