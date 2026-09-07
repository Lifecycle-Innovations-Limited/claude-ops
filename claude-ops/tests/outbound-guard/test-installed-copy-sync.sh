#!/usr/bin/env bash
# Defect: outbound_guard.py's docstring claims the Node twin is "installed at
# ~/.claude/mcp-proxy/outbound-guard.mjs" and "reads and writes this same file with
# the same rules" as the repo copy. Nothing in the repo ever creates or refreshes that
# installed copy, so on a real machine the claim is either false (no file at all) or,
# worse, true-but-stale: a copy installed once and never updated again drifts onto an
# outdated schema every time outbound-guard.mjs changes in the repo, silently
# disagreeing with outbound_guard.py about state-file shape.
#
# This test proves scripts/outbound-guard/sync-installed-copy.sh keeps that installed
# copy byte-identical to the repo source, including refreshing a copy that was already
# there under an old (stale) schema.
#
# Run: bash claude-ops/tests/outbound-guard/test-installed-copy-sync.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../scripts/outbound-guard" && pwd)"
SYNC="$SRC/sync-installed-copy.sh"
MJS="$SRC/outbound-guard.mjs"

fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', expected '$3'"; fail=$((fail+1)); fi; }

TMPHOME="$(mktemp -d)"
trap 'rm -rf "$TMPHOME"' EXIT

echo "1. sync script exists and is executable"
if [ -x "$SYNC" ]; then echo "  ok   sync script present"; else echo "  FAIL sync script missing at $SYNC"; fail=$((fail+1)); fi

echo "2. fresh install: no installed copy yet -> sync creates one matching the repo"
HOME="$TMPHOME" bash "$SYNC" >/dev/null 2>&1
INSTALLED="$TMPHOME/.claude/mcp-proxy/outbound-guard.mjs"
if [ -f "$INSTALLED" ]; then echo "  ok   installed copy created"; else echo "  FAIL installed copy not created at $INSTALLED"; fail=$((fail+1)); fi
if diff -q "$MJS" "$INSTALLED" >/dev/null 2>&1; then
  echo "  ok   installed copy byte-identical to repo"
else
  echo "  FAIL installed copy differs from repo source"
  fail=$((fail+1))
fi

echo "3. stale copy: an old schema on disk must be refreshed, not left alone"
echo "// old, pre-consolidation schema — must NOT survive a sync" > "$INSTALLED"
HOME="$TMPHOME" bash "$SYNC" >/dev/null 2>&1
if diff -q "$MJS" "$INSTALLED" >/dev/null 2>&1; then
  echo "  ok   stale installed copy refreshed to current schema"
else
  echo "  FAIL stale installed copy was NOT refreshed (still on old schema)"
  fail=$((fail+1))
fi

echo
[ "$fail" -eq 0 ] && echo "ALL GOOD" || echo "$fail FAIL"
exit $fail
