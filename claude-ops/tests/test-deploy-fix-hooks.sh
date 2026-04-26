#!/usr/bin/env bash
# test-deploy-fix-hooks.sh — End-to-end test suite for the deploy/build auto-fix subsystem.
#
# Hermetic: no network, no real `gh` / `claude` / `curl` calls. Mocks live in tests/mocks/
# and are placed at the FRONT of $PATH for each test. State + logs are redirected into a
# per-suite temp dir via OPS_DEPLOY_FIX_STATE / OPS_DEPLOY_FIX_LOGS so the host's
# ~/.claude tree is never touched.
#
# Falls back to plain bash assertions if bats-core is not installed (we use plain bash
# unconditionally — the tests are simple enough that bats provides no marginal value).

set -u

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURES="$TESTS_DIR/fixtures"
MOCKS="$TESTS_DIR/mocks"

# Make mocks executable (idempotent — safe on every run)
chmod +x "$MOCKS"/* 2>/dev/null || true


# Capture the real sleep binary BEFORE any PATH overrides, so that wait-loops
# in tests that mock sleep (cases 9/10/11) still pause properly.
REAL_SLEEP=$(command -v sleep)
# Per-suite isolated state
SUITE_TMP="$(mktemp -d -t ops-deploy-fix-tests.XXXXXX)"
trap 'rm -rf "$SUITE_TMP"' EXIT

PASS=0
FAIL=0
FAILED_CASES=()

pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  FAIL: %s -- %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_CASES+=("$1"); }

# assert_eq <name> <expected> <actual>
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected='$2' actual='$3'"; fi
}
# assert_contains <name> <needle> <haystack>
assert_contains() {
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "needle='$2' missing in haystack" ;; esac
}
# assert_not_contains <name> <needle> <haystack>
assert_not_contains() {
  case "$3" in *"$2"*) fail "$1" "unexpected '$2' present" ;; *) pass "$1" ;; esac
}
# assert_file_exists <name> <path>
assert_file_exists() {
  if [ -f "$2" ]; then pass "$1"; else fail "$1" "missing file: $2"; fi
}
# assert_no_file <name> <path>
assert_no_file() {
  if [ ! -f "$2" ]; then pass "$1"; else fail "$1" "unexpected file: $2"; fi
}

# ---------------------------------------------------------------------------
# Fresh isolated env per case. Returns vars via globals (TEST_STATE/TEST_LOGS).
# ---------------------------------------------------------------------------
new_isolated_env() {
  local id="$1"
  TEST_STATE="$SUITE_TMP/$id/state"
  TEST_LOGS="$SUITE_TMP/$id/logs"
  TEST_BIN="$SUITE_TMP/$id/bin"
  mkdir -p "$TEST_STATE" "$TEST_LOGS" "$TEST_BIN"
  # Symlink mocks into a private bin so we control PATH ordering
  for m in gh claude curl terminal-notifier; do
    ln -sf "$MOCKS/$m" "$TEST_BIN/$m"
  done
  export OPS_DEPLOY_FIX_STATE="$TEST_STATE"
  export OPS_DEPLOY_FIX_LOGS="$TEST_LOGS"
  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  export MOCK_GH_LOG_FILE="$TEST_LOGS/gh.log"
  export MOCK_CLAUDE_LOG="$TEST_LOGS/claude.log"
  export MOCK_CLAUDE_PROMPT_OUT="$TEST_LOGS/claude-prompt.txt"
  export MOCK_CURL_LOG="$TEST_LOGS/curl.log"
  export MOCK_NOTIFIER_LOG="$TEST_LOGS/notifier.log"
  # Default: skip prefs file lookup by pointing it at /dev/null-ish path
  : > "$TEST_LOGS/gh.log"
  : > "$TEST_LOGS/claude.log"
  : > "$TEST_LOGS/curl.log"
  : > "$TEST_LOGS/notifier.log"
  # PATH: mocks first
  ORIGINAL_PATH="${ORIGINAL_PATH:-$PATH}"
  export PATH="$TEST_BIN:$ORIGINAL_PATH"
}

# Source the lib in a subshell-safe way
load_lib() {
  # shellcheck disable=SC1091
  . "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh"
}

# ===========================================================================
# CASE 1 — ops-deploy-fix-merge-trigger
# ===========================================================================
echo ""
echo "── Case 1: ops-deploy-fix-merge-trigger ──────────────────────────"

# 1a — happy path: detects gh pr merge, spawns monitor (lock file appears).
# Because the trigger nohup-spawns the real monitor (which would call mocked gh),
# we substitute the monitor with a stub that just writes a lock file + sentinel.
test_merge_trigger_happy() {
  new_isolated_env "case1-happy"
  # Stub the monitor: the trigger invokes "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh"
  # We can't override PLUGIN_ROOT (the trigger sets it from CLAUDE_PLUGIN_ROOT and
  # then sources the lib). Instead, we use a bind-style trick: copy the entire
  # plugin into the temp dir and swap the monitor script.
  local stage="$SUITE_TMP/case1-happy/plugin"
  mkdir -p "$stage/scripts" "$stage/scripts/lib" "$stage/bin"
  cp "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh" "$stage/scripts/lib/"
  cp "$PLUGIN_ROOT/bin/ops-deploy-fix-merge-trigger" "$stage/bin/"
  cat > "$stage/scripts/ops-deploy-monitor.sh" <<'STUB'
#!/usr/bin/env bash
# Stub monitor — writes a sentinel proving it was invoked with right args.
echo "$1 $2" > "$OPS_DEPLOY_FIX_LOGS/monitor-invoked.txt"
# Also create the monitor lock so we can verify lock-file write
slug=$(echo "$1" | tr '/' '-')
echo $$ > "$OPS_DEPLOY_FIX_STATE/lock-monitor-$slug-pr$2"
sleep 0.5
STUB
  chmod +x "$stage/scripts/ops-deploy-monitor.sh"
  export CLAUDE_PLUGIN_ROOT="$stage"

  out=$(cat "$FIXTURES/merge-trigger-input.json" | bash "$stage/bin/ops-deploy-fix-merge-trigger" 2>&1)
  rc=$?
  assert_eq "1a.exit-zero" "0" "$rc"
  assert_contains "1a.additional-context" "owner/repo#123" "$out"
  # Wait briefly for nohup'd stub to write
  for _ in 1 2 3 4 5 6 7 8; do
    [ -f "$TEST_LOGS/monitor-invoked.txt" ] && break
    sleep 0.2
  done
  assert_file_exists "1a.monitor-spawned" "$TEST_LOGS/monitor-invoked.txt"
  if [ -f "$TEST_LOGS/monitor-invoked.txt" ]; then
    assert_eq "1a.monitor-args" "owner/repo 123" "$(cat "$TEST_LOGS/monitor-invoked.txt")"
  fi
  assert_file_exists "1a.lock-written" "$TEST_STATE/lock-monitor-owner-repo-pr123"
}
test_merge_trigger_happy

# 1b — negative: gh pr list (not merge) → no spawn
test_merge_trigger_ignore_list() {
  new_isolated_env "case1-list"
  local stage="$SUITE_TMP/case1-list/plugin"
  mkdir -p "$stage/scripts" "$stage/scripts/lib" "$stage/bin"
  cp "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh" "$stage/scripts/lib/"
  cp "$PLUGIN_ROOT/bin/ops-deploy-fix-merge-trigger" "$stage/bin/"
  cat > "$stage/scripts/ops-deploy-monitor.sh" <<'STUB'
#!/usr/bin/env bash
touch "$OPS_DEPLOY_FIX_LOGS/monitor-invoked.txt"
STUB
  chmod +x "$stage/scripts/ops-deploy-monitor.sh"
  export CLAUDE_PLUGIN_ROOT="$stage"
  cat "$FIXTURES/merge-trigger-input-pr-list.json" | bash "$stage/bin/ops-deploy-fix-merge-trigger" >/dev/null 2>&1
  sleep 0.3
  assert_no_file "1b.no-spawn-on-pr-list" "$TEST_LOGS/monitor-invoked.txt"
}
test_merge_trigger_ignore_list

# 1c — negative: merge with no --repo flag → no spawn
test_merge_trigger_no_repo() {
  new_isolated_env "case1-norepo"
  local stage="$SUITE_TMP/case1-norepo/plugin"
  mkdir -p "$stage/scripts" "$stage/scripts/lib" "$stage/bin"
  cp "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh" "$stage/scripts/lib/"
  cp "$PLUGIN_ROOT/bin/ops-deploy-fix-merge-trigger" "$stage/bin/"
  cat > "$stage/scripts/ops-deploy-monitor.sh" <<'STUB'
#!/usr/bin/env bash
touch "$OPS_DEPLOY_FIX_LOGS/monitor-invoked.txt"
STUB
  chmod +x "$stage/scripts/ops-deploy-monitor.sh"
  export CLAUDE_PLUGIN_ROOT="$stage"
  cat "$FIXTURES/merge-trigger-input-no-repo.json" | bash "$stage/bin/ops-deploy-fix-merge-trigger" >/dev/null 2>&1
  sleep 0.3
  assert_no_file "1c.no-spawn-without-repo-flag" "$TEST_LOGS/monitor-invoked.txt"
}
test_merge_trigger_no_repo

# ===========================================================================
# CASE 2 — ops-deploy-fix-build-trigger
# ===========================================================================
echo ""
echo "── Case 2: ops-deploy-fix-build-trigger ──────────────────────────"

# Stub dispatch_fix_agent inside the lib by overriding the `claude` binary,
# but the trigger path also calls `git -C` and locate_repo. We keep it simple
# by setting auto_dispatch_fixer=false where we want NO dispatch, or by
# swapping in our mock claude.
test_build_trigger_fires_on_failure() {
  new_isolated_env "case2-fail"
  # Disable auto-rerun-of-transients false-positive: real failure (TS error)
  export CLAUDE_PLUGIN_OPTION_DEPLOY_FIX_ENABLED=true
  export CLAUDE_PLUGIN_OPTION_MONITOR_BUILD_FAILURES=true
  export CLAUDE_PLUGIN_OPTION_AUTO_DISPATCH_FIXER=true
  out=$(cat "$FIXTURES/build-trigger-fail.json" | bash "$PLUGIN_ROOT/bin/ops-deploy-fix-build-trigger" 2>&1)
  rc=$?
  assert_eq "2a.exit-zero" "0" "$rc"
  # Should have invoked the mock claude (dispatch happened)
  # Wait for the nohup'd background claude
  for _ in 1 2 3 4 5 6 7 8 10; do
    [ -s "$TEST_LOGS/claude.log" ] && break
    sleep 0.3
  done
  if [ -s "$TEST_LOGS/claude.log" ]; then
    pass "2a.fires-on-build-fail"
  else
    fail "2a.fires-on-build-fail" "claude mock never invoked"
  fi
}
test_build_trigger_fires_on_failure

test_build_trigger_skips_success() {
  new_isolated_env "case2-success"
  export CLAUDE_PLUGIN_OPTION_DEPLOY_FIX_ENABLED=true
  export CLAUDE_PLUGIN_OPTION_MONITOR_BUILD_FAILURES=true
  cat "$FIXTURES/build-trigger-success.json" | bash "$PLUGIN_ROOT/bin/ops-deploy-fix-build-trigger" >/dev/null 2>&1
  sleep 0.5
  if [ ! -s "$TEST_LOGS/claude.log" ]; then
    pass "2b.no-fire-on-success"
  else
    fail "2b.no-fire-on-success" "claude mock invoked on successful build"
  fi
}
test_build_trigger_skips_success

test_build_trigger_skips_test_cmd() {
  new_isolated_env "case2-test-cmd"
  export CLAUDE_PLUGIN_OPTION_DEPLOY_FIX_ENABLED=true
  export CLAUDE_PLUGIN_OPTION_MONITOR_BUILD_FAILURES=true
  cat "$FIXTURES/build-trigger-test-cmd.json" | bash "$PLUGIN_ROOT/bin/ops-deploy-fix-build-trigger" >/dev/null 2>&1
  sleep 0.5
  if [ ! -s "$TEST_LOGS/claude.log" ]; then
    pass "2c.no-fire-on-npm-test"
  else
    fail "2c.no-fire-on-npm-test" "claude invoked for non-build command"
  fi
}
test_build_trigger_skips_test_cmd

# ===========================================================================
# CASE 3 — is_transient
# ===========================================================================
echo ""
echo "── Case 3: is_transient() ────────────────────────────────────────"
( new_isolated_env "case3" ; load_lib
  if is_transient "npm error code E429"; then echo "  PASS: 3a.E429"; else echo "  FAIL: 3a.E429"; exit 1; fi
  if is_transient "Service Unavailable Exception"; then echo "  PASS: 3b.SUE"; else echo "  FAIL: 3b.SUE"; exit 1; fi
  if is_transient "The runner has received a shutdown signal"; then echo "  PASS: 3c.runner-shutdown"; else echo "  FAIL: 3c.runner-shutdown"; exit 1; fi
  if is_transient "error TS2322: Type 'string'"; then echo "  FAIL: 3d.TS2322-falsely-transient"; exit 1; else echo "  PASS: 3d.TS2322-not-transient"; fi
) && PASS=$((PASS+4)) || { fail "case3.is_transient" "see above"; }

# ===========================================================================
# CASE 4 — lock_acquire / lock_release
# ===========================================================================
echo ""
echo "── Case 4: lock_acquire / lock_release ───────────────────────────"
( new_isolated_env "case4" ; load_lib
  rc1=0; lock_acquire "x" || rc1=$?
  rc2=0; lock_acquire "x" || rc2=$?  # second call with first still alive
  if [ "$rc1" = "0" ] && [ "$rc2" = "1" ]; then echo "  PASS: 4a.second-call-blocked"; else echo "  FAIL: 4a got rc1=$rc1 rc2=$rc2"; exit 1; fi
  # Stale: write a lock with a dead PID
  echo 999999 > "$TEST_STATE/lock-stale"
  rc3=0; lock_acquire "stale" || rc3=$?
  if [ "$rc3" = "0" ]; then echo "  PASS: 4b.stale-reclaimed"; else echo "  FAIL: 4b got rc3=$rc3"; exit 1; fi
  lock_release "x"
  if [ ! -f "$TEST_STATE/lock-x" ]; then echo "  PASS: 4c.release-removes-file"; else echo "  FAIL: 4c"; exit 1; fi
) && PASS=$((PASS+3)) || { fail "case4.lock" "see above"; }

# ===========================================================================
# CASE 5 — budget_check_increment
# ===========================================================================
echo ""
echo "── Case 5: budget_check_increment ────────────────────────────────"
( new_isolated_env "case5" ; load_lib
  export CLAUDE_PLUGIN_OPTION_MAX_FIXES_PER_HOUR=3
  budget_check_increment "myrepo" || { echo "FAIL: 5.first"; exit 1; }
  budget_check_increment "myrepo" || { echo "FAIL: 5.second"; exit 1; }
  budget_check_increment "myrepo" || { echo "FAIL: 5.third"; exit 1; }
  rc=0; budget_check_increment "myrepo" || rc=$?
  if [ "$rc" = "1" ]; then echo "  PASS: 5a.fourth-call-blocked"; else echo "  FAIL: 5a got rc=$rc"; exit 1; fi
) && PASS=$((PASS+1)) || { fail "case5.budget" "see above"; }

# ===========================================================================
# CASE 6 — already_seen
# ===========================================================================
echo ""
echo "── Case 6: already_seen ──────────────────────────────────────────"
( new_isolated_env "case6" ; load_lib
  rc1=0; already_seen "r" "ERR-A" || rc1=$?  # first call: returns 1 (not seen)
  rc2=0; already_seen "r" "ERR-A" || rc2=$?  # second same: returns 0 (seen)
  rc3=0; already_seen "r" "ERR-B" || rc3=$?  # different content: returns 1
  if [ "$rc1" = "1" ] && [ "$rc2" = "0" ] && [ "$rc3" = "1" ]; then
    echo "  PASS: 6a.dedup-by-content"
  else
    echo "  FAIL: 6 got rc1=$rc1 rc2=$rc2 rc3=$rc3"; exit 1
  fi
) && PASS=$((PASS+1)) || { fail "case6.already_seen" "see above"; }

# ===========================================================================
# CASE 7 — resolve_health_url precedence
# ===========================================================================
echo ""
echo "── Case 7: resolve_health_url precedence ─────────────────────────"
( new_isolated_env "case7"
  # Stage a fake plugin root so we control the example registry without touching the real one.
  STAGE_PLUGIN="$SUITE_TMP/case7/plugin"
  mkdir -p "$STAGE_PLUGIN/scripts/lib" "$STAGE_PLUGIN/config"
  cp "$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh" "$STAGE_PLUGIN/scripts/lib/"
  printf '{"owner/repo7:dev":{"health":"https://plugin.example/health"}}' > "$STAGE_PLUGIN/config/post-merge-services.example.json"
  export CLAUDE_PLUGIN_ROOT="$STAGE_PLUGIN"
  # shellcheck disable=SC1091
  . "$STAGE_PLUGIN/scripts/lib/deploy-fix-common.sh"

  # Build a fake repo dir + project registry
  fake_repo="$SUITE_TMP/case7/projects/repo7"
  mkdir -p "$fake_repo/.claude"
  printf '{"owner/repo7:dev":{"health":"https://project.example/health"}}' > "$fake_repo/.claude/post-merge-services.json"
  user_reg="$SUITE_TMP/case7/user-registry.json"
  printf '{"owner/repo7:dev":{"health":"https://user.example/health"}}' > "$user_reg"
  export CLAUDE_PLUGIN_OPTION_REPO_SEARCH_ROOTS="$SUITE_TMP/case7/projects"
  export CLAUDE_PLUGIN_OPTION_REGISTRY_PATH="$user_reg"

  # Project should win
  v=$(resolve_health_url "owner/repo7" "dev")
  [ "$v" = "https://project.example/health" ] && echo "  PASS: 7a.project-wins" || { echo "  FAIL: 7a got '$v'"; exit 1; }

  # Remove project file → user wins
  rm "$fake_repo/.claude/post-merge-services.json"
  v=$(resolve_health_url "owner/repo7" "dev")
  [ "$v" = "https://user.example/health" ] && echo "  PASS: 7b.user-wins" || { echo "  FAIL: 7b got '$v'"; exit 1; }

  # Remove user → plugin example wins
  rm "$user_reg"
  v=$(resolve_health_url "owner/repo7" "dev")
  [ "$v" = "https://plugin.example/health" ] && echo "  PASS: 7c.plugin-wins" || { echo "  FAIL: 7c got '$v'"; exit 1; }

  # Unknown key → empty
  v=$(resolve_health_url "owner/no-such" "dev")
  [ -z "$v" ] && echo "  PASS: 7d.empty-when-missing" || { echo "  FAIL: 7d got '$v'"; exit 1; }
) && PASS=$((PASS+4)) || { fail "case7.resolve_health_url" "see above"; }

# ===========================================================================
# CASE 8 — dispatch_fix_agent
# ===========================================================================
echo ""
echo "── Case 8: dispatch_fix_agent ────────────────────────────────────"

# Build a dummy template inside plugin prompts
DUMMY_TEMPLATE="$PLUGIN_ROOT/prompts/__dummy-fix-test.md"
cat > "$DUMMY_TEMPLATE" <<'TPL'
REPO={{REPO}} SHA={{SHA}} BRANCH={{BRANCH}} EXTRA={{EXTRA}}
TPL
trap 'rm -rf "$SUITE_TMP" "$DUMMY_TEMPLATE"' EXIT

# 8a — happy: dispatches, prompt placeholders replaced
( new_isolated_env "case8-happy" ; load_lib
  out=$(dispatch_fix_agent "__dummy-fix-test.md" "myslug-deploy" "REPO=owner/repo" "SHA=abc1234" "BRANCH=dev" "EXTRA=hi")
  rc=$?
  [ "$rc" = "0" ] || { echo "  FAIL: 8a.rc=$rc"; exit 1; }
  echo "  PASS: 8a.dispatch-rc-zero"
  # Wait for nohup'd claude to run
  for _ in 1 2 3 4 5 6 7 8 10 12; do
    [ -s "$TEST_LOGS/claude-prompt.txt" ] && break
    sleep 0.3
  done
  prompt=$(cat "$TEST_LOGS/claude-prompt.txt" 2>/dev/null || echo "")
  case "$prompt" in
    *"REPO=owner/repo"*"SHA=abc1234"*"BRANCH=dev"*"EXTRA=hi"*)
      echo "  PASS: 8a.placeholders-replaced" ;;
    *)
      echo "  FAIL: 8a.placeholders-replaced got: $prompt"; exit 1 ;;
  esac
) && PASS=$((PASS+2)) || { fail "case8a" "see above"; }

# 8b — skip on existing lock
( new_isolated_env "case8-lock" ; load_lib
  # Pre-create a live lock owned by current PID
  echo $$ > "$TEST_STATE/lock-myslug-deploy"
  rc=0
  dispatch_fix_agent "__dummy-fix-test.md" "myslug-deploy" "REPO=x" "SHA=y" "BRANCH=z" "EXTRA=w" >/dev/null 2>&1 || rc=$?
  [ "$rc" = "2" ] && echo "  PASS: 8b.skips-on-lock-rc2" || { echo "  FAIL: 8b got rc=$rc"; exit 1; }
) && PASS=$((PASS+1)) || { fail "case8b" "see above"; }

# 8c — skip on budget exhausted
( new_isolated_env "case8-budget" ; load_lib
  export CLAUDE_PLUGIN_OPTION_MAX_FIXES_PER_HOUR=1
  dispatch_fix_agent "__dummy-fix-test.md" "myslug-deploy" "REPO=x" "SHA=y" "BRANCH=z" "EXTRA=w" >/dev/null 2>&1
  # Wait for first to clear the lock (claude mock exits fast, then lock is removed by the bg shell)
  sleep 1
  # Force lock release in case timing leaves it
  rm -f "$TEST_STATE/lock-myslug-deploy"
  rc=0
  dispatch_fix_agent "__dummy-fix-test.md" "myslug-deploy" "REPO=x" "SHA=y" "BRANCH=z" "EXTRA=w" >/dev/null 2>&1 || rc=$?
  [ "$rc" = "3" ] && echo "  PASS: 8c.skips-on-budget-rc3" || { echo "  FAIL: 8c got rc=$rc"; exit 1; }
) && PASS=$((PASS+1)) || { fail "case8c" "see above"; }

# ===========================================================================
# CASE 9 — E2E happy path: monitor exits 0, no fixer
# ===========================================================================
echo ""
echo "── Case 9: monitor happy path ────────────────────────────────────"
test_monitor_happy() {
  new_isolated_env "case9-happy"
  export MOCK_GH_PR_VIEW_JSON='{"baseRefName":"dev","mergeCommit":{"oid":"abcdef1234567890"},"state":"MERGED"}'
  export MOCK_GH_RUN_LIST_JSON='[{"databaseId":42,"headSha":"abcdef1234567890","name":"deploy"}]'
  export MOCK_GH_RUN_WATCH_RC=0
  export MOCK_GH_RUN_VIEW_CONCLUSION="success"
  export MOCK_CURL_HEALTH_CODE=200
  export MOCK_CURL_VERSION_BODY='{"commit":"abcdef1"}'
  # Force version URL resolution
  user_reg="$SUITE_TMP/case9-happy/registry.json"
  printf '{"owner/repo9:dev":{"health":"https://h.example/health","version":"https://h.example/version"}}' > "$user_reg"
  export CLAUDE_PLUGIN_OPTION_REGISTRY_PATH="$user_reg"
  # Speed up: shrink sleeps via inserting a wrapper sleep that always returns instantly
  ln -sf /usr/bin/true "$TEST_BIN/sleep" 2>/dev/null || true

  bash "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh" "owner/repo9" "9" >/dev/null 2>&1
  rc=$?
  assert_eq "9a.monitor-rc-zero" "0" "$rc"
  if [ ! -s "$TEST_LOGS/claude.log" ]; then
    pass "9b.no-fixer-on-happy"
  else
    fail "9b.no-fixer-on-happy" "claude was invoked"
  fi
}
test_monitor_happy

# ===========================================================================
# CASE 10 — E2E transient failure: rerun called, no fixer
# ===========================================================================
echo ""
echo "── Case 10: monitor transient failure → rerun ────────────────────"
test_monitor_transient() {
  new_isolated_env "case10-transient"
  export MOCK_GH_PR_VIEW_JSON='{"baseRefName":"dev","mergeCommit":{"oid":"abcdef1234567890"},"state":"MERGED"}'
  export MOCK_GH_RUN_LIST_JSON='[{"databaseId":42,"headSha":"abcdef1234567890","name":"deploy"}]'
  export MOCK_GH_RUN_WATCH_RC=1
  export MOCK_GH_RUN_VIEW_CONCLUSION="failure"
  export MOCK_GH_RUN_VIEW_LOG_FAILED="The runner has received a shutdown signal — aborting."
  ln -sf /usr/bin/true "$TEST_BIN/sleep" 2>/dev/null || true

  bash "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh" "owner/repo10" "10" >/dev/null 2>&1
  # Inspect gh log: should contain "rerun"
  if grep -q "rerun" "$TEST_LOGS/gh.log"; then
    pass "10a.gh-rerun-called"
  else
    fail "10a.gh-rerun-called" "no rerun in: $(cat "$TEST_LOGS/gh.log")"
  fi
  if [ ! -s "$TEST_LOGS/claude.log" ]; then
    pass "10b.no-fixer-on-transient"
  else
    fail "10b.no-fixer-on-transient" "claude invoked"
  fi
}
test_monitor_transient

# ===========================================================================
# CASE 11 — E2E real failure: dispatches Haiku fixer with correct vars
# ===========================================================================
echo ""
echo "── Case 11: monitor real failure → fixer dispatched ──────────────"
test_monitor_real_failure() {
  new_isolated_env "case11-real"
  export MOCK_GH_PR_VIEW_JSON='{"baseRefName":"dev","mergeCommit":{"oid":"abcdef1234567890"},"state":"MERGED"}'
  export MOCK_GH_RUN_LIST_JSON='[{"databaseId":99,"headSha":"abcdef1234567890","name":"deploy"}]'
  export MOCK_GH_RUN_WATCH_RC=1
  export MOCK_GH_RUN_VIEW_CONCLUSION="failure"
  export MOCK_GH_RUN_VIEW_LOG_FAILED="error TS2322: Type assignment failed"
  # Use real prompts/deploy-fix.md
  ln -sf /usr/bin/true "$TEST_BIN/sleep" 2>/dev/null || true
  # No registry → skip health audit (resolve_health_url returns "")
  export CLAUDE_PLUGIN_OPTION_REGISTRY_PATH="$SUITE_TMP/case11-real/no-such.json"

  bash "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh" "owner/repo11" "11" >/dev/null 2>&1
  # Wait for nohup'd claude
  for _ in 1 2 3 4 5 6 7 8 10 12 14 16; do
    [ -s "$TEST_LOGS/claude-prompt.txt" ] && break
    "$REAL_SLEEP" 0.3
  done
  if [ -s "$TEST_LOGS/claude-prompt.txt" ]; then
    pass "11a.fixer-dispatched"
  else
    fail "11a.fixer-dispatched" "claude prompt log empty"
    return
  fi
  prompt=$(cat "$TEST_LOGS/claude-prompt.txt")
  assert_contains "11b.prompt-has-repo" "owner/repo11" "$prompt"
  assert_contains "11c.prompt-has-pr" "11" "$prompt"
  assert_contains "11d.prompt-has-sha" "abcdef1" "$prompt"
  assert_contains "11e.prompt-has-runid" "99" "$prompt"
  # Verify haiku model flag was passed (wait — log is written after prompt by the mock)
  for _ in 1 2 3 4 5 6 7 8 10; do
    [ -s "$TEST_LOGS/claude.log" ] && break
    "$REAL_SLEEP" 0.3
  done
  argv=$(cat "$TEST_LOGS/claude.log")
  assert_contains "11f.model-haiku" "haiku" "$argv"
  # Verify lock was acquired (file exists or was acquired then released)
  # Since dispatch_fix_agent acquires then the bg shell releases, just confirm the
  # state dir saw the lock at some point by checking budget counter (proxy)
  if ls "$TEST_STATE"/budget-* >/dev/null 2>&1; then
    pass "11g.budget-incremented"
  else
    fail "11g.budget-incremented" "no budget file"
  fi
}
test_monitor_real_failure

# ===========================================================================
# Cleanup the dummy template
# ===========================================================================
rm -f "$DUMMY_TEMPLATE"

# ===========================================================================
# SUMMARY
# ===========================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "deploy-fix-hooks test summary"
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
