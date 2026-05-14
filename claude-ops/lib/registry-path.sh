#!/usr/bin/env bash
# lib/registry-path.sh — canonical resolver for registry.json + OPS_DATA_DIR
#
# Resolves OPS_DATA_DIR (canonical, survives plugin updates) and REGISTRY
# (registry.json path). Prefers the per-user data dir; falls back to the
# in-repo cache path for back-compat with installs that pre-date the data-dir
# migration.
#
# Sourcing convention:
#   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   . "${PLUGIN_ROOT}/lib/registry-path.sh"
#   # or, when the caller already exports its own root variable:
#   OPS_PLUGIN_ROOT_FALLBACK="$PLUGIN_DIR" . "${PLUGIN_DIR}/lib/registry-path.sh"
#
# Exports:
#   OPS_DATA_DIR   — ${CLAUDE_PLUGIN_DATA_DIR:-~/.claude/plugins/data/ops-ops-marketplace}
#   REGISTRY       — first existing of: $OPS_DATA_DIR/registry.json,
#                    $OPS_PLUGIN_ROOT_FALLBACK/scripts/registry.json,
#                    $PLUGIN_ROOT/scripts/registry.json. Defaults to the
#                    canonical data-dir path even if the file is missing, so
#                    callers can write to it.

OPS_DATA_DIR="${OPS_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}}"
export OPS_DATA_DIR

_ops_canonical_registry="${OPS_DATA_DIR}/registry.json"
_ops_legacy_registry=""
if [ -n "${OPS_PLUGIN_ROOT_FALLBACK:-}" ] && [ -f "${OPS_PLUGIN_ROOT_FALLBACK}/scripts/registry.json" ]; then
  _ops_legacy_registry="${OPS_PLUGIN_ROOT_FALLBACK}/scripts/registry.json"
elif [ -n "${PLUGIN_ROOT:-}" ] && [ -f "${PLUGIN_ROOT}/scripts/registry.json" ]; then
  _ops_legacy_registry="${PLUGIN_ROOT}/scripts/registry.json"
fi

if [ -f "$_ops_canonical_registry" ]; then
  REGISTRY="$_ops_canonical_registry"
elif [ -n "$_ops_legacy_registry" ]; then
  REGISTRY="$_ops_legacy_registry"
else
  REGISTRY="$_ops_canonical_registry"
fi
export REGISTRY

unset _ops_canonical_registry _ops_legacy_registry
