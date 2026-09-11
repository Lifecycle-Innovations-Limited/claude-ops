#!/usr/bin/env bash
# Defect: sync-installed-copy.sh overwrote ~/.claude/mcp-proxy/outbound-guard.mjs
# unconditionally, on every SessionStart, with whatever outbound-guard.mjs the checkout
# carried — no check that those bytes were newer or even compatible, stdout and stderr on
# /dev/null, `|| true` in setup.sh. On a machine whose installed guard was the current
# reservation-schema version and whose plugin copy was still the old count-schema one,
# that silently DOWNGRADED a security guard. It fails closed, so nothing leaks, but the
# two-phase commit for MCP-proxy-routed sends stops working and approvals are never
# redeemed. The only thing that stopped it on the affected machine was a hand-set `uchg`
# flag, and 304 leaked .tmp.<pid> files were the evidence that the script had been
# failing in the dark for a long time.
#
# This test proves the sync is now a guarded, one-directional upgrade: it still refreshes
# a stale copy, it REFUSES an installed copy whose schema it cannot place, it refuses to
# move backwards, and it never leaves a .tmp.* file behind when it fails.
#
# Run: bash claude-ops/tests/outbound-guard/test-installed-copy-sync.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../scripts/outbound-guard" && pwd)"
SYNC="$SRC/sync-installed-copy.sh"
MJS="$SRC/outbound-guard.mjs"

fail=0
ok(){ echo "  ok   $1"; }
bad(){ echo "  FAIL $1"; fail=$((fail+1)); }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', expected '$3'"; fi; }

TMPHOME="$(mktemp -d)"
trap 'rm -rf "$TMPHOME"' EXIT
INSTALLED="$TMPHOME/.claude/mcp-proxy/outbound-guard.mjs"
no_tmp(){ [ -z "$(find "$TMPHOME/.claude/mcp-proxy" -name 'outbound-guard.mjs.tmp.*' 2>/dev/null)" ]; }

echo "1. sync script exists and is executable"
if [ -x "$SYNC" ]; then ok "sync script present"; else bad "sync script missing at $SYNC"; fi

echo "2. the shipped source carries a recognised schema marker"
marker="$(sed -n 's|^[[:space:]]*//[[:space:]]*outbound-guard-schema:[[:space:]]*\([A-Za-z0-9._-]\{1,\}\).*$|\1|p' "$MJS" | head -1)"
if [ -n "$marker" ]; then ok "source schema marker: $marker"; else bad "source has no // outbound-guard-schema: marker"; fi

echo "3. the shipped source is the delegating guard, not the old count store"
if grep -q 'claimReservation' "$MJS" && grep -q 'outbound_guard\.py' "$MJS"; then
  ok "source exposes claimReservation() and delegates to outbound_guard.py"
else
  bad "source is not the current reservation-schema guard"
fi
if grep -v '^[[:space:]]*//' "$MJS" | grep -q 'd\.remaining'; then
  bad "source code still reads the dead d.remaining field"
else
  ok "no live read of d.remaining (the field outbound_guard.py stopped writing)"
fi

echo "4. fresh install: no installed copy yet -> sync creates one matching the repo"
HOME="$TMPHOME" bash "$SYNC" >/dev/null 2>&1
chk "exit 0 on fresh install" "$?" "0"
if [ -f "$INSTALLED" ]; then ok "installed copy created"; else bad "installed copy not created at $INSTALLED"; fi
if diff -q "$MJS" "$INSTALLED" >/dev/null 2>&1; then ok "installed copy byte-identical to repo"; else bad "installed copy differs from repo source"; fi
if no_tmp; then ok "no .tmp.* left behind"; else bad ".tmp.* leaked"; fi

echo "5. re-run is idempotent and says so"
out="$(HOME="$TMPHOME" bash "$SYNC" 2>&1)"; rc=$?
chk "exit 0 on re-run" "$rc" "0"
case "$out" in *"already current"*) ok "reports already current" ;; *) bad "expected 'already current', got: $out" ;; esac

echo "6. stale legacy copy: an older known schema is refreshed, not left alone"
cat > "$INSTALLED" <<'OLD'
// old pre-consolidation guard
export const SPENT_WINDOW_SEC = 120;
export function consume(){ const d = read(); let remaining = Number(d.remaining ?? 0); return remaining > 0; }
OLD
out="$(HOME="$TMPHOME" bash "$SYNC" 2>&1)"; rc=$?
chk "exit 0 syncing over a legacy copy" "$rc" "0"
if diff -q "$MJS" "$INSTALLED" >/dev/null 2>&1; then ok "legacy copy upgraded to current schema"; else bad "legacy copy was NOT refreshed"; fi

echo "7. UNRECOGNISED installed schema is refused, loudly, and left untouched"
printf '// hand-edited guard nobody can place\nexport function mystery(){ return true; }\n' > "$INSTALLED"
before="$(cat "$INSTALLED")"
err="$(HOME="$TMPHOME" bash "$SYNC" 2>&1 >/dev/null)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "non-zero exit ($rc)"; else bad "refusal must not exit 0"; fi
case "$err" in *REFUSED*unrecognised*|*unrecognised*REFUSED*) ok "stderr names the refusal and the reason" ;; *) bad "stderr unclear: $err" ;; esac
chk "installed file untouched" "$(cat "$INSTALLED")" "$before"
if no_tmp; then ok "no .tmp.* left behind by the refusal"; else bad ".tmp.* leaked on refusal"; fi

echo "8. --force is the deliberate escape hatch for case 7"
HOME="$TMPHOME" bash "$SYNC" --force >/dev/null 2>&1
chk "exit 0 with --force" "$?" "0"
if diff -q "$MJS" "$INSTALLED" >/dev/null 2>&1; then ok "--force replaced the unknown copy"; else bad "--force did not sync"; fi

echo "9. a NEWER installed copy is refused: the sync only moves forward"
sed 's|// outbound-guard-schema: .*|// outbound-guard-schema: reservation-v99|' "$MJS" > "$INSTALLED"
before="$(cat "$INSTALLED")"
err="$(HOME="$TMPHOME" bash "$SYNC" 2>&1 >/dev/null)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "non-zero exit ($rc)"; else bad "downgrade must not exit 0"; fi
case "$err" in *DOWNGRADE*|*newer*) ok "stderr says it would downgrade" ;; *) bad "stderr unclear: $err" ;; esac
chk "newer installed file untouched" "$(cat "$INSTALLED")" "$before"

echo "10. a failed sync leaves no .tmp.* behind (trap on EXIT)"
rm -f "$INSTALLED"
SHIM="$TMPHOME/shim"; mkdir -p "$SHIM"
printf '#!/bin/sh\nexit 1\n' > "$SHIM/mv"; chmod +x "$SHIM/mv"
HOME="$TMPHOME" PATH="$SHIM:$PATH" bash "$SYNC" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then ok "sync failed as arranged ($rc)"; else bad "mv shim did not make the sync fail"; fi
if no_tmp; then ok "no .tmp.* left behind after a mid-sync failure"; else bad ".tmp.* leaked: $(find "$TMPHOME/.claude/mcp-proxy" -name 'outbound-guard.mjs.tmp.*')"; fi

echo
[ "$fail" -eq 0 ] && echo "ALL GOOD" || echo "$fail FAIL"
exit $fail
