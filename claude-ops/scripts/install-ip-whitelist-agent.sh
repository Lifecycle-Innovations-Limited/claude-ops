#!/usr/bin/env bash
# install-ip-whitelist-agent.sh — install an OS-native agent that keeps your AWS
# Security Group ingress synced to this machine's public IP.
#
# Idempotent: unloads/disables any existing agent before reinstalling.
# Supports macOS (launchd) today; Linux (systemd path unit) coming next.
#
# Required env (or read from claude-ops preferences if unset):
#   IP_WHITELIST_SG_ID            target Security Group (sg-...)
# Optional:
#   IP_WHITELIST_REGION           default: us-east-1
#   IP_WHITELIST_PORT             default: 22
#   IP_WHITELIST_DESC_PREFIX      default: <hostname>-laptop

set -euo pipefail

LABEL="com.claude-ops.ip-whitelist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_TEMPLATE="${PLUGIN_ROOT}/launchd/${LABEL}.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# Read config (env wins; prefs fallback omitted for portability — set the env)
IP_WHITELIST_SG_ID="${IP_WHITELIST_SG_ID:-}"
IP_WHITELIST_REGION="${IP_WHITELIST_REGION:-us-east-1}"
IP_WHITELIST_PORT="${IP_WHITELIST_PORT:-22}"
DEFAULT_PREFIX="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo claude-ops)-laptop"
IP_WHITELIST_DESC_PREFIX="${IP_WHITELIST_DESC_PREFIX:-$DEFAULT_PREFIX}"

log() { printf '[install-ip-whitelist] %s\n' "$*"; }
die() { log "ERROR: $*"; exit 1; }

if [[ -z "$IP_WHITELIST_SG_ID" ]]; then
  die "IP_WHITELIST_SG_ID is required. Example: IP_WHITELIST_SG_ID=sg-0123456789abcdef0 $0"
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    GUI_DOMAIN="gui/$(id -u)"

    if launchctl print "${GUI_DOMAIN}/${LABEL}" &>/dev/null; then
      log "unloading existing agent..."
      launchctl bootout "${GUI_DOMAIN}/${PLIST_DEST}" 2>/dev/null \
        || launchctl bootout "${GUI_DOMAIN}" "${PLIST_DEST}" 2>/dev/null \
        || launchctl remove "${LABEL}" 2>/dev/null \
        || true
      sleep 1
    fi

    [[ -f "$PLIST_TEMPLATE" ]] || die "plist template missing: $PLIST_TEMPLATE"

    log "rendering plist with PLUGIN_ROOT=$PLUGIN_ROOT SG=$IP_WHITELIST_SG_ID"
    mkdir -p "$(dirname "$PLIST_DEST")"
    sed \
      -e "s|__PLUGIN_ROOT__|${PLUGIN_ROOT}|g" \
      -e "s|__IP_WHITELIST_SG_ID__|${IP_WHITELIST_SG_ID}|g" \
      -e "s|__IP_WHITELIST_REGION__|${IP_WHITELIST_REGION}|g" \
      -e "s|__IP_WHITELIST_PORT__|${IP_WHITELIST_PORT}|g" \
      -e "s|__IP_WHITELIST_DESC_PREFIX__|${IP_WHITELIST_DESC_PREFIX}|g" \
      "$PLIST_TEMPLATE" > "$PLIST_DEST"

    log "bootstrapping ${GUI_DOMAIN}/${LABEL}"
    launchctl bootstrap "${GUI_DOMAIN}" "${PLIST_DEST}"

    log "agent loaded. status:"
    launchctl print "${GUI_DOMAIN}/${LABEL}" | head -20
    ;;
  Linux)
    log "Linux support coming next — for now run the script via cron or systemd:"
    log "  */5 * * * * IP_WHITELIST_SG_ID=$IP_WHITELIST_SG_ID $PLUGIN_ROOT/scripts/aws-sg-ip-whitelist.sh"
    exit 2
    ;;
  *)
    die "unsupported OS: $OS"
    ;;
esac
