#!/bin/bash
# Kills orphan `gh pr checks ... --watch` after 5 min; `gh run watch` only after
# 2000s so deploy monitors (default watcher timeout 1800s in ops-deploy-monitor.sh)
# are not SIGKILL'd mid-watch. Runs every 60s while active. Idempotent.
#
# Triggered by: SessionStart hook (foreground guarded by pidfile to avoid duplicates).
#
# Source of truth: ~/Projects/claude-ops/claude-ops/scripts/gh-orphan-killer.sh

set -euo pipefail

PIDFILE="${TMPDIR:-/tmp}/gh-orphan-killer.pid"
LOG="${HOME}/.claude/logs/gh-orphan-killer.log"
mkdir -p "$(dirname "$LOG")"

# Singleton: if another instance is running with a fresh pidfile, exit
if [ -f "$PIDFILE" ]; then
  prev_pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$prev_pid" ] && kill -0 "$prev_pid" 2>/dev/null; then
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

PR_CHECKS_WATCH_MAX_AGE=300
# Above ops-deploy-monitor default watcher_timeout_seconds (1800) with headroom
GH_RUN_WATCH_MAX_AGE=2000

while true; do
  # `ps -eo pid,etimes,command` — etimes = elapsed seconds since process start
  killed=0
  while read -r pid etimes max_age command; do
    [ -z "$pid" ] && continue
    [[ "$etimes" =~ ^[0-9]+$ ]] || continue
    [[ "$max_age" =~ ^[0-9]+$ ]] || continue
    if [ "$etimes" -gt "$max_age" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing orphan pid=$pid age=${etimes}s max=${max_age}s: $command" >> "$LOG"
      kill -9 "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done < <(ps -eo pid,etimes,command 2>/dev/null | awk -v prmax="$PR_CHECKS_WATCH_MAX_AGE" -v runmax="$GH_RUN_WATCH_MAX_AGE" '
    /gh pr checks .*--watch/ && !/awk|grep/ { print $1, $2, prmax, substr($0, index($0,$3)) }
    /gh run watch/ && !/awk|grep/ { print $1, $2, runmax, substr($0, index($0,$3)) }
  ')

  [ "$killed" -gt 0 ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killed $killed orphan(s)" >> "$LOG"

  sleep 60
done
