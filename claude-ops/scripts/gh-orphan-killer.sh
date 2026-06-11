#!/bin/bash
# gh-orphan-killer — reaps GitHub-API rate-limit-burning orphan processes.
#
# Two classes of target:
#   (1) `gh pr checks ... --watch` orphans after 5 min, `gh run watch` after 2000s
#       (so deploy monitors with the default 1800s watcher timeout aren't SIGKILL'd
#       mid-watch).
#   (2) STALE / ORPHANED GitHub-API POLLING LOOPS — the curl/gh `for`/`while`/`until`
#       loops that the PreToolUse guard couldn't catch because they (a) hit
#       api.github.com/graphql directly via curl, or (b) used sleep >= 25s. Two such
#       merge-watcher loops pinned the shared REST quota to 0 for hours on 2026-06-11.
#       A real merge-watcher finishes fast; an orphaned (ppid==1) or long-running
#       (>10 min) one is a leak — reap it.
#
# Run modes:
#   gh-orphan-killer.sh            # legacy persistent daemon (while-true, sleep 60).
#                                  # Used by the macOS launchd job + SessionStart nohup.
#   gh-orphan-killer.sh --once     # single sweep then exit. Used by the Linux
#                                  # systemd --user timer (oneshot every 3 min).
#
# Cross-platform: portable `ps` columns. On Linux we get `etimes` (elapsed seconds)
# directly; on macOS (BSD ps) etimes is unavailable, so we parse `etime` (D-HH:MM:SS)
# and convert to seconds.
#
# Source of truth: ~/Projects/claude-ops/claude-ops/claude-ops/scripts/gh-orphan-killer.sh

set -uo pipefail

MODE="loop"
if [ "${1:-}" = "--once" ]; then
  MODE="once"
fi

PIDFILE="${TMPDIR:-/tmp}/gh-orphan-killer.pid"
LOG="${HOME}/.claude/logs/gh-orphan-killer.log"
mkdir -p "$(dirname "$LOG")"

# Singleton ONLY for the persistent loop mode. The --once sweep is short-lived and
# self-terminating, so it must not be blocked by (or clobber) the daemon's pidfile —
# the systemd timer and the legacy daemon can safely coexist.
if [ "$MODE" = "loop" ]; then
  if [ -f "$PIDFILE" ]; then
    prev_pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$prev_pid" ] && kill -0 "$prev_pid" 2>/dev/null; then
      exit 0
    fi
  fi
  echo $$ > "$PIDFILE"
  trap 'rm -f "$PIDFILE"' EXIT
fi

PR_CHECKS_WATCH_MAX_AGE=300
# Above ops-deploy-monitor default watcher_timeout_seconds (1800) with headroom
GH_RUN_WATCH_MAX_AGE=2000
# A genuine merge-watcher finishes in well under 10 min; beyond that it's a leak.
POLL_LOOP_MAX_AGE=600

# Convert BSD `etime` ([[DD-]HH:]MM:SS) to seconds. Linux ps gives etimes directly so
# this is only the macOS fallback path.
etime_to_secs() {
  local e="$1" days=0 hms
  case "$e" in
    *-*) days="${e%%-*}"; hms="${e#*-}" ;;
    *)   hms="$e" ;;
  esac
  local IFS=:; set -- $hms
  local h=0 m=0 s=0
  if [ "$#" -eq 3 ]; then h="$1"; m="$2"; s="$3"
  elif [ "$#" -eq 2 ]; then m="$1"; s="$2"
  elif [ "$#" -eq 1 ]; then s="$1"; fi
  # strip leading zeros to avoid octal interpretation
  echo $(( 10#${days:-0}*86400 + 10#${h:-0}*3600 + 10#${m:-0}*60 + 10#${s:-0} ))
}

# Emit "pid ppid etimes args" rows portably. Prefer Linux `etimes` (integer seconds);
# fall back to BSD `etime` and convert.
ps_rows() {
  if ps -eo pid,ppid,etimes,args >/dev/null 2>&1; then
    ps -eo pid=,ppid=,etimes=,args= 2>/dev/null
  else
    # macOS / BSD: no etimes column — emit etime and convert downstream.
    ps -eo pid=,ppid=,etime=,args= 2>/dev/null | while read -r pid ppid etime rest; do
      [ -z "$pid" ] && continue
      secs=$(etime_to_secs "$etime")
      printf '%s %s %s %s\n' "$pid" "$ppid" "$secs" "$rest"
    done
  fi
}

is_self() {
  # Never target our own pid or that of the ps/awk/grep pipeline we spawn.
  [ "$1" = "$$" ] || [ "$1" = "$PPID" ]
}

sweep() {
  local killed=0

  # ── Class 1: gh --watch orphans (unchanged behavior) ──────────────────────────
  while read -r pid etimes max_age command; do
    [ -z "$pid" ] && continue
    [[ "$etimes" =~ ^[0-9]+$ ]] || continue
    [[ "$max_age" =~ ^[0-9]+$ ]] || continue
    is_self "$pid" && continue
    if [ "$etimes" -gt "$max_age" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing orphan pid=$pid age=${etimes}s max=${max_age}s: ${command:0:200}" >> "$LOG"
      kill -9 "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done < <(ps_rows | awk -v prmax="$PR_CHECKS_WATCH_MAX_AGE" -v runmax="$GH_RUN_WATCH_MAX_AGE" '
    # cols: pid ppid etimes args...
    {
      pid=$1; etimes=$3;
      # reconstruct cmdline from $4..$NF
      cmd=""; for(i=4;i<=NF;i++){ cmd=cmd (i>4?" ":"") $i }
    }
    cmd ~ /awk|grep|gh-orphan-killer/ { next }
    cmd ~ /gh pr checks .*--watch/ { print pid, etimes, prmax, cmd; next }
    cmd ~ /gh run watch/           { print pid, etimes, runmax, cmd; next }
  ')

  # ── Class 2: stale/orphaned GitHub-API polling loops ──────────────────────────
  # Kill when ALL hold:
  #   • cmdline hits api.github.com OR (gh + one of pr/run/api), AND
  #   • cmdline has a loop construct (for/while/until/seq) with a sleep, AND
  #   • it is orphaned (ppid==1) OR long-running (> POLL_LOOP_MAX_AGE).
  # Hard EXCLUDE (never kill): self/guard/grep/ps; any 'rate_limit' poller
  # (quota-exempt, legitimate release waiters); claude/node/MCP processes (only
  # /bin/bash|/bin/sh shells running the loop); anything under a 'do-release' path.
  while read -r pid ppid etimes command; do
    [ -z "$pid" ] && continue
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$etimes" =~ ^[0-9]+$ ]] || continue
    is_self "$pid" && continue
    if [ "$ppid" = "1" ] || [ "$etimes" -gt "$POLL_LOOP_MAX_AGE" ]; then
      reason="orphan(ppid=1)"
      [ "$ppid" != "1" ] && reason="stale(age=${etimes}s>${POLL_LOOP_MAX_AGE}s)"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing gh-api poll-loop pid=$pid ppid=$ppid $reason: ${command:0:200}" >> "$LOG"
      kill -9 "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done < <(ps_rows | awk '
    {
      pid=$1; ppid=$2; etimes=$3;
      cmd=""; for(i=4;i<=NF;i++){ cmd=cmd (i>4?" ":"") $i }
    }
    # ── hard excludes ──
    cmd ~ /gh-orphan-killer|gh-watch-guard/        { next }   # the killer/guard itself
    cmd ~ /[ \/]awk |[ \/]grep |[ \/]ps / || cmd ~ /awk$|grep$|ps$/ { next }  # the pipeline
    cmd ~ /rate_limit/                              { next }   # quota-exempt pollers
    cmd ~ /do-release/                              { next }   # release waiters
    cmd ~ /(^|\/)(claude|node|python[0-9.]*|mcp)([ \/]|$)/ { next }  # not shells
    # only target real shells running the loop
    cmd !~ /(^|\/)(bash|sh|dash|zsh)([ \/]|$)/      { next }
    # ── github signal ──
    github = (cmd ~ /api\.github\.com/) || (cmd ~ /(^|[^[:alnum:]_])gh([ ].*[ ](pr|run|api)[ ])/)
    github != 1 { next }
    # ── loop + sleep signal ──
    hasloop  = (cmd ~ /(^|[^[:alnum:]_])(for|while|until|seq)([^[:alnum:]_]|$)/)
    hassleep = (cmd ~ /(^|[^[:alnum:]_])sleep[ ]+[0-9]/)
    (hasloop && hassleep) { print pid, ppid, etimes, cmd }
  ')

  [ "$killed" -gt 0 ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killed $killed target(s) [$MODE]" >> "$LOG"
}

if [ "$MODE" = "once" ]; then
  sweep
  exit 0
fi

while true; do
  sweep
  sleep 60
done
