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
      systemctl --user restart whatsapp-bridge.service
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
