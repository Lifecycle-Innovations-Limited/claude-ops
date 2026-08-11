#!/usr/bin/env bash
# install-gsd-companion.sh — co-install/update GSD, aware of both distribution channels.
#
# GSD ships two ways:
#   1. npm installer (@opengsd/gsd-core) — writes skills into ~/.claude/skills/gsd-*
#      and keeps its core at ~/.claude/gsd-core (VERSION file). GSD's own
#      /gsd-update workflow manages this channel.
#   2. Claude marketplace plugin (gsd@gsd-build-get-shit-done).
#
# The plain updateCli route (`claude plugin update gsd@...`) fails on every box
# that installed GSD via npm: the skills are detected, but the plugin was never
# installed and the marketplace was never added, so ops-update warned on each
# run. This script picks the channel that is actually present:
#   - ~/.claude/gsd-core/VERSION exists  → npm channel: compare against the
#     registry and update via the documented installer command when behind.
#   - otherwise                          → plugin channel: add the marketplace,
#     then update (or install) the plugin.
#
# Portable: no host hardcodes. Override via env:
#   GSD_CORE_DIR      npm-channel core dir (default $HOME/.claude/gsd-core)
#   GSD_NPM_PACKAGE   npm package (default @opengsd/gsd-core)
#   GSD_MARKETPLACE   marketplace repo (default gsd-build/get-shit-done)
#   GSD_PLUGIN_SPEC   plugin spec (default gsd@gsd-build-get-shit-done)
#
# Usage:
#   bash scripts/install-gsd-companion.sh
#   bash scripts/install-gsd-companion.sh --status
#   bash scripts/install-gsd-companion.sh --dry-run
#   bash scripts/install-gsd-companion.sh --update
set -euo pipefail

GSD_CORE_DIR="${GSD_CORE_DIR:-${HOME}/.claude/gsd-core}"
GSD_NPM_PACKAGE="${GSD_NPM_PACKAGE:-@opengsd/gsd-core}"
GSD_MARKETPLACE="${GSD_MARKETPLACE:-gsd-build/get-shit-done}"
GSD_PLUGIN_SPEC="${GSD_PLUGIN_SPEC:-gsd@gsd-build-get-shit-done}"

STATUS_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --status) STATUS_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --update) ;; # install and update converge on the same channel logic
    -h|--help)
      sed -n '2,29p' "$0"
      exit 0
      ;;
  esac
done

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [dry-run] $*"
    return 0
  fi
  "$@"
}

npm_managed() {
  [[ -f "${GSD_CORE_DIR}/VERSION" ]]
}

plugin_managed() {
  local installed="${HOME}/.claude/plugins/installed_plugins.json"
  [[ -f "$installed" ]] && grep -q '"gsd"' "$installed" 2>/dev/null
}

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  if npm_managed; then
    echo "gsd: installed (npm, $(cat "${GSD_CORE_DIR}/VERSION"))"
  elif plugin_managed; then
    echo "gsd: installed (plugin)"
  else
    echo "gsd: missing"
  fi
  exit 0
fi

if npm_managed; then
  installed="$(cat "${GSD_CORE_DIR}/VERSION")"
  # Registry unreachable is not a failure — the install is intact, only the
  # freshness check is skipped this run.
  latest="$(npm view "$GSD_NPM_PACKAGE" version 2>/dev/null || true)"
  if [[ -z "$latest" ]]; then
    echo "gsd: npm-managed ($installed); registry unreachable, skipping version check"
    exit 0
  fi
  if [[ "$installed" == "$latest" ]]; then
    echo "gsd: npm-managed, already latest ($installed)"
    exit 0
  fi
  echo "gsd: npm-managed $installed → $latest, updating…"
  # Documented installer invocation from gsd-core's own update workflow.
  # </dev/null so an unexpected prompt fails fast instead of hanging ops-update.
  if run_cmd npx -y --package="${GSD_NPM_PACKAGE}@latest" -- gsd-core --claude --global </dev/null; then
    echo "gsd: updated to $latest (npm)"
    exit 0
  fi
  echo "gsd: npm update failed (non-fatal); rerun /gsd-update manually" >&2
  exit 1
fi

# Plugin channel (or fresh install): the marketplace add is what the old
# updateCli-only route was missing.
run_cmd claude plugin marketplace add "$GSD_MARKETPLACE" >/dev/null 2>&1 || true
if plugin_managed; then
  if run_cmd claude plugin update "$GSD_PLUGIN_SPEC" >/dev/null 2>&1; then
    echo "gsd: updated (plugin)"
    exit 0
  fi
fi
if run_cmd claude plugin install "$GSD_PLUGIN_SPEC" >/dev/null 2>&1; then
  echo "gsd: installed (plugin)"
  exit 0
fi
echo "gsd: plugin install/update failed" >&2
exit 1
