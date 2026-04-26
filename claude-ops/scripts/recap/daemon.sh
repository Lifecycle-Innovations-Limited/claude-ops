#!/bin/sh
# Background daemon: regenerates the AI recap digest whenever any input file changes.
# Decoupled from Claude hooks → zero impact on Claude turn latency.
#
# Inputs watched:
#   /tmp/claude-recap-<sid>          (per-session, written by hooks/recap-capture.sh)
#   /tmp/zsh-activity-<pid>.log      (shell activity from zshrc preexec, optional)
#
# Output: /tmp/claude-recap-digest (read by tmux marquee + scripts/recap/marquee.sh)
#
# Single-instance via atomic mkdir lock. Reclaims stale lock if PID is dead.
# Log rotation: 500KB cap, keeps tail 200 lines. Universal-user safe.

LOCK_DIR=/tmp/claude-recap-daemon.lock
PID_FILE=/tmp/claude-recap-daemon.pid
LOG=/tmp/claude-recap-daemon.log
INTERVAL=5         # poll every 5s
MIN_GAP=15         # min seconds between Haiku calls
DIGEST=/tmp/claude-recap-digest

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DIGEST_SCRIPT="${SCRIPT_DIR}/digest.sh"

# Single-instance guard via atomic mkdir (race-free across parallel sessions).
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$PID_FILE"
    return 0
  fi
  i=0
  while [ ! -s "$PID_FILE" ] && [ "$i" -lt 5 ]; do sleep 0.1; i=$((i+1)); done
  old=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    return 1
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$PID_FILE"
    return 0
  fi
  return 1
}

acquire_lock || exit 0
trap 'rm -rf "$LOCK_DIR"; rm -f "$PID_FILE"; exit 0' EXIT INT TERM

printf '[%s] daemon started pid=%s digest=%s\n' "$(date '+%H:%M:%S')" "$$" "$DIGEST_SCRIPT" >> "$LOG"

last_run=0
while true; do
  newest=0
  for f in /tmp/claude-recap-* /tmp/zsh-activity-*.log; do
    case "$f" in
      *digest*|*latest*|*daemon*|*pinned*) continue ;;
    esac
    [ -f "$f" ] || continue
    m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$newest" ] && newest=$m
  done

  digest_m=$(stat -f %m "$DIGEST" 2>/dev/null || stat -c %Y "$DIGEST" 2>/dev/null || echo 0)
  now=$(date +%s)

  if [ "$newest" -gt "$digest_m" ] && [ $((now - last_run)) -ge "$MIN_GAP" ]; then
    last_run=$now
    THROTTLE_OVERRIDE=1 sh "$DIGEST_SCRIPT" >> "$LOG" 2>&1
  fi

  log_bytes=$(stat -f %z "$LOG" 2>/dev/null || stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$log_bytes" -gt 512000 ]; then
    tail -n 200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi

  sleep "$INTERVAL"
done
