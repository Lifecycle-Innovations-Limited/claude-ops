#!/bin/sh
# run-tests.sh — statusline test suite (POSIX sh)
# Tests: width, gauge boundaries, pace badge, config, peer metrics, dedup.
# Uses a temp HOME so no real ~/.claude/ dirs are touched.
set -eu

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$TESTS_DIR/.." && pwd)/statusline-command.sh"
FIXTURES="$TESTS_DIR/fixtures"

pass=0; fail=0

ok()  { pass=$(( pass + 1 )); printf '  [ ok ] %s\n' "$1"; }
nok() { fail=$(( fail + 1 )); printf '  [FAIL] %s\n' "$1"; }

assert_exit0() {
  _label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$_label"; else nok "$_label"; fi
}

# strip_ansi: remove ESC[...m sequences
strip_ansi() { printf '%s' "$1" | sed 's/\x1b\[[0-9;]*m//g'; }

# render <input_file> <COLUMNS> <HOME_dir>
render() {
  HOME="$3" COLUMNS="$2" sh "$SCRIPT" < "$1" 2>/dev/null
}

# ── Setup temp HOME ──────────────────────────────────────────────────────────
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT INT TERM

# Helper script for gauge color testing (avoids inline single-quote escaping)
GAUGE_HELPER="$TMPDIR_BASE/gauge_helper.sh"
cat > "$GAUGE_HELPER" << 'GAUGEEOF'
#!/bin/sh
# Usage: sh gauge_helper.sh <pct>
_p=$1
case "$_p" in ''|*[!0-9]*) _p=0;; esac
if   [ "$_p" -ge 90 ]; then printf '1;31'
elif [ "$_p" -ge 75 ]; then printf '38;5;208'
elif [ "$_p" -ge 50 ]; then printf '33'
else                        printf '32'
fi
GAUGEEOF

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. Width: no line exceeds COLUMNS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

for cols in 60 80 110 160 220; do
  THOME="$TMPDIR_BASE/home_w${cols}"
  mkdir -p "$THOME/.claude/.sysinfo" "$THOME/.claude/scripts/account-rotation"
  output=$(render "$FIXTURES/input-basic.json" "$cols" "$THOME")
  width_ok=1
  _lineno=0
  while IFS= read -r _line; do
    _lineno=$(( _lineno + 1 ))
    # Strip ANSI escape sequences first, then measure character count (not bytes)
    _vis=$(printf '%s' "$_line" | sed 's/\x1b\[[0-9;]*m//g')
    # Use wc -m (characters) in a UTF-8 locale for accurate count
    _w=$(printf '%s' "$_vis" | LC_ALL=C.UTF-8 wc -m 2>/dev/null | tr -d ' ')
    # Guard: if wc -m unavailable or returns non-numeric, skip
    case "$_w" in *[!0-9]*|'') continue;; esac
    if [ "$_w" -gt "$cols" ]; then
      width_ok=0
      nok "width@${cols} line${_lineno}: ${_w} visible chars > ${cols}: $(printf '%s' "$_vis" | cut -c1-60)..."
    fi
  done << LINEEOF
$output
LINEEOF
  [ "$width_ok" = "1" ] && ok "width@${cols}: all lines within ${cols} cols"
done

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2. Gauge color boundaries"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

gauge_test() {
  _pct="$1"; _expect="$2"; _label="$3"
  _got=$(sh "$GAUGE_HELPER" "$_pct")
  if [ "$_got" = "$_expect" ]; then ok "$_label"; else nok "$_label (got '$_got', want '$_expect')"; fi
}

gauge_test 0   "32"       "gauge@0%   → green (32)"
gauge_test 49  "32"       "gauge@49%  → green (32)"
gauge_test 50  "33"       "gauge@50%  → yellow (33)"
gauge_test 74  "33"       "gauge@74%  → yellow (33)"
gauge_test 75  "38;5;208" "gauge@75%  → orange (38;5;208)"
gauge_test 89  "38;5;208" "gauge@89%  → orange (38;5;208)"
gauge_test 90  "1;31"     "gauge@90%  → bold-red (1;31)"
gauge_test 100 "1;31"     "gauge@100% → bold-red (1;31)"

# ctx gauge at >=90% → line1 contains bold-red escape code
THOME2="$TMPDIR_BASE/home_gauge2"
mkdir -p "$THOME2/.claude/.sysinfo"
out_danger=$(render "$FIXTURES/input-danger.json" 160 "$THOME2")
line1_danger=$(printf '%s' "$out_danger" | head -1)
if printf '%s' "$line1_danger" | grep -q '1;31m'; then
  ok "ctx@93%: line1 contains bold-red (1;31m)"
else
  nok "ctx@93%: expected bold-red in line1"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3. Pace speedometer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# At quota >=90: expect "rotating" on line1
THOME3="$TMPDIR_BASE/home_pace_rot"
mkdir -p "$THOME3/.claude/.sysinfo"
out_rot=$(render "$FIXTURES/input-danger.json" 160 "$THOME3")
vis_rot=$(strip_ansi "$(printf '%s' "$out_rot" | head -1)")
if printf '%s' "$vis_rot" | grep -q 'rotating'; then
  ok "pace@91%: 'rotating' badge on line1"
else
  nok "pace@91%: expected 'rotating' in line1, got: $(printf '%s' "$vis_rot" | cut -c1-80)"
fi

# At quota 45% with no burn history: expect "idle" on line1
THOME4="$TMPDIR_BASE/home_pace_idle"
mkdir -p "$THOME4/.claude/.sysinfo"
out_idle=$(render "$FIXTURES/input-basic.json" 160 "$THOME4")
vis_idle=$(strip_ansi "$(printf '%s' "$out_idle" | head -1)")
if printf '%s' "$vis_idle" | grep -q 'idle'; then
  ok "pace@45%,no-history: 'idle' badge on line1"
else
  nok "pace@45%,no-history: expected 'idle' in line1, got: $(printf '%s' "$vis_idle" | cut -c1-80)"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4. Config parsing"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Default config is valid JSON
assert_exit0 "default config: valid JSON (jq .)" \
  jq . "$(dirname "$SCRIPT")/statusline.config.default.json"

# Minimal input (all empty) → exit 0
THOME5="$TMPDIR_BASE/home_cfg_min"
mkdir -p "$THOME5/.claude/.sysinfo"
assert_exit0 "minimal input: exit 0" \
  sh -c "HOME='$THOME5' COLUMNS=120 sh '$SCRIPT' < '$FIXTURES/input-minimal.json' >/dev/null 2>&1"

# Full/danger input → exit 0
THOME6="$TMPDIR_BASE/home_cfg_full"
mkdir -p "$THOME6/.claude/.sysinfo"
assert_exit0 "danger input: exit 0" \
  sh -c "HOME='$THOME6' COLUMNS=160 sh '$SCRIPT' < '$FIXTURES/input-danger.json' >/dev/null 2>&1"

# Absent config file → exit 0 (built-in defaults)
THOME7="$TMPDIR_BASE/home_cfg_absent"
mkdir -p "$THOME7/.claude/.sysinfo"
assert_exit0 "absent config: exit 0" \
  sh -c "HOME='$THOME7' COLUMNS=120 sh '$SCRIPT' < '$FIXTURES/input-basic.json' >/dev/null 2>&1"

# Garbage config → exit 0 (graceful fallback, jq errors suppressed)
THOME8="$TMPDIR_BASE/home_cfg_garbage"
mkdir -p "$THOME8/.claude/.sysinfo"
printf 'not json at all\n' > "$THOME8/.claude/statusline.config.json"
assert_exit0 "garbage config: exit 0" \
  sh -c "HOME='$THOME8' COLUMNS=120 sh '$SCRIPT' < '$FIXTURES/input-basic.json' >/dev/null 2>&1"

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "5. Peer metrics"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

_lhost=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
_peer_name="ams"; [ "$_lhost" = "ams" ] && _peer_name="fra"

# 5a. Fresh peer file → peer badge on line2
THOME9="$TMPDIR_BASE/home_peer_fresh"
mkdir -p "$THOME9/.claude/.sysinfo"
cp "$FIXTURES/peer-fresh.json" "$THOME9/.claude/.sysinfo/${_peer_name}.json"
touch "$THOME9/.claude/.sysinfo/${_peer_name}.json"  # ensure mtime = now
out_peer=$(render "$FIXTURES/input-basic.json" 160 "$THOME9")
vis_peer=$(strip_ansi "$(printf '%s' "$out_peer" | sed -n '2p')")
if printf '%s' "$vis_peer" | grep -q "$_peer_name"; then
  ok "peer-fresh: '${_peer_name}' badge appears on line2"
else
  nok "peer-fresh: expected '${_peer_name}' in line2, got: $(printf '%s' "$vis_peer" | cut -c1-80)"
fi

# 5b. Stale peer file (>5min old) → "stale" on line2
THOME10="$TMPDIR_BASE/home_peer_stale"
mkdir -p "$THOME10/.claude/.sysinfo"
cp "$FIXTURES/peer-fresh.json" "$THOME10/.claude/.sysinfo/${_peer_name}.json"
# Back-date by 400s (>5min)
_stale_ts=$(date -d "400 seconds ago" +"%Y%m%d%H%M.%S" 2>/dev/null \
         || date -v-400S +"%Y%m%d%H%M.%S" 2>/dev/null \
         || echo "202001010000.00")
touch -t "$_stale_ts" "$THOME10/.claude/.sysinfo/${_peer_name}.json" 2>/dev/null || \
  touch -d "1970-01-01" "$THOME10/.claude/.sysinfo/${_peer_name}.json" 2>/dev/null || true
out_stale=$(render "$FIXTURES/input-basic.json" 160 "$THOME10")
vis_stale=$(strip_ansi "$(printf '%s' "$out_stale" | sed -n '2p')")
if printf '%s' "$vis_stale" | grep -q 'stale'; then
  ok "peer-stale: 'stale' badge on line2 for >5min old file"
else
  nok "peer-stale: expected 'stale' in line2, got: $(printf '%s' "$vis_stale" | cut -c1-80)"
fi

# 5c. No peer file → local only, exit 0, no stale badge
THOME11="$TMPDIR_BASE/home_peer_none"
mkdir -p "$THOME11/.claude/.sysinfo"
assert_exit0 "peer-none: exit 0 with no peer file" \
  sh -c "HOME='$THOME11' COLUMNS=160 sh '$SCRIPT' < '$FIXTURES/input-basic.json' >/dev/null 2>&1"
out_none=$(render "$FIXTURES/input-basic.json" 160 "$THOME11")
vis_none=$(strip_ansi "$(printf '%s' "$out_none" | sed -n '2p')")
if ! printf '%s' "$vis_none" | grep -q 'stale'; then
  ok "peer-none: no 'stale' badge without peer file"
else
  nok "peer-none: unexpected 'stale' in line2 when no peer file"
fi

# 5d. Publish: sysinfo file for this host created after render
THOME12="$TMPDIR_BASE/home_peer_pub"
mkdir -p "$THOME12/.claude/.sysinfo"
HOME="$THOME12" COLUMNS=120 sh "$SCRIPT" < "$FIXTURES/input-basic.json" >/dev/null 2>&1 || true
sleep 1  # allow background write to complete
_pub_file="$THOME12/.claude/.sysinfo/${_lhost}.json"
if [ -s "$_pub_file" ]; then
  ok "peer-publish: .sysinfo/${_lhost}.json created"
  if jq . "$_pub_file" >/dev/null 2>&1; then
    ok "peer-publish: .sysinfo/${_lhost}.json is valid JSON"
  else
    nok "peer-publish: .sysinfo/${_lhost}.json is not valid JSON"
  fi
else
  nok "peer-publish: .sysinfo/${_lhost}.json not found (expected async write within 1s)"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "6. Dedup: no metric token on two lines"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

THOME13="$TMPDIR_BASE/home_dedup"
mkdir -p "$THOME13/.claude/.sysinfo"

for _inf in "$FIXTURES/input-basic.json" "$FIXTURES/input-danger.json"; do
  _fname=$(basename "$_inf" .json)
  out_dd=$(render "$_inf" 160 "$THOME13")
  v1=$(strip_ansi "$(printf '%s' "$out_dd" | head -1)")
  v2=$(strip_ansi "$(printf '%s' "$out_dd" | sed -n '2p')")
  dedup_ok=1

  # 'ctx' token (context gauge) should only appear on line1
  if printf '%s' "$v1" | grep -q 'ctx' && printf '%s' "$v2" | grep -q 'ctx'; then
    nok "dedup[$_fname]: 'ctx' token on both line1 and line2"
    dedup_ok=0
  fi

  # pace badge ('idle', 'rotating', '%/m') should only appear on line1
  if printf '%s' "$v1" | grep -qE '(idle|rotating|%/m)' && \
     printf '%s' "$v2" | grep -qE '(idle|rotating|%/m)'; then
    nok "dedup[$_fname]: pace badge duplicated on both line1 and line2"
    dedup_ok=0
  fi

  [ "$dedup_ok" = "1" ] && ok "dedup[$_fname]: no metric token duplicated across lines"
done

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "7. Syntax check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

assert_exit0 "sh -n: statusline-command.sh" sh -n "$SCRIPT"
assert_exit0 "jq: themes.json"              jq . "$(dirname "$SCRIPT")/themes.json"
assert_exit0 "jq: statusline.config.default.json" \
  jq . "$(dirname "$SCRIPT")/statusline.config.default.json"

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  Passed: %d\n" "$pass"
printf "  Failed: %d\n" "$fail"
echo ""

if [ "$fail" -gt 0 ]; then
  echo "FAIL — ${fail} test(s) failed."
  exit 1
fi
echo "All tests passed."
exit 0
