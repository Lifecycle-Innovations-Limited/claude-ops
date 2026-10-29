#!/usr/bin/env bash
# Concurrency tests for bin/ops-task-reminder.
#
# The hook runs async, so Claude Code can start several invocations for one
# session at once. Each does read-increment-write on a per-session counter; a
# missing lock loses updates. These tests fire 25+ invocations in parallel and
# require the counter (and the number of reminders) to be exact, for both lock
# strategies: flock(1) where available, and the portable python3 helper
# (fcntl.flock on the same .flock file) everywhere else.
#
# Every parallel worker is captured by index (stdout, stderr, exit status) and
# its wait status is compared with the recorded exit status, so a worker that
# never ran, never wrote, or died silently is reported as such rather than
# looking like a lost update. Artifacts are kept when any check fails.
# Public plugin: no real host paths or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/bin/ops-task-reminder"
PASS=0
FAIL=0
KEEP=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); KEEP=1; }

echo "== task reminder concurrency =="

if ! command -v jq >/dev/null 2>&1; then
  echo "  SKIP: jq is required"
  echo "test-task-reminder-concurrency.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 is required for the portable lock tests"
  echo "test-task-reminder-concurrency.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

TMP="$(mktemp -d)"
cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "  artifacts preserved for inspection: $TMP" >&2
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
mkdir -p "$TMP/stderr"

N=25
SID="concurrency-test"

# Exact-count runs wait up to 60s for the lock, so a slow or loaded runner
# tests mutual exclusion rather than timing. The fail-open cases use the
# real 2s default.
LOCK_TIMEOUT=60

# run_hook <impl> <threshold> <state_dir> <out_file> [tool] [agent_id]
# stdout -> out_file, stderr -> $HOOK_ERR (default: a file under $TMP/stderr).
run_hook() {
  local agent=""
  [ -n "${6:-}" ] && agent=",\"agent_id\":\"$6\""
  local err="${HOOK_ERR:-$TMP/stderr/$(printf '%s' "$4" | tr '/' '_')}"
  printf '{"session_id":"%s","tool_name":"%s"%s}' "$SID" "${5:-Bash}" "$agent" |
    HOME="$TMP/home" \
      CLAUDE_PLUGIN_ROOT="$ROOT" \
      OPS_DEPLOY_FIX_STATE="$3" \
      OPS_DEPLOY_FIX_LOGS="$TMP/logs" \
      CLAUDE_PLUGIN_OPTION_TASK_REMINDER_THRESHOLD="$2" \
      OPS_TASK_REMINDER_LOCK_IMPL="$1" \
      OPS_TASK_REMINDER_LOCK_TIMEOUT="$LOCK_TIMEOUT" \
      bash "$SCRIPT" >"$4" 2>"$err"
}

# run_batch <label> <impl> <threshold> <state_dir> <out_dir> <count> [alt_impl]
# Starts <count> indexed workers (every even one uses alt_impl when given) and
# checks that each index has stdout, stderr and exit captures, that the exit
# capture equals the wait status, and that every worker exited 0.
run_batch() {
  local label="$1" impl="$2" thr="$3" state="$4" out="$5" n="$6" alt="${7:-}"
  local i st rc pids=() missing=() mismatch=() nonzero=()
  mkdir -p "$state" "$out" "$out.err" "$out.rc"
  for i in $(seq 1 "$n"); do
    local use="$impl"
    if [ -n "$alt" ] && [ $((i % 2)) -eq 0 ]; then use="$alt"; fi
    (
      rc=0
      HOOK_ERR="$out.err/$i" run_hook "$use" "$thr" "$state" "$out/$i" || rc=$?
      printf '%s\n' "$rc" >"$out.rc/$i"
      exit "$rc"
    ) &
    pids+=($!)
  done
  for i in $(seq 1 "$n"); do
    st=0
    wait "${pids[$((i - 1))]}" || st=$?
    if [ ! -f "$out/$i" ] || [ ! -f "$out.err/$i" ] || [ ! -f "$out.rc/$i" ]; then
      missing+=("$i")
      continue
    fi
    rc="$(cat "$out.rc/$i")"
    if [ "$rc" != "$st" ]; then mismatch+=("$i:wait=$st,rc=$rc"); fi
    if [ "$st" != 0 ]; then nonzero+=("$i:$st:$(head -c 200 "$out.err/$i" | tr '\n' ' ')"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "[$label] capture incomplete, missing worker index: ${missing[*]}"
  fi
  if [ "${#mismatch[@]}" -gt 0 ]; then
    fail "[$label] wait status differs from recorded exit: ${mismatch[*]}"
  fi
  if [ "${#nonzero[@]}" -gt 0 ]; then
    fail "[$label] workers exited non-zero: ${nonzero[*]}"
  fi
  if [ "${#missing[@]}" -eq 0 ] && [ "${#mismatch[@]}" -eq 0 ] && [ "${#nonzero[@]}" -eq 0 ]; then
    pass "[$label] $n/$n workers captured (stdout, stderr, exit), wait status matches, all exit 0"
  fi
}

# hold_lock <state_dir> <seconds>: a separate process that holds the real
# kernel lock on the session's .flock file. Sets HOLDER_PID once it is ready.
hold_lock() {
  local ready="$TMP/holder-ready-$RANDOM"
  python3 -I -c '
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(sys.argv[2], "w").write("ready")
time.sleep(float(sys.argv[3]))
' "$1/task-reminder-$SID.flock" "$ready" "$2" &
  HOLDER_PID=$!
  local waited=0
  while [ ! -f "$ready" ] && [ "$waited" -lt 100 ]; do sleep 0.05; waited=$((waited + 1)); done
  [ -f "$ready" ]
}

impls="portable"
if command -v flock >/dev/null 2>&1; then impls="flock portable"; else
  echo "  NOTE: flock(1) not installed; testing the portable python3 lock only"
fi

for impl in $impls; do
  # 1. Counter is exact after N parallel calls below the threshold.
  state="$TMP/state-count-$impl"
  run_batch "$impl 25 calls" "$impl" 1000 "$state" "$TMP/out-count-$impl" "$N"
  got="$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)"
  if [ "$got" = "$N" ]; then
    pass "[$impl] $N parallel calls -> counter $got"
  else
    fail "[$impl] $N parallel calls -> counter $got (want $N; lost updates)"
  fi

  # 2. Reminder fires exactly once per threshold crossing.
  state="$TMP/state-thr-$impl"
  out="$TMP/out-thr-$impl"
  run_batch "$impl 30 calls" "$impl" 10 "$state" "$out" 30
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

# 5. Fail-open: a live holder of the kernel lock makes the hook exit 0, silent,
#    in bounded time, and leaves the counter alone. Age never takes a lock from
#    a live holder.
state="$TMP/state-held"
mkdir -p "$state"
echo 5 >"$state/task-reminder-$SID"
hold_lock "$state" 60 || { fail "lock holder did not start"; }
HOLDER_5="$HOLDER_PID"
LOCK_TIMEOUT=2
start=$(date +%s)
rc=0
run_hook portable 1 "$state" "$TMP/held-out" || rc=$?
elapsed=$(($(date +%s) - start))
got="$(cat "$state/task-reminder-$SID")"
# The lock deadline is ~2s; the slack covers process startup on a loaded runner.
if [ "$rc" = "0" ] && [ ! -s "$TMP/held-out" ] && [ "$got" = "5" ] && [ "$elapsed" -ge 1 ] && [ "$elapsed" -le 6 ]; then
  pass "held lock -> exit 0, no output, counter untouched (${elapsed}s)"
else
  fail "held lock -> rc=$rc elapsed=${elapsed}s counter=$got output=$(wc -c <"$TMP/held-out")B"
fi

# 6. Crash release: killing the holder with SIGKILL frees the lock at once; the
#    next hook counts without waiting out any age threshold.
kill -9 "$HOLDER_5" 2>/dev/null || true
wait "$HOLDER_5" 2>/dev/null || true
LOCK_TIMEOUT=60
start=$(date +%s)
run_hook portable 1000 "$state" "$TMP/rel-out" || true
elapsed=$(($(date +%s) - start))
if [ "$(cat "$state/task-reminder-$SID")" = "6" ] && [ "$elapsed" -le 5 ]; then
  pass "crashed holder released the lock, counter 5 -> 6 (${elapsed}s)"
else
  fail "crashed holder: counter $(cat "$state/task-reminder-$SID") after ${elapsed}s (want 6)"
fi

# 7. A legacy .lockd directory (old mkdir protocol, even a stale one) is not
#    part of the protocol: it neither blocks nor is touched.
mkdir "$state/task-reminder-$SID.lockd"
touch -t 200001010000 "$state/task-reminder-$SID.lockd"
LOCK_TIMEOUT=2
run_hook portable 1000 "$state" "$TMP/stale-out" || true
if [ -d "$state/task-reminder-$SID.lockd" ] && [ "$(cat "$state/task-reminder-$SID")" = "7" ]; then
  pass "legacy .lockd ignored and left in place, counter 6 -> 7"
else
  fail "legacy .lockd handling wrong (counter $(cat "$state/task-reminder-$SID"))"
fi
LOCK_TIMEOUT=60

# 7b. Stale-replacement scenario: with a stale legacy .lockd present, parallel
#     workers must still count exactly (the old protocol let one reaper remove
#     another worker's fresh lock, so two workers read the same counter).
state="$TMP/state-stale-race"
mkdir -p "$state"
mkdir "$state/task-reminder-$SID.lockd"
touch -t 200001010000 "$state/task-reminder-$SID.lockd"
run_batch "portable stale lockd 25 calls" portable 1000 "$state" "$TMP/out-stale-race" "$N"
if [ "$(cat "$state/task-reminder-$SID")" = "$N" ] && [ -d "$state/task-reminder-$SID.lockd" ]; then
  pass "[portable] stale .lockd + $N parallel calls -> counter $N, lockd untouched"
else
  fail "[portable] stale .lockd race -> counter $(cat "$state/task-reminder-$SID") (want $N)"
fi

# 7c. Waiters queued behind a live holder both count once it lets go.
state="$TMP/state-queued"
mkdir -p "$state/../q-out"
echo 0 >"$state/task-reminder-$SID"
hold_lock "$state" 60 || fail "lock holder did not start"
HOLDER_Q="$HOLDER_PID"
run_hook portable 1000 "$state" "$TMP/q-out/a" &
qa=$!
run_hook portable 1000 "$state" "$TMP/q-out/b" &
qb=$!
sleep 0.5
kill "$HOLDER_Q" 2>/dev/null || true
wait "$HOLDER_Q" 2>/dev/null || true
qrc=0
wait "$qa" || qrc=$?
wait "$qb" || qrc=$((qrc + $?))
if [ "$qrc" = "0" ] && [ "$(cat "$state/task-reminder-$SID")" = "2" ]; then
  pass "two waiters behind a live holder both count (counter 2)"
else
  fail "queued waiters: rc=$qrc counter $(cat "$state/task-reminder-$SID") (want 2)"
fi

# 7d. python3 missing and no flock: say so on stderr, exit 0, count nothing.
state="$TMP/state-nopython"
mkdir -p "$state"
echo 3 >"$state/task-reminder-$SID"
rc=0
HOOK_ERR="$TMP/nopython.err" OPS_TASK_REMINDER_PYTHON=/nonexistent/python3 \
  run_hook portable 1000 "$state" "$TMP/nopython-out" || rc=$?
if [ "$rc" = "0" ] && [ ! -s "$TMP/nopython-out" ] && grep -q 'python3' "$TMP/nopython.err" &&
  [ "$(cat "$state/task-reminder-$SID")" = "3" ]; then
  pass "missing python3 -> exit 0, explicit stderr message, counter untouched"
else
  fail "missing python3 -> rc=$rc stderr='$(cat "$TMP/nopython.err")' counter $(cat "$state/task-reminder-$SID")"
fi

# 7g. A broken interpreter (exit 1, like a stale CLT stub or a too-old python)
#     must not make the hook fail: exit 0, say so on stderr, counter untouched.
#     The stub is a plain script; no real stub or installer is ever executed.
state="$TMP/state-brokenpy"
mkdir -p "$state"
echo 4 >"$state/task-reminder-$SID"
printf '#!/bin/sh\nexit 1\n' >"$TMP/broken-python"
chmod +x "$TMP/broken-python"
rc=0
HOOK_ERR="$TMP/brokenpy.err" OPS_TASK_REMINDER_PYTHON="$TMP/broken-python" \
  run_hook portable 1000 "$state" "$TMP/brokenpy-out" || rc=$?
if [ "$rc" = "0" ] && [ ! -s "$TMP/brokenpy-out" ] && grep -q 'lock helper failed' "$TMP/brokenpy.err" &&
  [ "$(cat "$state/task-reminder-$SID")" = "4" ]; then
  pass "broken interpreter -> exit 0, stderr message, counter untouched"
else
  fail "broken interpreter -> rc=$rc stderr='$(cat "$TMP/brokenpy.err")' counter $(cat "$state/task-reminder-$SID")"
fi

# 7e. The pre-3.12.1 name "mkdir" still selects the portable path.
state="$TMP/state-alias"
mkdir -p "$state"
run_hook mkdir 1000 "$state" "$TMP/alias-out" || true
if [ "$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)" = "1" ]; then
  pass "impl=mkdir alias runs the portable helper"
else
  fail "impl=mkdir alias did not count"
fi

# 7f. flock(1) and the python helper share one lock file (Linux only: macOS
#     has no flock binary).
if command -v flock >/dev/null 2>&1; then
  state="$TMP/state-interop"
  run_batch "flock+portable mixed 30 calls" flock 1000 "$state" "$TMP/out-interop" 30 portable
  if [ "$(cat "$state/task-reminder-$SID")" = "30" ]; then
    pass "flock(1) and python helper interoperate on one lock file (counter 30)"
  else
    fail "mixed flock/python workers -> counter $(cat "$state/task-reminder-$SID") (want 30)"
  fi
else
  echo "  NOTE: flock(1) not installed; flock interop not testable on this host"
fi

# 9. Subagents share the parent's session_id but carry agent_id. Their calls
#    must not fill the main thread's counter, never print a reminder, and a
#    subagent Task* call must not reset the main thread's counter.
state="$TMP/state-agent"
out="$TMP/out-agent"
mkdir -p "$state" "$out"
for i in $(seq 1 31); do
  run_hook portable 30 "$state" "$out/a$i" Bash agent-test-1 || true
done
run_hook portable 30 "$state" "$out/main" Bash || true
reminders="$(cat "$out"/* | grep -c 'ops-task-reminder\]' || true)"
main="$(cat "$state/task-reminder-$SID" 2>/dev/null || echo missing)"
if [ "$reminders" = "0" ] && [ "$main" = "1" ]; then
  pass "31 subagent calls + 1 main call, threshold 30 -> no reminder, main counter 1"
else
  fail "subagent calls leaked: $reminders reminders, main counter $main (want 0, 1)"
fi
echo 7 >"$state/task-reminder-$SID"
run_hook portable 30 "$state" "$out/reset" TaskUpdate agent-test-1 || true
main="$(cat "$state/task-reminder-$SID")"
if [ "$main" = "7" ]; then
  pass "subagent TaskUpdate leaves the main counter alone (7)"
else
  fail "subagent TaskUpdate changed the main counter to $main (want 7)"
fi
# The main thread still gets its reminder at the threshold.
echo 29 >"$state/task-reminder-$SID"
run_hook portable 30 "$state" "$out/main-thr" Bash || true
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

echo "test-task-reminder-concurrency.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
