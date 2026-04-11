#!/usr/bin/env bash
# ops setup — Validate CLI tools and report readiness
# Run this after installing the ops plugin to check what's available

set -euo pipefail

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " OPS ► SETUP CHECK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

check_tool() {
  local name="$1"
  local cmd="$2"
  local purpose="$3"
  local required="$4"

  if command -v "$cmd" &>/dev/null; then
    version=$($cmd --version 2>/dev/null | head -1 || echo "installed")
    echo "  ✓ $name — $version"
  else
    if [ "$required" = "required" ]; then
      echo "  ✗ $name — NOT FOUND (required for $purpose)"
    else
      echo "  ○ $name — not found (optional, needed for $purpose)"
    fi
  fi
}

echo "## Core Tools (required)"
check_tool "jq" "jq" "JSON processing" "required"
check_tool "git" "git" "repository management" "required"
check_tool "gh" "gh" "GitHub PRs and CI" "required"

echo ""
echo "## Communication Tools"
check_tool "wacli" "wacli" "/ops-comms whatsapp" "optional"
check_tool "gog" "gog" "/ops-comms email + calendar" "optional"

echo ""
echo "## Infrastructure Tools"
check_tool "aws" "aws" "/ops-infra ECS health" "optional"
check_tool "sentry-cli" "sentry-cli" "/ops-triage Sentry issues" "optional"

echo ""
echo "## Other Tools"
check_tool "doppler" "doppler" "secrets management" "optional"
check_tool "node" "node" "Telegram MCP server" "optional"

echo ""

# Check registry
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"
if [ -f "$REGISTRY" ]; then
  PROJECT_COUNT=$(jq '.projects | length' "$REGISTRY")
  echo "## Registry"
  echo "  ✓ registry.json — $PROJECT_COUNT projects configured"
else
  echo "## Registry"
  echo "  ✗ registry.json — NOT FOUND (copy from template and configure)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete. Run /ops-go for your first briefing."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
