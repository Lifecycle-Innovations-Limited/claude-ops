#!/opt/homebrew/bin/bash
# ops-daemon-launcher.sh — version-agnostic launcher for the claude-ops daemon.
# Resolves the highest installed ops plugin version at run time, then execs its
# ops-daemon.sh. Survives plugin upgrades without plist edits.
set -euo pipefail

CACHE_ROOT="${CLAUDE_PLUGIN_CACHE_ROOT:-$HOME/.claude/plugins/cache/ops-marketplace/ops}"

if [[ ! -d "$CACHE_ROOT" ]]; then
  echo "[ops-daemon-launcher] FATAL: cache root missing: $CACHE_ROOT" >&2
  exit 64
fi

# Highest semver dir that contains scripts/ops-daemon.sh
LATEST_VERSION="$(
  find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | awk -F/ '{print $NF}' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -rn -t. -k1,1 -k2,2 -k3,3 \
    | while read -r v; do
        if [[ -x "$CACHE_ROOT/$v/scripts/ops-daemon.sh" ]]; then
          echo "$v"; break
        fi
      done
)"

if [[ -z "${LATEST_VERSION:-}" ]]; then
  echo "[ops-daemon-launcher] FATAL: no installed ops version has scripts/ops-daemon.sh" >&2
  exit 65
fi

DAEMON="$CACHE_ROOT/$LATEST_VERSION/scripts/ops-daemon.sh"
export CLAUDE_PLUGIN_ROOT="$CACHE_ROOT/$LATEST_VERSION"

echo "[ops-daemon-launcher] resolved ops $LATEST_VERSION → $DAEMON"
# Re-exec under the same bash that is running this script (plist/installer may
# use /opt/homebrew or /usr/local on Intel Mac); avoid hardcoding Homebrew path.
exec "${OPS_DAEMON_LAUNCHER_BASH:-$BASH}" "$DAEMON" "$@"
