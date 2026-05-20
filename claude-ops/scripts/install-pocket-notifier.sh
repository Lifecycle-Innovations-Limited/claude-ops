#!/usr/bin/env bash
# Install the pocket-activity-notifier as a launchd LaunchAgent.
#
# Generates the plist from the bundled template, sed-substitutes user-local
# paths, and bootstraps the agent. Idempotent — re-running re-bootstraps
# cleanly.
#
# Trigger: invoked from /ops:setup when the user opts in to pocket activity
# notifications (requires whatsapp-config.json and/or email-config.json under
# ~/.claude/state/pocket/). Can also be run standalone:
#
#   bash scripts/install-pocket-notifier.sh
#
# Required env (any of the resolution paths below works):
#   CLAUDE_PLUGIN_ROOT       (set by Claude Code when invoking plugin code)

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: pocket-activity-notifier is macOS-only (launchd)" >&2
  echo "Linux users: wire scripts/ops-pocket-activity-notifier.py into systemd/cron with a 60s interval."
  exit 0
fi

# Resolve plugin root — never hardcode a version number.
# Fall back to the directory containing THIS script if CLAUDE_PLUGIN_ROOT is unset
# (lets the script work when invoked directly from a checkout).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
if [[ -z "$PLUGIN_ROOT" || ! -d "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

NOTIFIER_SCRIPT="$PLUGIN_ROOT/scripts/ops-pocket-activity-notifier.py"
LAUNCHER_SCRIPT="$PLUGIN_ROOT/scripts/ops-pocket-activity-notifier-launcher.sh"
LAUNCHER_DEST_DIR="$HOME/.claude/plugins/data/ops-ops-marketplace/bin"
LAUNCHER_DEST="$LAUNCHER_DEST_DIR/ops-pocket-activity-notifier-launcher.sh"
PLIST_TEMPLATE="$PLUGIN_ROOT/scripts/com.claude-ops.pocket-activity-notifier.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.pocket-activity-notifier.plist"
STATE_DIR="$HOME/.claude/state/pocket"

# Fall back to script-dir-relative paths when invoked from a fresh checkout
# where the plugin root resolution above lands somewhere unexpected.
[[ -f "$NOTIFIER_SCRIPT" ]] || NOTIFIER_SCRIPT="$SCRIPT_DIR/ops-pocket-activity-notifier.py"
[[ -f "$LAUNCHER_SCRIPT" ]] || LAUNCHER_SCRIPT="$SCRIPT_DIR/ops-pocket-activity-notifier-launcher.sh"
[[ -f "$PLIST_TEMPLATE"  ]] || PLIST_TEMPLATE="$SCRIPT_DIR/com.claude-ops.pocket-activity-notifier.plist"

for f in "$NOTIFIER_SCRIPT" "$LAUNCHER_SCRIPT" "$PLIST_TEMPLATE"; do
  [[ -f "$f" ]] || { echo "error: required plugin file not found: $f" >&2; exit 1; }
done

mkdir -p "$STATE_DIR" "$LAUNCHER_DEST_DIR"
chmod +x "$NOTIFIER_SCRIPT"

# Install the version-agnostic launcher to a stable location outside the
# version-pinned cache dir. The plist points at THIS path forever — the
# launcher resolves the latest installed ops version at run time.
cp "$LAUNCHER_SCRIPT" "$LAUNCHER_DEST"
chmod +x "$LAUNCHER_DEST"

# macOS ships bash 3; Homebrew installs bash 5 at /opt/homebrew/bin/bash.
BASH_PATH="/bin/bash"
if [[ -x /opt/homebrew/bin/bash ]]; then
  BASH_PATH="/opt/homebrew/bin/bash"
elif [[ -x /usr/local/bin/bash ]]; then
  BASH_PATH="/usr/local/bin/bash"
fi

# Generate plist from template. Point at the stable launcher path so plugin
# upgrades don't strand the plist on a deleted version dir.
TMP_PLIST="$(mktemp -t pocket-activity-notifier.XXXXXX.plist)"
trap 'rm -f "$TMP_PLIST"' EXIT

sed -e "s|__BASH_PATH__|$BASH_PATH|g" \
    -e "s|__POCKET_NOTIFIER_LAUNCHER_PATH__|$LAUNCHER_DEST|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__USER__|$USER|g" \
    "$PLIST_TEMPLATE" > "$TMP_PLIST"

mv "$TMP_PLIST" "$PLIST_DEST"
trap - EXIT

# Bootstrap the agent. bootout is best-effort (no-op if not loaded).
launchctl bootout "gui/$(id -u)/com.claude-ops.pocket-activity-notifier" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/com.claude-ops.pocket-activity-notifier"

# Verify.
if launchctl list | grep -q "com.claude-ops.pocket-activity-notifier"; then
  echo "✓ pocket-activity-notifier installed and bootstrapped"
  echo "  plist:    $PLIST_DEST"
  echo "  launcher: $LAUNCHER_DEST"
  echo "  script:   $NOTIFIER_SCRIPT (resolved at run time via launcher)"
  echo "  interval: 60s"
  echo "  logs:     $STATE_DIR/activity-notifier.{stdout,stderr}.log"
else
  echo "✗ pocket-activity-notifier failed to load — check $STATE_DIR/activity-notifier.stderr.log" >&2
  exit 1
fi
