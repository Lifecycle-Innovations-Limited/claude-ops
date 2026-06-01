#!/usr/bin/env bash
# Cross-platform "ensure WhatsApp bridge is up" wrapper used by claude-ops's
# daemon-services. On macOS it kickstarts the launchd plist; on Linux it
# restarts the systemd-user unit. Idempotent — safe to call repeatedly.

set -euo pipefail

# Already healthy?
if lsof -nP -iTCP:8080 2>/dev/null | grep -q LISTEN; then
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    LABEL="com.${USER}.whatsapp-bridge"
    TARGET="gui/$(id -u)/${LABEL}"
    if ! launchctl kickstart -k "$TARGET" 2>/dev/null; then
      # Fall back to load + retry if the agent isn't loaded yet
      PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
      [ -f "$PLIST" ] && launchctl load -w "$PLIST" 2>/dev/null || true
      sleep 2
      launchctl kickstart -k "$TARGET" 2>/dev/null || true
    fi
    ;;
  Linux)
    if command -v systemctl >/dev/null && systemctl --user cat whatsapp-bridge.service >/dev/null 2>&1; then
      # Shared cross-caller restart floor — the SAME stamp wa-bridge-keepalive.sh and
      # wa-inbox-fresh.sh use ($HOME/.claude/.once.whatsapp-bridge-restart.last). One
      # bridge restart / 180s max across ALL callers. whatsmeow CANNOT re-fetch your own
      # phone-sent messages on reconnect, so each uncoordinated restart is a window where
      # outbound you typed on your phone is dropped permanently. Without this floor,
      # parallel ops health-checks calling this wrapper churn the bridge (observed: 4
      # restarts in 1 second) and silently lose sends. If a restart happened <180s ago the
      # bridge is already coming up — skip and let the wait loop below confirm :8080.
      _wa_floor="$HOME/.claude/.once.whatsapp-bridge-restart.last"
      _wa_skip=0
      if [ -f "$_wa_floor" ]; then
        _wa_last="$(cat "$_wa_floor" 2>/dev/null || echo 0)"
        if [ "$(( $(date +%s) - ${_wa_last:-0} ))" -lt 180 ]; then _wa_skip=1; fi
      fi
      if [ "$_wa_skip" = 0 ]; then
        systemctl --user restart whatsapp-bridge.service
        date +%s > "$_wa_floor" 2>/dev/null || true
      fi
    else
      echo "claude-ops/whatsapp-bridge-up: no whatsapp-bridge.service installed on this Linux host." >&2
      echo "Run: bash \$CLAUDE_PLUGIN_ROOT/scripts/install-whatsapp-bridge-linux.sh --wa-phone <E.164>" >&2
      exit 3
    fi
    ;;
  *)
    echo "claude-ops/whatsapp-bridge-up: unsupported OS: $OS" >&2
    exit 4
    ;;
esac

# Brief grace period for the listener to come up.
for _ in 1 2 3 4 5; do
  lsof -nP -iTCP:8080 2>/dev/null | grep -q LISTEN && exit 0
  sleep 1
done

echo "claude-ops/whatsapp-bridge-up: bridge did not open :8080 within 5s" >&2
exit 1
