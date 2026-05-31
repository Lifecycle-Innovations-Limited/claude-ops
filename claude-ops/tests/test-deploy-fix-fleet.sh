#!/usr/bin/env bash
# test-deploy-fix-fleet.sh — Hermetic tests for fleet coexistence additions.
#
# Asserts:
#   (a) 4th concurrent dispatch returns rc=6 when 3 live pidfiles exist
#   (b) sidecar line appended with source=deploy-fix on launch
#   (c) returns rc=7 when fleet-tui.json shows an active agent on the repo
#   (d) proceeds (rc=0) when fleet-tui.json is missing
#
# Hermetic: temp HOME + STATE_DIR, stub `claude` + real `jq`, NO network.

set -u

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
MOCKS="$TESTS_DIR/mocks"

chmod +x "$MOCKS"/* 2>/dev/null || true

SUITE_TMP="$(mktemp -d -t ops-deploy-fix-fleet-tests.XXXXXX)"
trap 'rm -rf "$SUITE_TMP"' EXIT

PASS=0
FAIL=0
FAILED_CASES=()

pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  FAIL: %s -- %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_CASES+=("$1"); }

assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected='$2' actual='$3'"; fi
}
assert_file_exists() {
  if [ -f "$2" ]; then pass "$1"; else fail "$1" "missing file: $2"; fi
}
assert_contains() {
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "needle='$2' not in haystack" ;; esac
}

# ---------------------------------------------------------------------------
# Isolated env setup (exports OPS_DEPLOY_FIX_STATE/LOGS + fake HOME)
# ---------------------------------------------------------------------------
new_isolated_env() {
  local id="$1"
  TEST_STATE="$SUITE_TMP/$id/state"
  TEST_LOGS="$SUITE_TMP/$id/logs"
  TEST_BIN="$SUITE_TMP/$id/bin"
  TEST_HOME="$SUITE_TMP/$id/home"
  TEST_FLEET_STATE="$TEST_HOME/.claude/state"
  mkdir -p "$TEST_STATE" "$TEST_LOGS" "$TEST_BIN" "$TEST_FLEET_STATE"
  mkdir -p "$TEST_STATE/active"

  # Symlink mocks
  for m in gh curl terminal-notifier; do
    ln -sf "$MOCKS/$m" "$TEST_BIN/$m"
  done
  # Stub claude: write argv to log, write prompt to prompt-out, exit 0
  cat > "$TEST_BIN/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${MOCK_CLAUDE_LOG:-/dev/null}"
PROMPT_OUT="${MOCK_CLAUDE_PROMPT_OUT:-/dev/null}"
prompt="$(cat)"
printf '%s' "$prompt" > "$PROMPT_OUT"
printf 'argv=%s\n' "$*" >> "$LOG"
exit "${MOCK_CLAUDE_RC:-0}"
STUB
  chmod +x "$TEST_BIN/claude"

  export OPS_DEPLOY_FIX_STATE="$TEST_STATE"
  export OPS_DEPLOY_FIX_LOGS="$TEST_LOGS"
  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  export HOME="$TEST_HOME"
  export MOCK_CLAUDE_LOG="$TEST_LOGS/claude.log"
  export MOCK_CLAUDE_PROMPT_OUT="$TEST_LOGS/claude-prompt.txt"
  export MOCK_CURL_LOG="$TEST_LOGS/curl.log"
  export MOCK_NOTIFIER_LOG="$TEST_LOGS/notifier.log"
  : > "$TEST_LOGS/claude.log"
  : > "$TEST_LOGS/curl.log"
  : > "$TEST_LOGS/notifier.log"

  ORIGINAL_PATH="${ORIGINAL_PATH:-$PATH}"
  export PATH="$TEST_BIN:$ORIGINAL_PATH"
}

load_lib() {
  # shellcheck disable=SC1091
  . "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh"
}

# ---------------------------------------------------------------------------
# CASE A — global concurrency cap: 4th dispatch returns rc=6
# ---------------------------------------------------------------------------
echo ""
echo "── Case A: global concurrency cap (rc=6) ─────────────────────────"

(
  new_isolated_env "caseA"
  load_lib
  # Create 3 live pidfiles with the current shell's PID (it is alive)
  echo $$ > "$TEST_STATE/active/fix-aaa-$$.pid"
  echo $$ > "$TEST_STATE/active/fix-bbb-$$.pid"
  echo $$ > "$TEST_STATE/active/fix-ccc-$$.pid"
  export CLAUDE_PLUGIN_OPTION_MAX_CONCURRENT_FIXERS=3
  export DEPLOY_FIX_REPO="owner/repo-a"
  rc=0
  dispatch_fix_agent "build-fixer" "owner-repo-a-deploy" "REPO=owner/repo-a" "SHA=aaa" >/dev/null 2>&1 || rc=$?
  assert_eq "A.rc-is-6" "6" "$rc"
) && PASS=$((PASS+1)) || { fail "caseA.concurrency-cap" "see above"; }


# ---------------------------------------------------------------------------
# CASE B — sidecar appended with source=deploy-fix on successful launch
# ---------------------------------------------------------------------------
echo ""
echo "── Case B: census sidecar written on launch ──────────────────────"

(
  new_isolated_env "caseB"
  load_lib
  export CLAUDE_PLUGIN_OPTION_REGISTER_IN_FLEET_CENSUS=true
  export DEPLOY_FIX_REPO="owner/repo-b"
  dispatch_fix_agent "build-fixer" "owner-repo-b-deploy" "REPO=owner/repo-b" "SHA=bbb" >/dev/null 2>&1
  rc=$?
  assert_eq "B.rc-is-0" "0" "$rc"
  # Wait for the nohup'd background to start (sidecar written synchronously before nohup)
  _sidecar="$TEST_HOME/.claude/state/deploy-fix-active.jsonl"
  assert_file_exists "B.sidecar-created" "$_sidecar"
  if [ -f "$_sidecar" ]; then
    content=$(cat "$_sidecar")
    assert_contains "B.source-field" '"source":"deploy-fix"' "$content"
    assert_contains "B.repo-field" '"repo":"owner/repo-b"' "$content"
    assert_contains "B.status-running" '"status":"running"' "$content"
  fi
) && true || { fail "caseB.sidecar" "see above"; }


# ---------------------------------------------------------------------------
# CASE C — fleet-claim dedup: rc=7 when fleet-tui.json has active agent on repo
# ---------------------------------------------------------------------------
echo ""
echo "── Case C: fleet-claim dedup (rc=7) ──────────────────────────────"

(
  new_isolated_env "caseC"
  load_lib
  export CLAUDE_PLUGIN_OPTION_RESPECT_FLEET_CLAIMS=true
  export DEPLOY_FIX_REPO="owner/repo-c"
  # Write a fleet-tui.json with an active agent on the same repo
  cat > "$TEST_HOME/.claude/state/fleet-tui.json" <<'JSON'
{
  "ts": "2026-01-01T00:00:00Z",
  "agents": [
    {"id": "abc", "name": "feature-agent", "status": "running", "repo": "owner/repo-c", "branch": "feat/x"}
  ]
}
JSON
  rc=0
  dispatch_fix_agent "build-fixer" "owner-repo-c-deploy" "REPO=owner/repo-c" "SHA=ccc" >/dev/null 2>&1 || rc=$?
  assert_eq "C.rc-is-7" "7" "$rc"
) && PASS=$((PASS+1)) || { fail "caseC.fleet-dedup" "see above"; }


# ---------------------------------------------------------------------------
# CASE D — proceeds (rc=0) when fleet-tui.json is missing
# ---------------------------------------------------------------------------
echo ""
echo "── Case D: no fleet-tui.json → proceeds normally ─────────────────"

(
  new_isolated_env "caseD"
  load_lib
  export CLAUDE_PLUGIN_OPTION_RESPECT_FLEET_CLAIMS=true
  export DEPLOY_FIX_REPO="owner/repo-d"
  # Ensure no fleet-tui.json exists
  rm -f "$TEST_HOME/.claude/state/fleet-tui.json"
  rc=0
  dispatch_fix_agent "build-fixer" "owner-repo-d-deploy" "REPO=owner/repo-d" "SHA=ddd" >/dev/null 2>&1 || rc=$?
  assert_eq "D.rc-is-0" "0" "$rc"
) && PASS=$((PASS+1)) || { fail "caseD.missing-fleet-tui" "see above"; }


# ---------------------------------------------------------------------------
# CASE E — stale pidfiles are pruned before counting
# ---------------------------------------------------------------------------
echo ""
echo "── Case E: stale pidfiles pruned (dead PIDs don't count) ─────────"

(
  new_isolated_env "caseE"
  load_lib
  export CLAUDE_PLUGIN_OPTION_MAX_CONCURRENT_FIXERS=3
  export DEPLOY_FIX_REPO="owner/repo-e"
  # 3 pidfiles with a dead PID (99999 is almost certainly not alive)
  echo 99999 > "$TEST_STATE/active/fix-stale1-99999.pid"
  echo 99999 > "$TEST_STATE/active/fix-stale2-99999.pid"
  echo 99999 > "$TEST_STATE/active/fix-stale3-99999.pid"
  rc=0
  dispatch_fix_agent "build-fixer" "owner-repo-e-deploy" "REPO=owner/repo-e" "SHA=eee" >/dev/null 2>&1 || rc=$?
  # Stale pids should be pruned → 0 live → under cap → rc=0
  assert_eq "E.rc-is-0-after-prune" "0" "$rc"
) && PASS=$((PASS+1)) || { fail "caseE.stale-prune" "see above"; }


# ---------------------------------------------------------------------------
# CASE F — fleet-tui.json with INACTIVE status → proceeds (rc=0)
# ---------------------------------------------------------------------------
echo ""
echo "── Case F: fleet agent done/idle → not blocked ───────────────────"

(
  new_isolated_env "caseF"
  load_lib
  export CLAUDE_PLUGIN_OPTION_RESPECT_FLEET_CLAIMS=true
  export DEPLOY_FIX_REPO="owner/repo-f"
  cat > "$TEST_HOME/.claude/state/fleet-tui.json" <<'JSON'
{
  "ts": "2026-01-01T00:00:00Z",
  "agents": [
    {"id": "xyz", "name": "old-agent", "status": "completed", "repo": "owner/repo-f", "branch": "feat/y"}
  ]
}
JSON
  rc=0
  dispatch_fix_agent "build-fixer" "owner-repo-f-deploy" "REPO=owner/repo-f" "SHA=fff" >/dev/null 2>&1 || rc=$?
  assert_eq "F.rc-is-0-on-inactive" "0" "$rc"
) && PASS=$((PASS+1)) || { fail "caseF.inactive-fleet" "see above"; }


# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "deploy-fix-fleet test summary"
echo "═══════════════════════════════════════════════════════════════════"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failed cases:"
  for c in "${FAILED_CASES[@]}"; do echo "  - $c"; done
  exit 1
fi
exit 0
