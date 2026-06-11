#!/usr/bin/env bash
# install-gh-orphan-killer.sh — install the GitHub-API orphan-killer sweeper.
#
# Cross-platform, runs UNPRIVILEGED (no sudo):
#   • Linux  → systemd --user timer (oneshot every 3 min) in ~/.config/systemd/user/
#   • macOS  → launchd LaunchAgent (StartInterval 180s) in ~/Library/LaunchAgents/
#
# The unit invokes `gh-orphan-killer.sh --once` (single sweep then exit). This is the
# periodic reaper for stale/orphaned `gh`/`curl api.github.com` poll loops that the
# PreToolUse guard (hooks/gh-watch-guard.sh) couldn't block in time. Idempotent —
# safe to re-run after a plugin upgrade.
#
# Usage:
#   bash scripts/install-gh-orphan-killer.sh
#   KILLER_PATH=/abs/path/to/gh-orphan-killer.sh bash scripts/install-gh-orphan-killer.sh
#
# By default the killer path is resolved to THIS script's sibling
# (scripts/gh-orphan-killer.sh) via its real, committed location — so the unit points
# at the repo checkout, not a transient symlink that can drop on reinstall.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILLER_PATH="${KILLER_PATH:-$SCRIPT_DIR/gh-orphan-killer.sh}"

if [[ ! -f "$KILLER_PATH" ]]; then
  echo "ERROR: killer script not found at $KILLER_PATH" >&2
  echo "       Pass KILLER_PATH=<abs path to gh-orphan-killer.sh> explicitly." >&2
  exit 1
fi
chmod +x "$KILLER_PATH" 2>/dev/null || true

OS="$(uname -s)"

case "$OS" in
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"

    # Substitute the killer path into the committed service template.
    sed "s|__KILLER_PATH__|$KILLER_PATH|g" \
      "$SCRIPT_DIR/systemd/gh-orphan-killer.service" > "$UNIT_DIR/gh-orphan-killer.service"
    cp "$SCRIPT_DIR/systemd/gh-orphan-killer.timer" "$UNIT_DIR/gh-orphan-killer.timer"

    echo "Installed:"
    echo "  $UNIT_DIR/gh-orphan-killer.service  (ExecStart=/bin/bash $KILLER_PATH --once)"
    echo "  $UNIT_DIR/gh-orphan-killer.timer    (every 3 min, Persistent=true)"

    systemctl --user daemon-reload
    systemctl --user enable --now gh-orphan-killer.timer

    echo ""
    echo "Armed. Verify with:"
    echo "  systemctl --user list-timers | grep gh-orphan"
    echo "  systemctl --user status gh-orphan-killer.service"
    ;;

  Darwin)
    AGENT_DIR="$HOME/Library/LaunchAgents"
    LABEL="com.claude-ops.gh-orphan-killer"
    PLIST="$AGENT_DIR/$LABEL.plist"
    mkdir -p "$AGENT_DIR"
    mkdir -p "$HOME/.claude/logs"

    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$KILLER_PATH</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/.claude/logs/gh-orphan-killer.launchd.err</string>
</dict>
</plist>
PLIST_EOF

    echo "Installed: $PLIST  (StartInterval 180s → /bin/bash $KILLER_PATH --once)"
    # Reload idempotently.
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo ""
    echo "Armed. Verify with:"
    echo "  launchctl list | grep gh-orphan-killer"
    ;;

  *)
    echo "ERROR: unsupported OS '$OS' — only Linux (systemd) and macOS (launchd) are supported." >&2
    exit 1
    ;;
esac
