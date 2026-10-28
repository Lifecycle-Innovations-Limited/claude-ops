#!/usr/bin/env bash
# Install or update the bundled Just Do It plugin as a local user-scope plugin.
# Usage: install.sh [install|update|uninstall]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MARKET="${JDI_MARKET_DIR:-$HOME/.claude/local-plugins/just-do-it-market}"
DEST="$MARKET/plugins/just-do-it"
case "${1:-install}" in
  install|update)
    mkdir -p "$DEST" "$MARKET/.claude-plugin"
    rsync -a --delete --exclude 'test*' --exclude '__pycache__' --exclude 'runtime' --exclude 'smoke.py' --exclude 'repair_fixture.py' "$HERE/plugin/" "$DEST/"
    printf '%s\n' '{"name":"local-just-do-it","owner":{"name":"local"},"plugins":[{"name":"just-do-it","source":"./plugins/just-do-it","description":"Continue authorized work through verification and delivery."}]}' > "$MARKET/.claude-plugin/marketplace.json"
    claude plugin marketplace add "$MARKET" >/dev/null 2>&1 || true
    claude plugin install just-do-it@local-just-do-it 2>&1 | tail -1
    echo "Active at next session start or /reload-plugins." ;;
  uninstall)
    claude plugin uninstall just-do-it@local-just-do-it
    claude plugin marketplace remove local-just-do-it ;;
  *) echo "usage: $0 [install|update|uninstall]" >&2; exit 2 ;;
esac
