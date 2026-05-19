#!/usr/bin/env bash
# test-autopilot-bandit-blended.sh — assert the bandit blended-reward path.
#
# Strategy: source the autopilot's functions (via env trick), seed a tiny
# kpi.jsonl + ga4-conversions.json under STATE_DIR, then invoke
# apply_calibration_and_bandit and verify a bandit_reward row is appended to
# creatives.jsonl with both meta_revenue and ga4_revenue fields.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing bandit blended-reward path in $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export OPS_DATA_DIR="$WORK/data"
export OPS_AUTOPILOT_PREFS="$WORK/preferences.json"
mkdir -p "$OPS_DATA_DIR"

# Pre-seed prefs with autopilot.enabled + no live channels (so process_meta skips)
cat > "$OPS_AUTOPILOT_PREFS" <<'JSON'
{
  "marketing": {
    "projects": {
      "testproj": {
        "autopilot": {
          "enabled": true,
          "daily_spend_cap_usd": 50,
          "channels": []
        }
      }
    }
  }
}
JSON

STATE_DIR="$OPS_DATA_DIR/state/autopilot"
AP_STATE_DIR="$OPS_DATA_DIR/autopilot_state/testproj"
mkdir -p "$STATE_DIR" "$AP_STATE_DIR"

# Pre-mark project as installed so the autopilot runs in LIVE mode (not forced-dry)
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/testproj.installed"

# Seed kpi.jsonl with two ad rows
cat > "$AP_STATE_DIR/kpi.jsonl" <<'JSONL'
{"ts":"2026-05-18T10:00:00Z","project":"testproj","ad_id":"ad_A","spend":10,"impressions":1000,"ctr":0.01,"cpl":5,"leads":2,"purchase_value":50}
{"ts":"2026-05-18T10:00:00Z","project":"testproj","ad_id":"ad_B","spend":20,"impressions":1500,"ctr":0.008,"cpl":10,"leads":2,"purchase_value":30}
JSONL

# Seed creatives.jsonl so the bandit has scored candidates
cat > "$AP_STATE_DIR/creatives.jsonl" <<'JSONL'
{"ad_id":"ad_A","asset_path":"/tmp/a.png","tier2":{"prior":75,"verdict":"approved"},"deploy_ts":"2026-05-18T10:00:00Z"}
{"ad_id":"ad_B","asset_path":"/tmp/b.png","tier2":{"prior":40,"verdict":"approved"},"deploy_ts":"2026-05-18T10:00:00Z"}
JSONL

# Seed ga4-conversions.json with a known revenue total
cat > "$STATE_DIR/testproj-ga4-conversions.json" <<'JSON'
{"rows":[
  {"source":"meta","medium":"paid","campaign":"summer_v1_20260601","conversions":3,"revenue":60,"sessions":100},
  {"source":"google","medium":"paid","campaign":"q2_v1_20260601","conversions":1,"revenue":20,"sessions":50}
],"by_smc":{"meta/paid/summer_v1_20260601":{"conversions":3,"revenue":60,"sessions":100}}}
JSON

# ── 1. Default (blended) source → bandit_reward rows with ga4_revenue > 0 ────
export OPS_BANDIT_SOURCE="blended"
"$BIN" --project testproj >/dev/null 2>&1 || true

if [ -f "$AP_STATE_DIR/creatives.jsonl" ]; then
  reward_rows="$(grep -c 'bandit_reward' "$AP_STATE_DIR/creatives.jsonl" 2>/dev/null || true)"
reward_rows="${reward_rows:-0}"
else
  reward_rows=0
fi
[ "${reward_rows:-0}" -ge 1 ] \
  && ok "blended: bandit_reward rows written (${reward_rows})" \
  || err "blended: no bandit_reward rows" "creatives.jsonl missing rows"

ga4_present="$(grep -c 'ga4_revenue' "$AP_STATE_DIR/creatives.jsonl" 2>/dev/null || true)"
ga4_present="${ga4_present:-0}"
[ "${ga4_present}" -ge 1 ] \
  && ok "blended: ga4_revenue present in reward row" \
  || err "blended: ga4_revenue missing" "no ga4_revenue field"

meta_present="$(grep -c 'meta_revenue' "$AP_STATE_DIR/creatives.jsonl" 2>/dev/null || true)"
meta_present="${meta_present:-0}"
[ "${meta_present}" -ge 1 ] \
  && ok "blended: meta_revenue present in reward row" \
  || err "blended: meta_revenue missing" "no meta_revenue field"

source_blended="$(grep -c 'blended' "$AP_STATE_DIR/creatives.jsonl" 2>/dev/null || true)"
source_blended="${source_blended:-0}"
[ "${source_blended}" -ge 1 ] \
  && ok "blended: source label written" \
  || err "blended: source label missing" "expected 'source':'blended'"

# ── 2. OPS_BANDIT_SOURCE=meta → no new bandit_reward rows appended ───────────
# Reset ledger
cat > "$AP_STATE_DIR/creatives.jsonl" <<'JSONL'
{"ad_id":"ad_A","asset_path":"/tmp/a.png","tier2":{"prior":75,"verdict":"approved"},"deploy_ts":"2026-05-18T10:00:00Z"}
{"ad_id":"ad_B","asset_path":"/tmp/b.png","tier2":{"prior":40,"verdict":"approved"},"deploy_ts":"2026-05-18T10:00:00Z"}
JSONL

export OPS_BANDIT_SOURCE="meta"
"$BIN" --project testproj >/dev/null 2>&1 || true

reward_rows_meta="$(grep -c 'bandit_reward' "$AP_STATE_DIR/creatives.jsonl" 2>/dev/null || true)"
reward_rows_meta="${reward_rows_meta:-0}"
[ "${reward_rows_meta}" -eq 0 ] \
  && ok "source=meta: no blended reward rows appended" \
  || err "source=meta: unexpected reward rows" "${reward_rows_meta}"

# ── 3. Report mentions the bandit reward source ──────────────────────────────
report="$OPS_DATA_DIR/reports/marketing-autopilot/testproj-latest.md"
if [ -L "$report" ] && [ -f "$report" ]; then
  grep -q "bandit reward source:" "$report" \
    && ok "report mentions reward source" \
    || err "report missing reward source" "expected 'bandit reward source:'"
else
  err "report not generated" "$report not found"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
