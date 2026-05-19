#!/usr/bin/env bash
# test-ops-content-landing.sh — Smoke tests for scripts/lib/creative/landing.sh
#
# Asserts:
#   1. generate_landing_variants refuses when brand.voice is empty
#   2. generate_landing_variants refuses when any required field is missing
#   3. --dry-run mode: reports fields_ok when all fields present
#   4. --dry-run mode: refuses and reports missing fields when brand.voice absent
#   5. bin/ops-content-landing exits non-zero when prefs not found
#   6. lib source does not leak project-specific defaults
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${PLUGIN_ROOT}/scripts/lib/creative/landing.sh"
BIN="${PLUGIN_ROOT}/bin/ops-content-landing"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

# run_lib <prefs_file> <project> — sources lib in isolated subshell, always exits 0
# Capture output; grep against it. The || true ensures pipefail doesn't swallow output.
run_lib() {
  local prefs="$1" proj="$2"
  OPS_AUTOPILOT_PREFS="$prefs" \
  OPS_DATA_DIR="$OPS_DATA_DIR" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  bash -c "source '${LIB}'; generate_landing_variants '${proj}' 2>/dev/null || true"
}

echo "Testing: scripts/lib/creative/landing.sh + bin/ops-content-landing"
echo ""

# ── Setup hermetic workspace ──────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export OPS_DATA_DIR="${WORK}/data"
mkdir -p "$OPS_DATA_DIR"

# ── Shim PATH ─────────────────────────────────────────────────────────────────
SHIM_DIR="${WORK}/shim"
mkdir -p "$SHIM_DIR"

cat > "${SHIM_DIR}/claude" <<'SHIMEOF'
#!/usr/bin/env bash
cat <<'JSON'
{"variants":[
  {"id":1,"headline":"Test headline one here","subhead":"Subhead one for testing.","cta":"Get started"},
  {"id":2,"headline":"Test headline two here","subhead":"Subhead two for testing.","cta":"Try free"},
  {"id":3,"headline":"Test headline three here","subhead":"Subhead three for testing.","cta":"Learn more"}
]}
JSON
SHIMEOF
chmod +x "${SHIM_DIR}/claude"

cat > "${SHIM_DIR}/curl" <<'SHIMEOF'
#!/usr/bin/env bash
echo "<html><body><p>Test page content.</p></body></html>"
SHIMEOF
chmod +x "${SHIM_DIR}/curl"

export PATH="${SHIM_DIR}:${PATH}"

# ── Prefs fixtures ────────────────────────────────────────────────────────────
PREFS_NO_VOICE="${WORK}/prefs-no-voice.json"
cat > "$PREFS_NO_VOICE" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"","product":"A test product","target_persona":"Test persona"},
  "source":{"url":"https://example.com"}
}}}}
JSON

PREFS_NO_PRODUCT="${WORK}/prefs-no-product.json"
cat > "$PREFS_NO_PRODUCT" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"confident, friendly","product":"","target_persona":"Test persona"},
  "source":{"url":"https://example.com"}
}}}}
JSON

PREFS_FULL="${WORK}/prefs-full.json"
cat > "$PREFS_FULL" <<'JSON'
{"marketing":{"projects":{"testproject":{
  "brand":{"voice":"confident and direct","product":"A productivity tool","target_persona":"Founders","name":"TestCo"},
  "source":{"url":"https://example.com"}
}}}}
JSON

# ── Test 1: refuse when prefs not found ──────────────────────────────────────
echo "Test 1: refuse when prefs not found"
out="$(run_lib "${WORK}/missing-prefs.json" myproject)"
if printf '%s' "$out" | grep -q '"refused":true'; then
  ok "refuses when prefs not found"
else
  err "should refuse when prefs not found" "got: $out"
fi

# ── Test 2: refuse when brand.voice is empty ─────────────────────────────────
echo "Test 2: refuse when brand.voice is empty"
out="$(run_lib "$PREFS_NO_VOICE" testproject)"
if printf '%s' "$out" | grep -q '"refused":true'; then
  ok "refuses when brand.voice is empty"
else
  err "should refuse when brand.voice is empty" "got: $out"
fi

if printf '%s' "$out" | grep -q 'brand.voice'; then
  ok "missing fields list contains brand.voice"
else
  err "missing fields should include brand.voice" "got: $out"
fi

# ── Test 3: refuse when brand.product is missing ─────────────────────────────
echo "Test 3: refuse when brand.product is missing"
out="$(run_lib "$PREFS_NO_PRODUCT" testproject)"
if printf '%s' "$out" | grep -q '"refused":true'; then
  ok "refuses when brand.product is empty"
else
  err "should refuse when brand.product is empty" "got: $out"
fi

# ── Test 4: --dry-run with all fields present ─────────────────────────────────
echo "Test 4: --dry-run with all fields present"
dry_out="$(OPS_AUTOPILOT_PREFS="$PREFS_FULL" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "${BIN}" testproject --dry-run 2>/dev/null || true)"
if printf '%s' "$dry_out" | grep -q '"dry_run":true'; then
  ok "--dry-run returns dry_run:true"
else
  err "--dry-run should return dry_run:true" "got: $dry_out"
fi

if printf '%s' "$dry_out" | grep -qE 'fields_ok|would_generate'; then
  ok "--dry-run reports fields_ok_would_generate"
else
  err "--dry-run should report fields_ok_would_generate" "got: $dry_out"
fi

# ── Test 5: --dry-run refuses when brand.voice missing ───────────────────────
echo "Test 5: --dry-run refuses when brand.voice missing"
dry_no_voice="$(OPS_AUTOPILOT_PREFS="$PREFS_NO_VOICE" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "${BIN}" testproject --dry-run 2>/dev/null || true)"
if printf '%s' "$dry_no_voice" | grep -q '"refused":true'; then
  ok "--dry-run refuses when brand.voice missing"
else
  err "--dry-run should refuse when brand.voice missing" "got: $dry_no_voice"
fi

# ── Test 6: bin exits non-zero without project arg ────────────────────────────
echo "Test 6: bin exits non-zero without project arg"
if CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "${BIN}" 2>/dev/null; then
  err "bin should exit non-zero without project arg" "exited 0"
else
  ok "bin exits non-zero without project arg"
fi

# ── Test 7: live run produces valid manifest with 3 variants ─────────────────
echo "Test 7: live run produces valid manifest with 3 variants"
live_out="$(run_lib "$PREFS_FULL" testproject)"
if printf '%s' "$live_out" | jq -e '.variants | length == 3' >/dev/null 2>&1; then
  ok "live run produces manifest with 3 variants"
else
  err "live run should produce 3 variants" "got: $(printf '%s' "$live_out" | head -c 200)"
fi

if printf '%s' "$live_out" | jq -e '.variants_file' >/dev/null 2>&1; then
  ok "manifest includes variants_file path"
else
  err "manifest should include variants_file" "got: $live_out"
fi

vfile="$(printf '%s' "$live_out" | jq -r '.variants_file // empty' 2>/dev/null || true)"
if [ -n "$vfile" ] && [ -f "$vfile" ]; then
  ok "variants markdown file written to disk"
else
  err "variants markdown file not found on disk" "path: ${vfile:-empty}"
fi

# ── Test 8: no project-specific branding defaults in lib ─────────────────────
echo "Test 8: lib has no project-specific branding defaults"
if grep -qiE 'healify|health, wellness, vibrant' "${LIB}" 2>/dev/null; then
  err "lib contains project-specific branding defaults" "found project vocab"
else
  ok "lib has no project-specific branding defaults"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""
(( fail == 0 )) && exit 0 || exit 1
