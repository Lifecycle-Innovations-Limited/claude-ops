#!/usr/bin/env bash
# Concurrency tests for bin/ops-task-reminder.
#
# The hook runs async, so Claude Code can start several invocations for one
# session at once. Each does read-increment-write on a per-session counter; a
# missing lock loses updates. These tests fire 25+ invocations in parallel and
# require the counter (and the number of reminders) to be exact, for both lock
# strategies: flock(1) where available, and the portable mkdir lock.
# Public plugin: no real host paths or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/bin/ops-task-reminder"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "== task reminder concurrency =="

if ! command -v jq >/dev/null 2>&1; then
  echo "  SKIP: jq is required"
  echo "test-task-reminder-concurrency.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

N=25
SID="concurrency-test"

# Exact-count runs wait up to 60s for the lock, so a slow or loaded runner
# tests mutual exclusion rather than timing. The fail-open case (5) uses the
# real 2s default.
LOCK_TIMEOUT=60

# run_hook <impl> <threshold> <state_dir> <out_file> [tool] [agent_id]
run_hook() {
  local agent="" rc=0 diagnostic
  diagnostic="$TMP/diagnostics/$(basename "$(dirname "$4")")-$(basename "$4")-${5:-Bash}-${BASHPID}"
  mkdir -p "$TMP/diagnostics"
  [ -n "${6:-}" ] && agent=",\"agent_id\":\"$6\""
  printf '{"session_id":"%s","tool_name":"%s"%s}' "$SID" "${5:-Bash}" "$agent" |
    HOME="$TMP/home" \
      CLAUDE_PLUGIN_ROOT="$ROOT" \
      OPS_DEPLOY_FIX_STATE="$3" \
      OPS_DEPLOY_FIX_LOGS="$TMP/logs" \
      CLAUDE_PLUGIN_OPTION_TASK_REMINDER_THRESHOLD="$2" \
      OPS_TASK_REMINDER_LOCK_IMPL="$1" \
      OPS_TASK_REMINDER_LOCK_TIMEOUT="$LOCK_TIMEOUT" \
      bash "$SCRIPT" >"$4" 2>"$diagnostic.stderr" || rc=$?
  printf '%s\n' "$rc" >"$diagnostic.exit"
  return "$rc"
}

impls="mkdir"
if command -v flock >/dev/null 2>&1; then impls="flock mkdir"; else
  echo "  NOTE: flock(1) not installed; testing the mkdir lock only"
fi

for impl in $impls; do
  # 1. Counter is exact after N parallel calls below the threshold.
  state="$TMP/state-count-$impl"
  mkdir -p "$state" "$TMP/out-count-$impl"
  pids=()
  for i in $(seq 1 "$N"); do
    run_hook "$impl" 1000 "$state" "$TMP/out-count-$impl/$i" &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
  got="$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)"
  if [ "$got" = "$N" ]; then
    pass "[$impl] $N parallel calls -> counter $got"
  else
    fail "[$impl] $N parallel calls -> counter $got (want $N; lost updates)"
  fi

  # 2. Reminder fires exactly once per threshold crossing.
  state="$TMP/state-thr-$impl"
  out="$TMP/out-thr-$impl"
  mkdir -p "$state" "$out"
  pids=()
  for i in $(seq 1 30); do
    run_hook "$impl" 10 "$state" "$out/$i" &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
  reminders="$(cat "$out"/* | grep -c '"hookEventName": "PostToolUse"' || true)"
  final="$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)"
  if [ "$reminders" = "3" ] && [ "$final" = "0" ]; then
    pass "[$impl] 30 parallel calls, threshold 10 -> 3 reminders, counter 0"
  else
    fail "[$impl] 30 parallel calls, threshold 10 -> $reminders reminders, counter $final (want 3, 0)"
  fi

  # 3. Reminder output is still valid JSON with the same shape.
  first="$(grep -l hookEventName "$out"/* | head -1 || true)"
  if [ -n "$first" ] && jq -e '.hookSpecificOutput.hookEventName == "PostToolUse" and .suppressOutput == true' "$first" >/dev/null 2>&1; then
    pass "[$impl] reminder output is valid PostToolUse JSON"
  else
    fail "[$impl] reminder output missing or not valid JSON"
  fi

  # 4. Task* resets a non-zero counter to 0, silently; so does a namespaced
  #    Task tool name (only the segment after the last "__" counts).
  for t in TaskUpdate mcp__tasks__TaskCreate; do
    echo 7 >"$TMP/state-count-$impl/task-reminder-$SID"
    run_hook "$impl" 1000 "$TMP/state-count-$impl" "$TMP/reset-$impl" "$t" || true
    got="$(cat "$TMP/state-count-$impl/task-reminder-$SID" 2>/dev/null || echo missing)"
    if [ "$got" = "0" ] && [ ! -s "$TMP/reset-$impl" ]; then
      pass "[$impl] $t resets the counter 7 -> 0 silently"
    else
      fail "[$impl] $t reset -> counter $got"
    fi
  done
  # A non-Task tool whose namespace merely contains "Task" still counts.
  echo 7 >"$TMP/state-count-$impl/task-reminder-$SID"
  run_hook "$impl" 1000 "$TMP/state-count-$impl" "$TMP/reset-$impl" mcp__Tasks__Bash || true
  got="$(cat "$TMP/state-count-$impl/task-reminder-$SID" 2>/dev/null || echo missing)"
  if [ "$got" = "8" ]; then
    pass "[$impl] mcp__Tasks__Bash counts (7 -> 8), no reset"
  else
    fail "[$impl] mcp__Tasks__Bash -> counter $got (want 8)"
  fi
done

# 5. Fail-open: a lock held by a live process makes the hook exit 0, silent,
#    in bounded time. The holder keeps the real .flock file, the same one both
#    lock strategies use.
state="$TMP/state-held"
mkdir -p "$state"
echo 5 >"$state/task-reminder-$SID"
python3 - "$state/task-reminder-$SID.flock" <<'PY' &
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
time.sleep(30)
PY
holder=$!
# Give the holder a moment to take the lock before the hook contends for it.
sleep 0.3
LOCK_TIMEOUT=2
start=$(date +%s)
rc=0
run_hook mkdir 1 "$state" "$TMP/held-out" || rc=$?
elapsed=$(($(date +%s) - start))
got="$(cat "$state/task-reminder-$SID")"
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
# The lock deadline is ~2s; the slack covers process startup on a loaded runner.
if [ "$rc" = "0" ] && [ ! -s "$TMP/held-out" ] && [ "$got" = "5" ] && [ "$elapsed" -le 6 ]; then
  pass "held lock -> exit 0, no output, counter untouched (${elapsed}s)"
else
  fail "held lock -> rc=$rc elapsed=${elapsed}s counter=$got output=$(wc -c <"$TMP/held-out")B"
fi

# 6. A finished run leaves no lock directory behind, and the next run counts.
LOCK_TIMEOUT=60
run_hook mkdir 1000 "$state" "$TMP/rel-out" || true
if [ ! -d "$state/task-reminder-$SID.lockd" ] && [ "$(cat "$state/task-reminder-$SID")" = "6" ]; then
  pass "no lock directory left behind, counter 5 -> 6"
else
  fail "lock directory left behind or counter wrong"
fi

# 7. A lock whose holder has died is taken at once, not waited out. The kernel
#    releases an fcntl lock when its holder exits, so a killed hook never blocks
#    the next one. The old .lockd lock had to be reclaimed by age instead.
LOCK_TIMEOUT=2
start=$(date +%s)
run_hook mkdir 1000 "$state" "$TMP/stale-out" || true
elapsed=$(($(date +%s) - start))
if [ "$elapsed" -le 2 ] && [ "$(cat "$state/task-reminder-$SID")" = "7" ]; then
  pass "dead holder's lock taken at once, counter 6 -> 7 (${elapsed}s)"
else
  fail "dead holder blocked the next run (${elapsed}s, counter $(cat "$state/task-reminder-$SID"))"
fi

# 9. Subagents share the parent's session_id but carry agent_id. Their calls
#    must not fill the main thread's counter, never print a reminder, and a
#    subagent Task* call must not reset the main thread's counter.
state="$TMP/state-agent"
out="$TMP/out-agent"
mkdir -p "$state" "$out"
for i in $(seq 1 31); do
  run_hook mkdir 30 "$state" "$out/a$i" Bash agent-test-1 || true
done
run_hook mkdir 30 "$state" "$out/main" Bash || true
reminders="$(cat "$out"/* | grep -c 'ops-task-reminder\]' || true)"
main="$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)"
if [ "$reminders" = "0" ] && [ "$main" = "1" ]; then
  pass "31 subagent calls + 1 main call, threshold 30 -> no reminder, main counter 1"
else
  fail "subagent calls leaked: $reminders reminders, main counter $main (want 0, 1)"
fi
echo 7 >"$state/task-reminder-$SID"
run_hook mkdir 30 "$state" "$out/reset" TaskUpdate agent-test-1 || true
main="$(cat "$state/task-reminder-$SID")"
if [ "$main" = "7" ]; then
  pass "subagent TaskUpdate leaves the main counter alone (7)"
else
  fail "subagent TaskUpdate changed the main counter to $main (want 7)"
fi
# The main thread still gets its reminder at the threshold.
echo 29 >"$state/task-reminder-$SID"
run_hook mkdir 30 "$state" "$out/main-thr" Bash || true
if grep -q 'ops-task-reminder\]' "$out/main-thr"; then
  pass "main thread still reminded at threshold 30"
else
  fail "main thread not reminded at threshold 30"
fi

# 8. Wiring: hooks.json must route Task* PostToolUse events to this hook,
#    otherwise the reset above is unreachable in production. Matcher
#    semantics follow Claude Code: "*"/"" match all; a value of only
#    letters, digits, "_" and "|" is an exact name list; anything else is a
#    regex.
HOOKS="$ROOT/hooks/hooks.json"
entry="$(jq -c '[.hooks.PostToolUse[] | select(any(.hooks[]; .command | test("ops-task-reminder")))][0]' "$HOOKS")"
matcher="$(printf '%s' "$entry" | jq -r '.matcher // ""')"
matches() {
  local m="$1" name="$2"
  case "$m" in "" | "*") return 0 ;; esac
  if printf '%s' "$m" | grep -Eq '^[A-Za-z0-9_|]+$'; then
    printf '%s' "$m" | tr '|' '\n' | grep -Fxq "$name"
  else
    printf '%s' "$name" | grep -Eq "$m"
  fi
}
for t in TaskCreate TaskUpdate TaskList TaskGet Bash Edit Write; do
  if matches "$matcher" "$t"; then
    pass "wiring: PostToolUse $t reaches ops-task-reminder"
  else
    fail "wiring: PostToolUse $t does not match matcher '$matcher'"
  fi
done
if printf '%s' "$entry" | jq -e '.hooks[0].async == true and .hooks[0].timeout > 2' >/dev/null; then
  pass "wiring: hook is async with timeout above the 2s lock deadline"
else
  fail "wiring: hook must be async with timeout > 2 (got $(printf '%s' "$entry" | jq -c '.hooks[0] | {async, timeout}'))"
fi

# 10. Regression: the old portable lock reclaimed a .lockd directory by age.
#     That reclaim removes a lock another live worker still holds, so two
#     workers write the counter at once and one update is lost. The threshold
#     here is 0 minutes so the reclaim always fires; on CI the same reclaim
#     fired at +1 minute once load made a fresh lock look old. The new lock
#     has nothing to reclaim, so the same burst keeps every update.
old_lock_counter() {
  local state="$1" n="$2" sf="$1/counter" d
  rm -rf "$state"; mkdir -p "$state"
  one() {
    local dd="$sf.lockd" tries=0 deadline=$((SECONDS + 30))
    while ! mkdir "$dd" 2>/dev/null; do
      if [ -n "$(find "$dd" -maxdepth 0 -mmin 0 2>/dev/null)" ]; then
        rmdir "$dd" 2>/dev/null || true
      fi
      [ "$SECONDS" -ge "$deadline" ] && return 0
      tries=$((tries + 1)); sleep 0.05
    done
    echo $(( $(cat "$sf" 2>/dev/null || echo 0) + 1 )) > "$sf"
    rmdir "$dd" 2>/dev/null || true
  }
  local i
  for i in $(seq 1 "$n"); do one & done
  wait
  cat "$sf" 2>/dev/null || echo 0
}
old_got="$(old_lock_counter "$TMP/old-lock" 40)"
if [ "$old_got" -lt 40 ]; then
  pass "old .lockd lock loses updates under its own reclaim ($old_got/40)"
else
  fail "old .lockd lock kept every update ($old_got/40); the race did not fire"
fi
new_state="$TMP/new-lock"
mkdir -p "$new_state"
pids=()
for i in $(seq 1 25); do
  run_hook mkdir 1000 "$new_state" "$TMP/new-out-$i" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
new_got="$(cat "$new_state/task-reminder-$SID" 2>/dev/null || echo 0)"
if [ "$new_got" = "25" ]; then
  pass "new lock keeps every update over the same burst (25/25)"
else
  fail "new lock lost updates ($new_got/25)"
fi

for result in "$TMP/diagnostics/"*.exit; do
  [ -f "$result" ] || continue
  rc="$(cat "$result")"
  if [ "$rc" != 0 ]; then
    fail "worker $(basename "${result%.exit}") exited $rc"
  fi
  if [ "$rc" != 0 ] || [ -s "${result%.exit}.stderr" ]; then
    printf '  worker diagnostics: %s (exit %s)\n' "$(basename "${result%.exit}")" "$rc"
    cat "${result%.exit}.stderr"
  fi
done

echo "test-task-reminder-concurrency.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
