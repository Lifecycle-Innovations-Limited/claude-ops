#!/usr/bin/env bash
# install-crs-reconcilers-agent.sh — Install the CRS 429-cooldown and/or
# 401-refresher reconcilers as launchd LaunchAgents (macOS).
#
# Reads crs.cooldownEnabled / crs.tokenRefreshEnabled from the rotator config
# and installs only the ones that are true — this script is safe to re-run
# any time config changes (idempotent: re-renders + reloads what's enabled,
# uninstalls what's been turned back off).
#
# Pre-req: same CRS admin credentials as install-crs-priority-agent.sh.
# Config (stateDir, logDir, thresholds) lives in the rotator config.json
# "crs" block — see config.example.json for the full annotated schema.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
[[ -d "$PLUGIN_ROOT" ]] || { echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2; exit 1; }

USER_CFG="$HOME/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json"
REPO_CFG="$PLUGIN_ROOT/scripts/account-rotation/config.json"
CFG="$([[ -f "$USER_CFG" ]] && echo "$USER_CFG" || echo "$REPO_CFG")"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"

command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH (need Node 20+)" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq not found in PATH" >&2; exit 1; }

COOLDOWN_ENABLED="false"
TOKEN_REFRESH_ENABLED="false"
if [[ -f "$CFG" ]]; then
  COOLDOWN_ENABLED="$(jq -r '.crs.cooldownEnabled // false' "$CFG" 2>/dev/null || echo false)"
  TOKEN_REFRESH_ENABLED="$(jq -r '.crs.tokenRefreshEnabled // false' "$CFG" 2>/dev/null || echo false)"
fi
[[ "${CRS_COOLDOWN_ENABLED:-}" == "1" ]] && COOLDOWN_ENABLED="true"
[[ "${CRS_TOKEN_REFRESH_ENABLED:-}" == "1" ]] && TOKEN_REFRESH_ENABLED="true"

if [[ "$COOLDOWN_ENABLED" != "true" && "$TOKEN_REFRESH_ENABLED" != "true" ]]; then
  echo "skip: neither crs.cooldownEnabled nor crs.tokenRefreshEnabled is true in $CFG"
  echo "      set one (or \$CRS_COOLDOWN_ENABLED=1 / \$CRS_TOKEN_REFRESH_ENABLED=1) and re-run"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: launchd is macOS-only."
  echo "Linux: install a systemd user timer for each enabled reconciler:"
  [[ "$COOLDOWN_ENABLED" == "true" ]] && echo "  crs-429-cooldown:   ExecStart=/bin/bash $PLUGIN_ROOT/scripts/account-rotation/crs-429-cooldown.sh   OnUnitActiveSec=60s"
  [[ "$TOKEN_REFRESH_ENABLED" == "true" ]] && echo "  crs-401-refresher:  ExecStart=/bin/bash $PLUGIN_ROOT/scripts/account-rotation/crs-401-refresher.sh  OnUnitActiveSec=300s"
  echo "Then: systemctl --user enable --now <unit>.timer"
  exit 0
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

render_and_install() {
  local name="$1" wrapper="$2" template="$3"
  local dest="$HOME/Library/LaunchAgents/com.claude-ops.${name}.plist"
  chmod +x "$wrapper" 2>/dev/null || true
  PLIST_TEMPLATE_PATH="$template" WRAPPER_PATH="$wrapper" LOG_DIR_PATH="$LOG_DIR" CRS_HOME="$HOME" \
    node -e \
    'const fs=require("fs");const e=(s)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");const t=fs.readFileSync(process.env.PLIST_TEMPLATE_PATH,"utf8");process.stdout.write(t.replace(/__WRAPPER_PATH__/g,e(process.env.WRAPPER_PATH)).replace(/__LOG_DIR__/g,e(process.env.LOG_DIR_PATH)).replace(/__HOME__/g,e(process.env.CRS_HOME)));' \
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

if [[ "$TOKEN_REFRESH_ENABLED" == "true" ]]; then
  render_and_install "crs-401-refresher" \
    "$PLUGIN_ROOT/scripts/account-rotation/crs-401-refresher.sh" \
    "$PLUGIN_ROOT/templates/com.claude-ops.crs-401-refresher.plist"
else
  uninstall "crs-401-refresher"
fi

echo
echo "verify: node \"$PLUGIN_ROOT/scripts/account-rotation/crs-429-cooldown.mjs\" --status"
echo "        node \"$PLUGIN_ROOT/scripts/account-rotation/crs-401-refresher.mjs\" --status"
echo "logs:   $LOG_DIR/crs-429-cooldown.log , $LOG_DIR/crs-401-refresher.log"
echo "uninstall both: launchctl bootout \"gui/\$(id -u)/com.claude-ops.crs-429-cooldown\" \"gui/\$(id -u)/com.claude-ops.crs-401-refresher\""
