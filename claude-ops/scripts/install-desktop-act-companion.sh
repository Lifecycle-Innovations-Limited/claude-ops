#!/usr/bin/env bash
# install-desktop-act-companion.sh — co-install the desktop-act plugin from the
# same ops-marketplace that ships claude-ops.
#
# Idempotent. No host-specific paths. Prefer Claude plugin CLI; fall back to
# ensuring the marketplace checkout contains ./desktop-act (vendored source).
#
# Usage:
#   bash scripts/install-desktop-act-companion.sh
#   bash scripts/install-desktop-act-companion.sh --status
#   bash scripts/install-desktop-act-companion.sh --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
# Marketplace root is parent of the ops plugin source when layout is repo/claude-ops/
MARKETPLACE_ROOT="${OPS_MARKETPLACE_ROOT:-}"
if [[ -z "$MARKETPLACE_ROOT" ]]; then
  if [[ -f "${PLUGIN_ROOT}/../.claude-plugin/marketplace.json" ]]; then
    MARKETPLACE_ROOT="$(cd "${PLUGIN_ROOT}/.." && pwd)"
  elif [[ -f "${PLUGIN_ROOT}/.claude-plugin/marketplace.json" ]]; then
    MARKETPLACE_ROOT="$PLUGIN_ROOT"
  else
    # Installed cache: …/cache/ops-marketplace/ops/<ver> → marketplaces/ops-marketplace
    CANDIDATE="$(cd "${PLUGIN_ROOT}/../../.." 2>/dev/null && pwd || true)"
    if [[ -n "$CANDIDATE" && -f "${CANDIDATE}/.claude-plugin/marketplace.json" ]]; then
      MARKETPLACE_ROOT="$CANDIDATE"
    fi
  fi
fi

STATUS_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --status) STATUS_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

desktop_act_present() {
  # Installed as a Claude Code plugin
  if find "${HOME}/.claude/plugins" -path '*/desktop-act/*plugin.json' 2>/dev/null | head -1 | grep -q .; then
    return 0
  fi
  # Vendored next to marketplace / ops plugin
  if [[ -n "${MARKETPLACE_ROOT:-}" && -f "${MARKETPLACE_ROOT}/desktop-act/.claude-plugin/plugin.json" ]]; then
    return 0
  fi
  if [[ -f "${PLUGIN_ROOT}/../desktop-act/.claude-plugin/plugin.json" ]]; then
    return 0
  fi
  return 1
}

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  if desktop_act_present; then
    echo "desktop-act: installed"
    exit 0
  fi
  echo "desktop-act: missing"
  exit 1
fi

if desktop_act_present; then
  echo "ok: desktop-act already available"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: would install desktop-act@ops-marketplace"
  exit 0
fi

# Prefer Claude Code plugin CLI (registers MCP + skills)
if command -v claude >/dev/null 2>&1; then
  # Marketplace already present when ops is installed from ops-marketplace
  if claude plugin install desktop-act@ops-marketplace 2>/dev/null; then
    echo "ok: desktop-act installed via claude plugin CLI"
    exit 0
  fi
  # Retry after ensuring marketplace is registered
  if [[ -n "${MARKETPLACE_ROOT:-}" ]]; then
    claude plugin marketplace add "$MARKETPLACE_ROOT" 2>/dev/null || true
  else
    claude plugin marketplace add Lifecycle-Innovations-Limited/claude-ops 2>/dev/null || true
  fi
  if claude plugin install desktop-act@ops-marketplace 2>/dev/null; then
    echo "ok: desktop-act installed via claude plugin CLI (after marketplace add)"
    exit 0
  fi
fi

# Vendored source is enough for the launcher (mcp-servers/desktop-act-launcher.py)
if [[ -n "${MARKETPLACE_ROOT:-}" && -f "${MARKETPLACE_ROOT}/desktop-act/mcp-server/run.sh" ]]; then
  echo "ok: desktop-act source present at ${MARKETPLACE_ROOT}/desktop-act (launcher will use it)"
  exit 0
fi

echo "error: could not install desktop-act companion" >&2
echo "  try: claude plugin install desktop-act@ops-marketplace" >&2
echo "  or set DESKTOP_ACT_HOME to a checkout with mcp-server/run.sh" >&2
exit 1
