#!/usr/bin/env bash
# ops-pocket-activity-notifier-launcher.sh — version-agnostic launcher for the
# pocket activity notifier. Resolves the highest installed ops plugin version
# at run time, then execs scripts/ops-pocket-activity-notifier.py with python3.
# Survives plugin upgrades without plist edits.
set -euo pipefail

CACHE_ROOT="${CLAUDE_PLUGIN_CACHE_ROOT:-$HOME/.claude/plugins/cache/ops-marketplace/ops}"

if [[ ! -d "$CACHE_ROOT" ]]; then
  echo "[ops-pocket-activity-notifier-launcher] FATAL: cache root missing: $CACHE_ROOT" >&2
  exit 64
fi

# Highest semver dir that contains scripts/ops-pocket-activity-notifier.py
LATEST_VERSION="$(
  find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | awk -F/ '{print $NF}' \
    | awk '/^[0-9]+\.[0-9]+\.[0-9]+$/ { print }' \
    | sort -V \
    | tac \
    | while read -r v; do
        if [[ -f "$CACHE_ROOT/$v/scripts/ops-pocket-activity-notifier.py" ]]; then
          echo "$v"; break
        fi
      done
)"

if [[ -z "${LATEST_VERSION:-}" ]]; then
  echo "[ops-pocket-activity-notifier-launcher] FATAL: no installed ops version has scripts/ops-pocket-activity-notifier.py" >&2
  exit 65
fi

NOTIFIER="$CACHE_ROOT/$LATEST_VERSION/scripts/ops-pocket-activity-notifier.py"
export CLAUDE_PLUGIN_ROOT="$CACHE_ROOT/$LATEST_VERSION"

# Match install-pocket-notifier.sh: Apple Silicon Homebrew → Intel Homebrew → PATH
PYTHON_PATH=""
if [[ -x /opt/homebrew/bin/python3 ]]; then
  PYTHON_PATH="/opt/homebrew/bin/python3"
elif [[ -x /usr/local/bin/python3 ]]; then
  PYTHON_PATH="/usr/local/bin/python3"
else
  PYTHON_PATH="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON_PATH" || ! -x "$PYTHON_PATH" ]]; then
  echo "[ops-pocket-activity-notifier-launcher] FATAL: could not find python3" >&2
  exit 66
fi

echo "[ops-pocket-activity-notifier-launcher] resolved ops $LATEST_VERSION → $NOTIFIER (python: $PYTHON_PATH)"
exec "$PYTHON_PATH" "$NOTIFIER" "$@"
