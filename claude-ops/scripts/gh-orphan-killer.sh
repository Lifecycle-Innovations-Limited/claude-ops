#!/bin/bash
# Kills orphan `gh ... --watch` and tight-poll-loop processes older than 5 min.
# Runs every 60s while it's active. Idempotent. Safe to run in parallel.
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

while true; do
  # Find `gh ... --watch` and tight-poll loops older than 300s (5 min)
  # `ps -eo pid,etimes,command` gives etimes = elapsed seconds since process start
  killed=0
  while read -r pid etimes command; do
    [ -z "$pid" ] && continue
    if [ "$etimes" -gt 300 ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killing orphan pid=$pid age=${etimes}s: $command" >> "$LOG"
      kill -9 "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done < <(ps -eo pid,etimes,command 2>/dev/null | awk '
    /gh pr checks .*--watch/ && !/awk|grep/ { print $1, $2, substr($0, index($0,$3)) }
    /gh run watch/ && !/awk|grep/ { print $1, $2, substr($0, index($0,$3)) }
  ')

  [ "$killed" -gt 0 ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) killed $killed orphan(s)" >> "$LOG"

  sleep 60
done
