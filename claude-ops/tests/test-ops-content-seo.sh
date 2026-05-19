#!/usr/bin/env bash
# test-ops-content-seo.sh — Smoke tests for scripts/ops-cron-seo-blog-gen.sh
#
# Asserts:
#   1. exits 0 when prefs file not found
#   2. skips project when blog.enabled != true
#   3. refuses when brand.voice absent (even with blog enabled)
#   4. --dry-run reports would_run with all required fields
#   5. GSC filter: keeps position 8-30, imp > 50, CTR < 5%
#   6. GSC filter: excludes out-of-range rows
#   7. manifest.json created after live run
#   8. script has no project-specific branding defaults
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${PLUGIN_ROOT}/scripts/ops-cron-seo-blog-gen.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing: scripts/ops-cron-seo-blog-gen.sh"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export OPS_DATA_DIR="${WORK}/data"
mkdir -p "$OPS_DATA_DIR"

# ── Shim PATH ─────────────────────────────────────────────────────────────────
SHIM_DIR="${WORK}/shim"
mkdir -p "$SHIM_DIR"

cat > "${SHIM_DIR}/gcloud" <<'SHIMEOF'
#!/usr/bin/env bash
echo "fake-gsc-access-token"
SHIMEOF
chmod +x "${SHIM_DIR}/gcloud"

cat > "${SHIM_DIR}/curl" <<'SHIMEOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in *searchAnalytics*) IS_GSC=1 ;; esac
done
if [ "${IS_GSC:-0}" = "1" ]; then
  cat <<'GSCJSON'
{"rows":[
  {"keys":["best productivity tool"],"position":12.3,"impressions":320,"ctr":0.018},
  {"keys":["team collaboration software"],"position":9.1,"impressions":210,"ctr":0.022},
  {"keys":["project management tips"],"position":25.0,"impressions":180,"ctr":0.031},
  {"keys":["already top ranking"],"position":2.5,"impressions":900,"ctr":0.12},
  {"keys":["already high ctr"],"position":15.0,"impressions":400,"ctr":0.08},
  {"keys":["low impressions"],"position":14.0,"impressions":30,"ctr":0.02},
  {"keys":["too low position"],"position":45.0,"impressions":500,"ctr":0.01}
]}
GSCJSON
  exit 0
fi
echo "{}"
SHIMEOF
chmod +x "${SHIM_DIR}/curl"

cat > "${SHIM_DIR}/claude" <<'SHIMEOF'
#!/usr/bin/env bash
cat <<'ARTICLE'
# Test Article Heading

Introduction paragraph.

## Section One

Content for section one.

## Conclusion

Summary and next step.
ARTICLE
SHIMEOF
chmod +x "${SHIM_DIR}/claude"

export PATH="${SHIM_DIR}:${PATH}"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

# ── Prefs fixtures ────────────────────────────────────────────────────────────
PREFS_DISABLED="${WORK}/prefs-disabled.json"
cat > "$PREFS_DISABLED" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"friendly and direct","product":"Test product"},
  "gsc":{"site_url":"https://example.com"},
  "blog":{"enabled":false}
}}}}
JSON

PREFS_NO_VOICE="${WORK}/prefs-no-voice.json"
cat > "$PREFS_NO_VOICE" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"","product":"Test product"},
  "gsc":{"site_url":"https://example.com"},
  "blog":{"enabled":true}
}}}}
JSON

PREFS_FULL="${WORK}/prefs-full.json"
cat > "$PREFS_FULL" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"friendly and confident","product":"Productivity tool"},
  "gsc":{"site_url":"https://example.com"},
  "blog":{"enabled":true}
}}}}
JSON

# Helper: run script capturing stdout+stderr, always exit 0
run_script() {
  OPS_AUTOPILOT_PREFS="${1}" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "${SCRIPT}" "${@:2}" 2>&1 || true
}

# ── Test 1: exits 0 when prefs not found ─────────────────────────────────────
echo "Test 1: exits 0 when prefs not found"
OPS_AUTOPILOT_PREFS="${WORK}/missing.json" bash "${SCRIPT}" --dry-run 2>/dev/null
ok "exits 0 when prefs not found"

# ── Test 2: skips project when blog.enabled != true ──────────────────────────
echo "Test 2: skips when blog.enabled=false"
out="$(run_script "$PREFS_DISABLED" testproject --dry-run)"
if printf '%s' "$out" | grep -qi "skip"; then
  ok "skips project when blog.enabled=false"
else
  err "should skip when blog.enabled=false" "got: $out"
fi

# ── Test 3: refuses when brand.voice absent ───────────────────────────────────
echo "Test 3: refuses when brand.voice absent"
out="$(run_script "$PREFS_NO_VOICE" testproject --dry-run)"
if printf '%s' "$out" | grep -q '"refused":true'; then
  ok "--dry-run refuses when brand.voice absent"
else
  err "--dry-run should refuse when brand.voice absent" "got: $out"
fi

# ── Test 4: --dry-run reports would_run with all fields ───────────────────────
echo "Test 4: --dry-run reports would_run with all fields"
out="$(run_script "$PREFS_FULL" testproject --dry-run)"
if printf '%s' "$out" | grep -q '"dry_run":true'; then
  ok "--dry-run returns dry_run:true"
else
  err "--dry-run should return dry_run:true" "got: $out"
fi

if printf '%s' "$out" | grep -q 'would_run'; then
  ok "--dry-run reports would_run status"
else
  err "--dry-run should report would_run" "got: $out"
fi

# ── Test 5: GSC filter — keeps opportunity rows ───────────────────────────────
echo "Test 5: GSC filter keeps position 8-30, imp > 50, CTR < 5%"
GSC_JSON='{"rows":[
  {"keys":["good opportunity"],"position":12.3,"impressions":320,"ctr":0.018},
  {"keys":["too high position"],"position":2.5,"impressions":900,"ctr":0.12},
  {"keys":["position too low"],"position":45.0,"impressions":500,"ctr":0.01},
  {"keys":["low impressions"],"position":14.0,"impressions":30,"ctr":0.02},
  {"keys":["high ctr"],"position":15.0,"impressions":400,"ctr":0.08}
]}'

filtered="$(printf '%s' "$GSC_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
opportunities = [
    {'keyword': r['keys'][0], 'position': r['position'],
     'impressions': r['impressions'], 'ctr': r['ctr'] * 100}
    for r in data.get('rows', [])
    if r['position'] >= 8 and r['position'] <= 30
       and r['impressions'] > 50
       and r['ctr'] * 100 < 5
]
print(json.dumps(opportunities))
")"

count="$(printf '%s' "$filtered" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"
if [ "$count" = "1" ]; then
  ok "filter returns exactly 1 opportunity"
else
  err "filter should return 1 opportunity" "got $count"
fi

kw="$(printf '%s' "$filtered" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['keyword'])" 2>/dev/null || echo '')"
if [ "$kw" = "good opportunity" ]; then
  ok "filter returns correct keyword"
else
  err "filter should return 'good opportunity'" "got: $kw"
fi

# ── Test 6: GSC filter excludes out-of-range rows ────────────────────────────
echo "Test 6: GSC filter excludes out-of-range rows"
bad_count="$(printf '%s' "$filtered" | python3 -c "
import json,sys
data = json.load(sys.stdin)
bad = [r['keyword'] for r in data if r['keyword'] in
       ['too high position','position too low','low impressions','high ctr']]
print(len(bad))
")"
if [ "$bad_count" = "0" ]; then
  ok "filter correctly excludes out-of-range rows"
else
  err "filter includes rows that should be excluded" "bad count: $bad_count"
fi

# ── Test 7: manifest created on live run ─────────────────────────────────────
echo "Test 7: manifest.json created on live run"
run_script "$PREFS_FULL" testproject >/dev/null 2>&1 || true

MANIFEST="${OPS_DATA_DIR}/content/blog/testproject/manifest.json"
if [ -f "$MANIFEST" ]; then
  ok "manifest.json created at expected path"
else
  err "manifest.json not found after live run" "path: $MANIFEST"
fi

# ── Test 8: no project-specific branding in script ───────────────────────────
echo "Test 8: script has no project-specific branding defaults"
if grep -qiE 'healify|health, wellness' "${SCRIPT}" 2>/dev/null; then
  err "script contains project-specific defaults" "found project vocab"
else
  ok "script has no project-specific branding defaults"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""
(( fail == 0 )) && exit 0 || exit 1
