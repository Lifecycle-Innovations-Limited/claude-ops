#!/usr/bin/env bash
# ops-daemon-launcher.sh — version-agnostic launcher for the claude-ops daemon.
# Resolves the highest installed ops plugin version at run time, then execs its
# ops-daemon.sh. Survives plugin upgrades without plist edits.
#
# Why: ops-daemon.sh installs this file at $CACHE_ROOT/ops-daemon-launcher.sh
# (outside semver dirs) so launchd/systemd paths survive version pruning. It
# walks the plugin cache, finds the highest semver dir with a valid
# ops-daemon.sh, and execs it.
set -euo pipefail

CACHE_ROOT="${CLAUDE_PLUGIN_CACHE_ROOT:-$HOME/.claude/plugins/cache/ops-marketplace/ops}"

if [[ ! -d "$CACHE_ROOT" ]]; then
  echo "[ops-daemon-launcher] FATAL: cache root missing: $CACHE_ROOT" >&2
  exit 64
fi

# Highest semver dir that contains scripts/ops-daemon.sh
LATEST_VERSION="$(
  find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | awk -F/ '{v=$NF} v ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ {print v}' \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | awk '{lines[NR]=$0} END{for (i=NR; i>=1; i--) print lines[i]}' \
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
# Resolve bash via PATH so this works on Apple Silicon (/opt/homebrew/bin),
# Intel Mac (/usr/local/bin), and Linux (/usr/bin) without hardcoding.
exec bash "$DAEMON" "$@"
