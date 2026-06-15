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
# CRS's container port (:3000) is published on the host at either :3000 or :3005
# depending on the deploy (this fleet maps ...:3005->3000). Honor an explicit
# CRS_BASE; otherwise probe the known candidates and pick the first that answers
# /health, so a host port-mapping change can't silently freeze the daemon (it
# used to default to :3000, get 000 against a :3005-mapped relay, and exit 0
# every tick — priority scheduling dead until someone noticed).
BASE="${CRS_BASE:-}"

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
# Auto-detect the host port unless CRS_BASE was set explicitly.
if [ -n "$BASE" ]; then
  curl -sf -o /dev/null --max-time 5 "$BASE/health" || exit 0
else
  for cand in http://127.0.0.1:3005 http://127.0.0.1:3000; do
    if curl -sf -o /dev/null --max-time 5 "$cand/health"; then BASE="$cand"; break; fi
  done
  [ -n "$BASE" ] || exit 0  # relay unreachable on every candidate
fi
export CRS_BASE="$BASE"  # hand the resolved base to the node tick

# Rotate log past ~2MB.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2097152 ]; then
  mv "$LOG" "$LOG.1"
fi

# A transient node failure (e.g. CRS login timeout under a 529 storm) is logged
# but must NOT surface as a launchd job failure — the next tick recovers. Always
# exit 0 so launchctl status stays clean; real errors are in the log.
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA_DIR="$DATA_DIR" \
  "$NODE" "$SELF_DIR/crs-priority-daemon.mjs" "$@" >> "$LOG" 2>&1 || \
  echo "$(date -u +%H:%M:%S) [crs-priority] tick failed (transient — see above); recovering next tick" >> "$LOG"
exit 0
