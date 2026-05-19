#!/usr/bin/env bash
# test-resolve-cred-strict.sh — golden table for resolve_cred_strict rc=0/1/2
#
# rc=0: ref declared + resolver returns non-empty value
# rc=1: ref is empty / null / not set (not configured — expected)
# rc=2: ref is declared but resolver returns empty (broken)
set -euo pipefail

LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/ga4-resolve.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — expected rc=$2 got rc=$3${4:+ val='$4'}"; fail=$((fail+1)); }

echo "Testing resolve_cred_strict golden table in $LIB"
echo ""

# Stub OPS_DATA_DIR so the guard doesn't bail
export OPS_DATA_DIR="${TMPDIR:-/tmp}"
# Guard against double-source (reset for test)
unset _GA4_RESOLVE_LOADED
# shellcheck disable=SC1090
. "$LIB"

# Helper: capture both stdout and rc without triggering set -e on non-zero rc
_strict() { local _r; _r="$(resolve_cred_strict "$1" 2>/dev/null)" && { printf '%s' "$_r"; return 0; } || return $?; }

# ── Case 1: empty ref → rc=1 (not configured) ────────────────────────────────
val=""; rc=0
val="$(_strict "" 2>/dev/null)" || rc=$?
if [ "$rc" = "1" ] && [ -z "$val" ]; then
  ok "empty ref → rc=1"
else
  err "empty ref → rc=1" 1 "$rc" "$val"
fi

# ── Case 2: null string ref → rc=1 (not configured) ──────────────────────────
val=""; rc=0
val="$(_strict "null" 2>/dev/null)" || rc=$?
if [ "$rc" = "1" ] && [ -z "$val" ]; then
  ok "'null' string ref → rc=1"
else
  err "'null' string ref → rc=1" 1 "$rc" "$val"
fi

# ── Case 3: inline literal ref (non-empty) → rc=0 ────────────────────────────
val=""; rc=0
val="$(_strict "my-literal-value" 2>/dev/null)" || rc=$?
if [ "$rc" = "0" ] && [ "$val" = "my-literal-value" ]; then
  ok "inline literal → rc=0, val=my-literal-value"
else
  err "inline literal → rc=0" 0 "$rc" "$val"
fi

# ── Case 4: env:VAR where VAR is set → rc=0 ──────────────────────────────────
export _TEST_RC_STRICT_VAR="hello-from-env"
val=""; rc=0
val="$(_strict "env:_TEST_RC_STRICT_VAR" 2>/dev/null)" || rc=$?
if [ "$rc" = "0" ] && [ "$val" = "hello-from-env" ]; then
  ok "env:VAR (set) → rc=0"
else
  err "env:VAR (set) → rc=0" 0 "$rc" "$val"
fi
unset _TEST_RC_STRICT_VAR

# ── Case 5: env:VAR where VAR is unset → rc=2 (declared but empty) ───────────
unset _TEST_RC_STRICT_MISSING 2>/dev/null || true
val=""; rc=0
val="$(_strict "env:_TEST_RC_STRICT_MISSING" 2>/dev/null)" || rc=$?
if [ "$rc" = "2" ] && [ -z "$val" ]; then
  ok "env:VAR (unset) → rc=2 (broken)"
else
  err "env:VAR (unset) → rc=2" 2 "$rc" "$val"
fi

# ── Case 6: doppler: ref but doppler returns empty (stubbed) ──────────────────
_orig_path="$PATH"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
cat > "$STUB_DIR/doppler" <<'SH'
#!/usr/bin/env bash
printf ''
exit 0
SH
chmod +x "$STUB_DIR/doppler"
export PATH="$STUB_DIR:$PATH"

# Re-source with stubbed doppler in PATH
unset _GA4_RESOLVE_LOADED
# shellcheck disable=SC1090
. "$LIB"
_strict() { local _r; _r="$(resolve_cred_strict "$1" 2>/dev/null)" && { printf '%s' "$_r"; return 0; } || return $?; }

val=""; rc=0
val="$(_strict "doppler:myproject/prd/MY_SECRET" 2>/dev/null)" || rc=$?
if [ "$rc" = "2" ] && [ -z "$val" ]; then
  ok "doppler: ref (empty result) → rc=2 (broken)"
else
  err "doppler: ref (empty result) → rc=2" 2 "$rc" "$val"
fi

# ── Case 7: doppler: ref with real value (stubbed) ───────────────────────────
cat > "$STUB_DIR/doppler" <<'SH'
#!/usr/bin/env bash
printf 'real-secret-value'
exit 0
SH

val=""; rc=0
val="$(_strict "doppler:myproject/prd/MY_SECRET" 2>/dev/null)" || rc=$?
if [ "$rc" = "0" ] && [ "$val" = "real-secret-value" ]; then
  ok "doppler: ref (non-empty result) → rc=0"
else
  err "doppler: ref (non-empty result) → rc=0" 0 "$rc" "$val"
fi

export PATH="$_orig_path"

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
