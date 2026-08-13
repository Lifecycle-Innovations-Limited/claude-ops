#!/usr/bin/env bash
# install-crs-reconcilers-agent.sh — Install the CRS 429-cooldown and/or
# magic-link-autoloop reconcilers as launchd LaunchAgents (macOS).
#
# Reads crs.cooldownEnabled / crs.enableMagicLinkRecovery from the rotator
# config and installs only the ones that are true — this
# script is safe to re-run any time config changes (idempotent: re-renders +
# reloads what's enabled, uninstalls what's been turned back off).
#
# Pre-req: same CRS admin credentials as install-crs-priority-agent.sh.
# Config (stateDir, logDir, thresholds) lives in the rotator config.json
# "crs" block — see config.example.json for the full annotated schema.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
[[ -d "$PLUGIN_ROOT" ]] || { echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2; exit 1; }
: "${CLAUDE_AUTH_COORDINATION_CONFIG:?set the canonical reviewed coordination config path}"
: "${CLAUDE_ROTATOR_CONFIG:?set the canonical reviewed runtime inventory path}"

CFG="$CLAUDE_ROTATOR_CONFIG"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"

command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH (need Node 20+)" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq not found in PATH" >&2; exit 1; }

COOLDOWN_ENABLED="false"
TOKEN_REFRESH_ENABLED="false"
MAGIC_LINK_ENABLED="false"
if [[ -f "$CFG" ]]; then
  COOLDOWN_ENABLED="$(jq -r '.crs.cooldownEnabled // false' "$CFG" 2>/dev/null || echo false)"
  TOKEN_REFRESH_ENABLED="$(jq -r '.crs.tokenRefreshEnabled // false' "$CFG" 2>/dev/null || echo false)"
  MAGIC_LINK_ENABLED="$(jq -r '.crs.enableMagicLinkRecovery // false' "$CFG" 2>/dev/null || echo false)"
fi
[[ "${CRS_COOLDOWN_ENABLED:-}" == "1" ]] && COOLDOWN_ENABLED="true"
[[ "${CRS_TOKEN_REFRESH_ENABLED:-}" == "1" ]] && TOKEN_REFRESH_ENABLED="true"
[[ "${CRS_ENABLE_MAGIC_LINK:-}" == "1" ]] && MAGIC_LINK_ENABLED="true"

if [[ "$TOKEN_REFRESH_ENABLED" == "true" ]]; then
  echo "error: CRS 401 refresher is retired; use the identity-verified crs-token-feed service" >&2
  exit 1
fi

if [[ "$COOLDOWN_ENABLED" != "true" && "$TOKEN_REFRESH_ENABLED" != "true" && "$MAGIC_LINK_ENABLED" != "true" ]]; then
  echo "skip: none of crs.cooldownEnabled / crs.tokenRefreshEnabled / crs.enableMagicLinkRecovery is true in $CFG"
  echo "      set one (or \$CRS_COOLDOWN_ENABLED=1 / \$CRS_TOKEN_REFRESH_ENABLED=1 / \$CRS_ENABLE_MAGIC_LINK=1) and re-run"
  exit 0
fi

if [[ "$MAGIC_LINK_ENABLED" == "true" ]]; then
  echo "note: crs.enableMagicLinkRecovery is true — magic-link-autoloop will attempt UNATTENDED"
  echo "      browser-based re-auth for confirmed dead-refresh-token accounts. Review"
  echo "      config.example.json's _enableMagicLinkRecovery_note if this is unexpected."
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: launchd is macOS-only."
  echo "Linux: install a systemd user timer for each enabled reconciler:"
  [[ "$COOLDOWN_ENABLED" == "true" ]] && echo "  crs-429-cooldown:      ExecStart=/bin/bash $PLUGIN_ROOT/scripts/account-rotation/crs-429-cooldown.sh      OnUnitActiveSec=60s"
  [[ "$MAGIC_LINK_ENABLED" == "true" ]] && echo "  magic-link-autoloop:   ExecStart=/bin/bash $PLUGIN_ROOT/scripts/account-rotation/magic-link-autoloop.sh   OnUnitActiveSec=600s"
  echo "Then: systemctl --user enable --now <unit>.timer"
  exit 0
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

render_and_install() {
  local name="$1" wrapper="$2" template="$3"
  local dest="$HOME/Library/LaunchAgents/com.claude-ops.${name}.plist"
  chmod +x "$wrapper" 2>/dev/null || true
  # PATH/DISPLAY come from the install host (never bake OS package roots into the template).
  local host_path="${PATH:-/usr/local/bin:/usr/bin:/bin}"
  local host_display="${CLAUDE_DESKTOP_DISPLAY:-${DISPLAY:-:0}}"
  PLIST_TEMPLATE_PATH="$template" WRAPPER_PATH="$wrapper" LOG_DIR_PATH="$LOG_DIR" CRS_HOME="$HOME" \
    AUTH_COORDINATION_CONFIG="$CLAUDE_AUTH_COORDINATION_CONFIG" ROTATOR_CONFIG="$CLAUDE_ROTATOR_CONFIG" \
    CRS_PATH="$host_path" CRS_DISPLAY="$host_display" \
    node -e \
    'const fs=require("fs");const e=(s)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");const t=fs.readFileSync(process.env.PLIST_TEMPLATE_PATH,"utf8");process.stdout.write(t.replace(/__WRAPPER_PATH__/g,e(process.env.WRAPPER_PATH)).replace(/__LOG_DIR__/g,e(process.env.LOG_DIR_PATH)).replace(/__HOME__/g,e(process.env.CRS_HOME)).replace(/__PATH__/g,e(process.env.CRS_PATH||"")).replace(/__DISPLAY__/g,e(process.env.CRS_DISPLAY||":0")).replace(/__CLAUDE_AUTH_COORDINATION_CONFIG__/g,e(process.env.AUTH_COORDINATION_CONFIG)).replace(/__CLAUDE_ROTATOR_CONFIG__/g,e(process.env.ROTATOR_CONFIG)));' \
    > "$dest"
  launchctl bootout "gui/$(id -u)/com.claude-ops.${name}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dest"
  echo "ok: ${name} installed ($dest)"
}

uninstall() {
  local name="$1" dest="$HOME/Library/LaunchAgents/com.claude-ops.${name}.plist"
  if [[ -f "$dest" ]]; then
    launchctl bootout "gui/$(id -u)/com.claude-ops.${name}" 2>/dev/null || true
    rm -f "$dest"
    echo "ok: ${name} uninstalled (was enabled, now disabled in config)"
  fi
}

if [[ "$COOLDOWN_ENABLED" == "true" ]]; then
  render_and_install "crs-429-cooldown" \
    "$PLUGIN_ROOT/scripts/account-rotation/crs-429-cooldown.sh" \
    "$PLUGIN_ROOT/templates/com.claude-ops.crs-429-cooldown.plist"
else
  uninstall "crs-429-cooldown"
fi

uninstall "crs-401-refresher"

if [[ "$MAGIC_LINK_ENABLED" == "true" ]]; then
  render_and_install "magic-link-autoloop" \
    "$PLUGIN_ROOT/scripts/account-rotation/magic-link-autoloop.sh" \
    "$PLUGIN_ROOT/templates/com.claude-ops.magic-link-autoloop.plist"
else
  uninstall "magic-link-autoloop"
fi

echo
echo "verify: node \"$PLUGIN_ROOT/scripts/account-rotation/crs-429-cooldown.mjs\" --status"
echo "        node \"$PLUGIN_ROOT/scripts/account-rotation/magic-link-autoloop.mjs\" --status"
echo "logs:   $LOG_DIR/crs-429-cooldown.log , $LOG_DIR/magic-link-autoloop.log"
echo "uninstall all: launchctl bootout \"gui/\$(id -u)/com.claude-ops.crs-429-cooldown\" \"gui/\$(id -u)/com.claude-ops.magic-link-autoloop\""
