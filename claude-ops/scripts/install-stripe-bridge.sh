#!/usr/bin/env bash
# install-stripe-bridge.sh — Register ops-stripe-conversion-bridge as a daemon service
#
# Adds the stripe-conversion-bridge entry to daemon-services.default.json (if not
# already present) and installs it into OPS_DATA_DIR/daemon-services.json.
#
# Usage:
#   bash scripts/install-stripe-bridge.sh [--enable]
#
# Flags:
#   --enable   Set "enabled": true in the service entry (default: false — opt-in)
#
# Environment:
#   OPS_STRIPE_BRIDGE_PORT     — forwarded to the service command (default 8787)
#   STRIPE_WEBHOOK_SECRET      — must be set before daemon runs (not committed)
#   OPS_CONVERSION_PROJECT     — ops project key for conversion fanout
#   OPS_DATA_DIR               — plugin data dir
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/.."
OPS_PLUGIN_ROOT_FALLBACK="$PLUGIN_ROOT" . "${PLUGIN_ROOT}/lib/registry-path.sh"

ENABLE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=true; shift ;;
    *) echo "install-stripe-bridge: unknown flag '$1'" >&2; exit 1 ;;
  esac
done

DAEMON_DEFAULTS="${PLUGIN_ROOT}/scripts/daemon-services.default.json"
DAEMON_LOCAL="${OPS_DATA_DIR}/daemon-services.json"
PORT="${OPS_STRIPE_BRIDGE_PORT:-8787}"

SERVICE_KEY="stripe-conversion-bridge"

# ── Build service entry ───────────────────────────────────────────────────────
SERVICE_JSON="$(jq -n \
  --argjson enabled "$ENABLE" \
  --arg port "$PORT" \
  '{
    enabled: $enabled,
    command: "${CLAUDE_PLUGIN_ROOT}/bin/ops-stripe-conversion-bridge.mjs",
    health_check: ("lsof -i :" + $port + " | grep LISTEN"),
    restart_delay: 30,
    max_restarts: 10,
    _note: "Stripe webhook → GA4 MP + Meta CAPI fanout. Requires STRIPE_WEBHOOK_SECRET and OPS_CONVERSION_PROJECT in env. Enable with: bash scripts/install-stripe-bridge.sh --enable"
  }')"

# ── Merge into daemon-services.default.json ───────────────────────────────────
if jq -e --arg k "$SERVICE_KEY" '.services[$k] != null' "$DAEMON_DEFAULTS" >/dev/null 2>&1; then
  echo "install-stripe-bridge: '$SERVICE_KEY' already present in daemon-services.default.json — updating"
else
  echo "install-stripe-bridge: adding '$SERVICE_KEY' to daemon-services.default.json"
fi

TMP="$(mktemp)"
jq --arg k "$SERVICE_KEY" --argjson svc "$SERVICE_JSON" \
  '.services[$k] = $svc' "$DAEMON_DEFAULTS" > "$TMP"
mv "$TMP" "$DAEMON_DEFAULTS"

# ── Merge into live daemon-services.json (OPS_DATA_DIR) ───────────────────────
if [ -f "$DAEMON_LOCAL" ]; then
  # Only update if key is missing or entry differs — preserve user's enabled flag
  # unless --enable was passed.
  existing_entry="$(jq -r --arg k "$SERVICE_KEY" '.services[$k] // "null"' "$DAEMON_LOCAL" 2>/dev/null || echo "null")"
  if [ "$existing_entry" = "null" ]; then
    echo "install-stripe-bridge: adding entry to ${DAEMON_LOCAL}"
    TMP2="$(mktemp)"
    jq --arg k "$SERVICE_KEY" --argjson svc "$SERVICE_JSON" \
      '.services[$k] = $svc' "$DAEMON_LOCAL" > "$TMP2"
    mv "$TMP2" "$DAEMON_LOCAL"
  elif $ENABLE; then
    echo "install-stripe-bridge: setting enabled=true in ${DAEMON_LOCAL}"
    TMP2="$(mktemp)"
    jq --arg k "$SERVICE_KEY" '.services[$k].enabled = true' "$DAEMON_LOCAL" > "$TMP2"
    mv "$TMP2" "$DAEMON_LOCAL"
  else
    echo "install-stripe-bridge: entry already exists in ${DAEMON_LOCAL} — skipping (use --enable to activate)"
  fi
else
  echo "install-stripe-bridge: ${DAEMON_LOCAL} not found — skipping live config update (run /ops:setup daemon first)"
fi

echo ""
echo "Stripe conversion bridge registered."
echo ""
echo "Required environment variables (set before starting the daemon):"
echo "  STRIPE_WEBHOOK_SECRET=whsec_<your-secret>"
echo "  OPS_CONVERSION_PROJECT=<your-project-key>"
echo "  OPS_STRIPE_BRIDGE_PORT=${PORT}  (optional, default 8787)"
echo ""
if $ENABLE; then
  echo "Service is ENABLED. Restart the ops daemon to activate:"
  echo "  bash scripts/ops-daemon-manager.sh restart"
else
  echo "Service is DISABLED (default). Enable it with:"
  echo "  bash scripts/install-stripe-bridge.sh --enable"
fi
