#!/bin/bash
# Force-rotate Claude account from OUTSIDE Claude Code
# Run this when you've hit the limit and can't reach the CLI
# Usage: $CLAUDE_PLUGIN_ROOT/scripts/account-rotation/force-rotate.sh [target-email]
#
# Also available as: force-rotate (shell alias)
# Magic-link variant: rotate-magic = node rotate.mjs --magic-link --force --to <email>
#
# === ROTATION SYSTEM OVERVIEW ===
# Files in this directory:
#   rotate.mjs        - main rotation logic, holds .rotating lock (PID-tagged)
#   daemon.mjs        - launchd-managed monitor (com.claude-ops.account-rotation)
#   ai-brain.mjs      - Haiku fallback for stuck OAuth pages
#   state.json        - activeAccount, lastRotation, per-account util snapshots
#   config.json       - account list, autoRotate toggle
#   .rotating         - lock file: <ISO ts>\n<pid>; auto-broken if PID dead or >15min
#   .rate-limits.json - written by ~/.claude/statusline-command.sh, read by daemon
#
# Auto-rotation triggers (any one fires):
#   1. Daemon poll      : 5h pct >= 80% OR 7d pct >= 80%
#   2. Statusline fire  : 5h OR 7d >= 90% (opens new Terminal with rotate-magic)
#   3. 429 from API     : rate-limit-detector.cjs writes /tmp/claude-rate-limited.json
#   4. 401 auth error   : PostToolUse hook writes /tmp/claude-auth-error.json
#   5. Manual           : this script, or `node rotate.mjs --to <email>`
#
# Drift detection (daemon, every 2min, NO network call):
#   Compares live "Claude Code-credentials" keychain accessToken against each
#   "Claude-Rotation-<key>" vault token. If state.activeAccount disagrees with
#   the actual live account, state.json is auto-corrected. Skipped during the
#   3-min post-rotation blackout to avoid undoing fresh rotations.
#
# Magic-link safety:
#   - Decodes <base64-email> from claude.ai/magic-link#<hex>:<b64> URLs and
#     skips any link whose target email != requested account. Prevents picking
#     up stale links from prior rotation calls (subject is identical for all).
#   - Rejects emails older than the poll start (5s clock skew tolerance).
#
# OAuth stall handling:
#   - Authorize button: 6 attempts × 5s = 30s, then escalates to ai-brain
#   - General URL stall: 2 stagnant steps -> ai-brain
#   - ai-brain (Haiku) pulls API key from env -> Doppler -> keychain
#   - Max 6 ai-brain decisions per rotation
#
# Recovery from stuck state:
#   pkill -9 -f "rotate\.mjs"
#   rm -f ~/.claude/plugins/data/ops/account-rotation/.rotating
#   launchctl kickstart -k gui/$(id -u)/com.claude-ops.account-rotation
#
# Behavior: --force kills any stuck competing rotate.mjs and bypasses the lock.
# We try the fast --no-browser path first (works when refresh tokens are valid);
# if that fails we fall back to the full browser OAuth flow. Both are guarded
# by a watchdog so the rotation can never hang indefinitely.

set -u
DEFAULT_ROT_DIR="${HOME}/.claude/plugins/data/ops/account-rotation"
DIR="${CLAUDE_ROTATION_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-${HOME}/.claude/plugins/data/ops}/account-rotation}"
[ -d "$DIR" ] || DIR="$DEFAULT_ROT_DIR"
WATCHDOG_SECONDS="${FORCE_ROTATE_TIMEOUT:-360}"

echo "🔄 Force-rotating Claude account..."

# Pre-flight: clear stale lock if its PID is dead. rotate.mjs --force does this
# too, but doing it here keeps the watchdog timer accurate.
if [ -f "$DIR/.rotating" ]; then
  LOCK_PID=$(tail -1 "$DIR/.rotating" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "↻  Clearing stale lock (PID $LOCK_PID dead)"
    rm -f "$DIR/.rotating"
  fi
fi

# Pre-flight: ensure daemon is running. If launchd reports not loaded, kickstart.
if ! launchctl list 2>/dev/null | grep -q com.claude-ops.account-rotation; then
  echo "↻  Daemon not loaded — loading"
  launchctl load "$HOME/Library/LaunchAgents/com.claude-ops.account-rotation.plist" 2>/dev/null
fi

# Pre-flight: detect drift between state.json and live keychain (informational —
# the daemon also auto-corrects every 2min, but this surfaces it during manual
# rotation). Don't block on failure; just log.
{
  LIVE_TOK=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null)
  STATE_ACCT=$(python3 -c "import json; print(json.load(open('$DIR/state.json')).get('activeAccount',''))" 2>/dev/null)
  if [ -n "$LIVE_TOK" ] && [ -n "$STATE_ACCT" ]; then
    LIVE_ACCT=$(curl -s -m 4 -H "Authorization: Bearer $LIVE_TOK" -H "anthropic-beta: oauth-2025-04-20" https://api.anthropic.com/api/oauth/profile 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('account',{}).get('email',''))" 2>/dev/null)
    if [ -n "$LIVE_ACCT" ] && [ "$LIVE_ACCT" != "$STATE_ACCT" ] && [ "${STATE_ACCT}" != "${LIVE_ACCT%@*}-personal" ] && [ "${STATE_ACCT}" != "${LIVE_ACCT%@*}-team" ]; then
      echo "⚠  Drift: state=$STATE_ACCT live=$LIVE_ACCT (daemon will auto-correct, or rotate.mjs will reconcile on swap)"
    fi
  fi
} 2>/dev/null

TARGET_ARG=()
if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
  TARGET_ARG=(--to "$1")
fi

run_with_watchdog() {
  # Runs a command in the background with a hard kill after $WATCHDOG_SECONDS.
  # Returns the command's exit code, or 124 if the watchdog fired.
  local cmd_pid wd_pid rc
  "$@" &
  cmd_pid=$!
  ( sleep "$WATCHDOG_SECONDS"; kill -9 "$cmd_pid" 2>/dev/null ) &
  wd_pid=$!
  wait "$cmd_pid" 2>/dev/null
  rc=$?
  # Stop the watchdog (may already be dead)
  kill "$wd_pid" 2>/dev/null
  wait "$wd_pid" 2>/dev/null
  # If watchdog killed the cmd, wait returns 137; surface as 124 (timeout)
  if [ "$rc" -eq 137 ]; then
    echo "⏱  Watchdog fired after ${WATCHDOG_SECONDS}s — killed stuck rotate.mjs" >&2
    pgrep -f "chrome-beta-automation" | xargs -r kill -9 2>/dev/null
    return 124
  fi
  return "$rc"
}

# Fast path: refresh-token rotation, no browser. Works whenever a candidate
# account has a non-expired refresh token — which is the common case.
echo "→ Trying fast path (--no-browser --force)..."
if run_with_watchdog node "$DIR/rotate.mjs" --force --no-browser --session ${TARGET_ARG[@]+"${TARGET_ARG[@]}"}; then
  FAST_OK=1
else
  FAST_OK=0
  echo "⚠  Fast path failed — falling back to browser OAuth"
  run_with_watchdog node "$DIR/rotate.mjs" --force --session ${TARGET_ARG[@]+"${TARGET_ARG[@]}"}
fi

# Show new status
echo ""
node "$DIR/rotate.mjs" --status 2>&1 | head -40

# macOS notification
osascript -e 'display notification "Account rotated — restart Claude Code session" with title "Claude Rotation"' 2>/dev/null

echo ""
if [ "$FAST_OK" -eq 1 ]; then
  echo "✅ Done (fast path). Start a new Claude Code session to use the fresh account."
else
  echo "✅ Done (browser fallback). Start a new Claude Code session to use the fresh account."
fi
echo "   (Running sessions may still use the old token — exit and re-enter)"
