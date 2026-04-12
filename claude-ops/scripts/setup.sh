#!/usr/bin/env bash
# ops setup — Auto-install missing tools + validate readiness
# Called by SessionStart hook and /ops:setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
MISSING=()
INSTALLED=()

# ─── Auto-install core tools ────────────────────────────────────────
auto_install() {
  local tool="$1"
  local brew_pkg="$2"
  if ! command -v "$tool" &>/dev/null; then
    if command -v brew &>/dev/null; then
      brew install "$brew_pkg" 2>/dev/null && INSTALLED+=("$tool") && return 0
    fi
    MISSING+=("$tool")
    return 1
  fi
  return 0
}

# Core (auto-installed silently)
auto_install jq jq
auto_install gh gh
auto_install git git

# Infrastructure (auto-installed if brew available)
auto_install aws awscli
auto_install node node

# Telegram MCP server deps
if [ -f "$PLUGIN_ROOT/telegram-server/package.json" ] && command -v node &>/dev/null; then
  if [ ! -d "$PLUGIN_ROOT/telegram-server/node_modules" ]; then
    (cd "$PLUGIN_ROOT/telegram-server" && npm install --silent 2>/dev/null) && INSTALLED+=("telegram-deps")
  fi
fi

# Plugin bin deps
if [ -f "$PLUGIN_ROOT/package.json" ] && command -v node &>/dev/null; then
  if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
    (cd "$PLUGIN_ROOT" && npm install --silent 2>/dev/null) && INSTALLED+=("plugin-deps")
  fi
fi

# ─── Report only problems ───────────────────────────────────────────
if [ ${#INSTALLED[@]} -gt 0 ]; then
  echo "  ops: auto-installed ${INSTALLED[*]}"
fi

for tool in "${MISSING[@]}"; do
  echo "  ✗ ops: $tool not found — run /ops:setup to configure"
done

# Check registry
REGISTRY="$SCRIPT_DIR/registry.json"
if [ ! -f "$REGISTRY" ]; then
  echo "  ✗ ops: no project registry — run /ops:setup to create one"
fi
