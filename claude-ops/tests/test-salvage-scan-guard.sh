#!/usr/bin/env bash
# test-salvage-scan-guard.sh — Verifies the single-instance lock + timeout guard
# added to ops-merge-salvage-scan.
#
# Test cases:
#   (a) Single invocation completes and emits valid JSON within timeout.
#   (b) A 2nd concurrent invocation exits fast (<1s) without doing work.
#   (c) A stale lock (dead PID written in lock dir) is reclaimed by the next run.
#
# These tests are OFFLINE — they never call git fetch or gh. They exercise only
# the guard machinery by pointing the script at an empty/nonexistent registry so
# the body exits immediately after the guard path runs.
#
# Usage:  bash tests/test-salvage-scan-guard.sh
# Exit 0  = all pass, non-zero = at least one failure.

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$PLUGIN_ROOT/bin/ops-merge-salvage-scan"

pass=0
fail=0
ok()  { echo "  PASS: $*"; pass=$((pass+1)); }
err() { echo "  FAIL: $*"; fail=$((fail+1)); }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Unique lock dir for each test run so leftover locks from a previous aborted
# run don't interfere.
TEST_LOCK_DIR="${TMPDIR:-/tmp}/.ops-merge-salvage-scan.lock"

cleanup() {
  rm -rf "$TEST_LOCK_DIR" 2>/dev/null || true
  rm -rf "$TEST_TMPDIR" 2>/dev/null || true
}
TEST_TMPDIR=$(mktemp -d)
trap cleanup EXIT INT TERM

# Build a minimal registry that causes the script to exit almost immediately
# (no projects → body loop does nothing → emits {"repos":[],...}).
# registry-path.sh always overwrites REGISTRY from OPS_DATA_DIR, so point
# OPS_DATA_DIR at our temp dir which contains the fake registry.json.
cat > "$TEST_TMPDIR/registry.json" <<'EOF'
{"projects":[]}
EOF

# Wrapper: run the script with OPS_DATA_DIR pointing at our temp dir (so
# registry-path.sh resolves to the fake registry) and with a short deadline
# so the test suite itself stays quick.
run_scan() {
  OPS_SALVAGE_DEADLINE=30 \
  OPS_SALVAGE_NET_TIMEOUT=5 \
  OPS_SALVAGE_GIT_TIMEOUT=3 \
  OPS_DATA_DIR="$TEST_TMPDIR" \
    bash "$SCRIPT" "$@"
}

# ---------------------------------------------------------------------------
# Pre-flight: script must be executable and pass syntax check
# ---------------------------------------------------------------------------
echo "=== ops-merge-salvage-scan guard tests ==="
echo ""

if [[ ! -x "$SCRIPT" ]]; then
  echo "FATAL: $SCRIPT is not executable"
  exit 1
fi

bash -n "$SCRIPT" 2>/dev/null && ok "syntax check passes" || { err "syntax check failed"; exit 1; }

# ---------------------------------------------------------------------------
# (a) Single invocation completes within timeout and emits valid JSON
# ---------------------------------------------------------------------------
echo ""
echo "--- (a) single invocation produces valid JSON ---"

cleanup  # ensure no stale lock from a prior aborted run

t_start=$(date +%s)
output=$(run_scan 2>/dev/null)
rc=$?
t_end=$(date +%s)
elapsed=$(( t_end - t_start ))

if [[ $rc -eq 0 ]]; then
  ok "exits 0"
else
  err "exited $rc (expected 0)"
fi

if echo "$output" | jq -e '.repos' >/dev/null 2>&1; then
  ok "output is valid JSON with .repos key"
else
  err "output is not valid JSON: $output"
fi

if [[ $elapsed -lt 30 ]]; then
  ok "completed in ${elapsed}s (< 30s deadline)"
else
  err "took ${elapsed}s — exceeded 30s deadline"
fi

# ---------------------------------------------------------------------------
# (b) 2nd concurrent invocation exits fast (<1s) without doing work
# ---------------------------------------------------------------------------
echo ""
echo "--- (b) 2nd concurrent invocation exits immediately (lock held) ---"

cleanup

# Hold the lock artificially by creating the dir with our own PID, then run a
# 2nd invocation which should see the lock as live (our PID is alive) and exit.
mkdir -p "$TEST_LOCK_DIR"
echo $$ > "$TEST_LOCK_DIR/pid"

t_start=$(date +%s)
output2=$(run_scan 2>/dev/null)
rc2=$?
t_end=$(date +%s)
elapsed2=$(( t_end - t_start ))

# Clean up the artificial lock before assertions so the next test starts clean.
rm -rf "$TEST_LOCK_DIR" 2>/dev/null || true

if [[ $rc2 -eq 0 ]]; then
  ok "2nd invocation exits 0"
else
  err "2nd invocation exited $rc2 (expected 0)"
fi

if echo "$output2" | jq -e '.skipped == "already-running"' >/dev/null 2>&1; then
  ok "2nd invocation emits already-running sentinel"
else
  err "2nd invocation output missing skipped:already-running — got: $output2"
fi

if [[ $elapsed2 -lt 2 ]]; then
  ok "2nd invocation returned in ${elapsed2}s (< 2s)"
else
  err "2nd invocation took ${elapsed2}s — should exit immediately"
fi

# ---------------------------------------------------------------------------
# (c) Stale lock (dead PID) is reclaimed — scan runs normally
# ---------------------------------------------------------------------------
echo ""
echo "--- (c) stale lock (dead PID) is reclaimed ---"

cleanup

# Write a lock dir containing a PID that is guaranteed dead.
# Use PID 99999999 — far above any realistic PID on macOS (max ~99998).
mkdir -p "$TEST_LOCK_DIR"
echo "99999999" > "$TEST_LOCK_DIR/pid"

t_start=$(date +%s)
output3=$(run_scan 2>/dev/null)
rc3=$?
t_end=$(date +%s)
elapsed3=$(( t_end - t_start ))

if [[ $rc3 -eq 0 ]]; then
  ok "exits 0 after reclaiming stale lock"
else
  err "exited $rc3 after stale-lock reclaim (expected 0)"
fi

if echo "$output3" | jq -e '.repos' >/dev/null 2>&1; then
  ok "emits valid JSON (not already-running) after reclaim"
else
  err "output after stale-lock reclaim not valid JSON: $output3"
fi

if echo "$output3" | jq -e '.skipped' >/dev/null 2>&1; then
  err "still emitting skipped sentinel — stale lock was NOT reclaimed"
else
  ok "no skipped sentinel — stale lock was reclaimed and scan ran"
fi

if [[ $elapsed3 -lt 30 ]]; then
  ok "completed in ${elapsed3}s after reclaim (< 30s)"
else
  err "took ${elapsed3}s after reclaim — exceeded deadline"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================="
echo "Results: $pass passed, $fail failed"
echo "======================================="
[[ $fail -eq 0 ]] && exit 0 || exit 1
