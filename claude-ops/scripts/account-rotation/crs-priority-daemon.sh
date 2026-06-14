#!/usr/bin/env bash
# crs-priority-daemon.sh — single-flight wrapper for crs-priority-daemon.mjs.
# Invoked once per tick by the launchd/systemd timer (StartInterval). Holds an
# atomic mkdir lock so ticks never stack (macOS has no flock), skips silently
# when CRS is down, rotates its own log, then runs ONE node tick.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/crs-priority.log"
NODE="${CRS_NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
BASE="${CRS_BASE:-http://127.0.0.1:3000}"

mkdir -p "$LOG_DIR"

# Atomic single-flight lock (auto-released on exit). Stale locks >10m are reclaimed.
LOCK="${TMPDIR:-/tmp}/crs-priority-daemon.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0  # another tick is running
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Skip silently if CRS isn't reachable (don't spam the log while the relay is down).
curl -sf -o /dev/null --max-time 5 "$BASE/health" || exit 0

# Rotate log past ~2MB.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2097152 ]; then
  mv "$LOG" "$LOG.1"
fi

CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA_DIR="$DATA_DIR" \
  "$NODE" "$SELF_DIR/crs-priority-daemon.mjs" "$@" >> "$LOG" 2>&1
