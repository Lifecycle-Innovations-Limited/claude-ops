#!/usr/bin/env bash
# pocket-responder-run.sh — entrypoint for the canonical Pocket/social approval
# responder. Sources secrets + email-cos config, pins POCKET_STATE_DIR, then runs
# the responder in the requested mode.
#
# Usage: pocket-responder-run.sh {send|process}
#   send     post a tappable button message per open ASK (delivery half)
#   process  drain responder-inbox.jsonl (taps + freeform text) and act
set -euo pipefail

MODE="${1:-process}"

# Secrets (EMAIL_COS_APPROVAL_BOT_TOKEN, TYPEFULLY_API_KEY, GOG_KEYRING_PASSWORD, ...)
if [[ -f "$HOME/.mcp-secrets.env" ]]; then
  set -a; . "$HOME/.mcp-secrets.env"; set +a
fi
# email-cos config (EMAIL_COS_TG_CHAT_ID, EMAIL_COS_TG_ENABLE, ...)
CONFIG="${EMAIL_COS_CONFIG:-$HOME/.config/email-cos/config.sh}"
if [[ -f "$CONFIG" ]]; then
  set -a; . "$CONFIG"; set +a
fi

export POCKET_STATE_DIR="${POCKET_STATE_DIR:-/var/lib/pocket-pipeline}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HOME/.local/state/email-cos"
mkdir -p "$OUT"

case "$MODE" in
  send)    exec /usr/bin/python3 "$SCRIPT_DIR/pocket-responder.py" send    >>"$OUT/responder-send.out" 2>&1 ;;
  process) exec /usr/bin/python3 "$SCRIPT_DIR/pocket-responder.py" process >>"$OUT/responder-process.out" 2>&1 ;;
  *) echo "usage: $0 {send|process}" >&2; exit 2 ;;
esac
