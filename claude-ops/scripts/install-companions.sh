#!/usr/bin/env bash
# install-companions.sh — install and/or update companion plugins declared in
# plugin-dependencies.json (same repo as ops).
#
# Usage:
#   bash scripts/install-companions.sh              # install missing + update always
#   bash scripts/install-companions.sh --update-only  # only updateWithOps companions
#   bash scripts/install-companions.sh --status
#   bash scripts/install-companions.sh --dry-run
#   bash scripts/install-companions.sh --no-external  # same-marketplace only
#
# Env:
#   CLAUDE_PLUGIN_ROOT   ops plugin root
#   OPS_SKIP_COMPANIONS=1  no-op exit 0
#   desktop_act_co_install / userConfig gates via prefs optional (best-effort)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DEPS_JSON="${PLUGIN_ROOT}/plugin-dependencies.json"
PLUGINS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins"

STATUS_ONLY=0
DRY_RUN=0
UPDATE_ONLY=0
NO_EXTERNAL=0
for arg in "$@"; do
  case "$arg" in
    --status) STATUS_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --update-only) UPDATE_ONLY=1 ;;
    --no-external) NO_EXTERNAL=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

if [[ "${OPS_SKIP_COMPANIONS:-0}" == "1" ]]; then
  echo "companions: skipped (OPS_SKIP_COMPANIONS=1)"
  exit 0
fi

if [[ ! -f "$DEPS_JSON" ]]; then
  echo "companions: no plugin-dependencies.json at $DEPS_JSON" >&2
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "companions: jq required" >&2; exit 1; }

is_installed() {
  local name="$1" find_pat="$2"
  if [[ -n "$find_pat" ]]; then
    find "$PLUGINS_DIR" -path "$find_pat" 2>/dev/null | head -1 | grep -q . && return 0
  fi
  # cache dir presence
  find "$PLUGINS_DIR/cache" -type d -name "$name" 2>/dev/null | head -1 | grep -q . && return 0
  # installed_plugins.json mention
  if [[ -f "$PLUGINS_DIR/installed_plugins.json" ]]; then
    jq -e --arg n "$name" '..|strings?|select(test($n))' "$PLUGINS_DIR/installed_plugins.json" >/dev/null 2>&1 && return 0
  fi
  return 1
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [dry-run] $*"
    return 0
  fi
  eval "$@"
}

n_ok=0
n_skip=0
n_fail=0

while IFS= read -r row; do
  name="$(echo "$row" | jq -r '.name')"
  mkt="$(echo "$row" | jq -r '.marketplaceId // empty')"
  mkt_add="$(echo "$row" | jq -r '.marketplaceAdd // empty')"
  install_cli="$(echo "$row" | jq -r '.installCli // empty')"
  update_cli="$(echo "$row" | jq -r '.updateCli // empty')"
  install_script="$(echo "$row" | jq -r '.installScript // empty')"
  same_mp="$(echo "$row" | jq -r '.sameMarketplaceAsOps // false')"
  update_mode="$(echo "$row" | jq -r '.updateWithOps // "never"')"
  find_pat="$(echo "$row" | jq -r '.detect.find // empty')"
  co_default="$(echo "$row" | jq -r '.coInstallDefault // false')"

  if [[ "$NO_EXTERNAL" -eq 1 && "$same_mp" != "true" ]]; then
    echo "skip $name (external marketplace, --no-external)"
    n_skip=$((n_skip + 1))
    continue
  fi

  installed=0
  if is_installed "$name" "$find_pat"; then
    installed=1
  fi

  if [[ "$STATUS_ONLY" -eq 1 ]]; then
    if [[ "$installed" -eq 1 ]]; then
      echo "$name: installed"
    else
      echo "$name: missing"
    fi
    continue
  fi

  # updateWithOps: always | if-installed | never
  if [[ "$update_mode" == "never" ]]; then
    echo "skip $name (updateWithOps=never)"
    n_skip=$((n_skip + 1))
    continue
  fi

  if [[ "$UPDATE_ONLY" -eq 1 && "$installed" -eq 0 ]]; then
    echo "skip $name (not installed, --update-only)"
    n_skip=$((n_skip + 1))
    continue
  fi

  if [[ "$installed" -eq 0 && "$UPDATE_ONLY" -eq 0 ]]; then
    # install path
    if [[ "$co_default" != "true" && "$update_mode" != "always" ]]; then
      echo "skip $name (not installed, coInstallDefault=false)"
      n_skip=$((n_skip + 1))
      continue
    fi
    echo "install $name …"
    if [[ -n "$install_script" && -f "$PLUGIN_ROOT/$install_script" ]]; then
      if run_cmd "bash \"$PLUGIN_ROOT/$install_script\""; then
        echo "ok: $name (script)"; n_ok=$((n_ok + 1)); continue
      fi
    fi
    if [[ -n "$mkt_add" ]]; then
      run_cmd "claude plugin marketplace add \"$mkt_add\" >/dev/null 2>&1 || true"
    fi
    if [[ -n "$install_cli" ]]; then
      if run_cmd "$install_cli >/dev/null 2>&1"; then
        echo "ok: $name (install)"; n_ok=$((n_ok + 1))
      else
        echo "fail: $name install" >&2; n_fail=$((n_fail + 1))
      fi
    else
      echo "fail: $name no installCli" >&2; n_fail=$((n_fail + 1))
    fi
    continue
  fi

  # update path (installed)
  echo "update $name …"
  if [[ "$same_mp" != "true" && -n "$mkt" ]]; then
    run_cmd "claude plugin marketplace update \"$mkt\" >/dev/null 2>&1 || true"
  fi
  if [[ -n "$update_cli" ]]; then
    if run_cmd "$update_cli >/dev/null 2>&1"; then
      echo "ok: $name (update)"; n_ok=$((n_ok + 1))
    else
      # reinstall fallback
      if [[ -n "$install_cli" ]] && run_cmd "$install_cli >/dev/null 2>&1"; then
        echo "ok: $name (reinstall fallback)"; n_ok=$((n_ok + 1))
      else
        echo "warn: $name update non-zero (non-fatal)" >&2
        n_fail=$((n_fail + 1))
      fi
    fi
  elif [[ -n "$install_script" && -f "$PLUGIN_ROOT/$install_script" ]]; then
    run_cmd "bash \"$PLUGIN_ROOT/$install_script\"" && echo "ok: $name (script)" && n_ok=$((n_ok + 1))
  else
    echo "skip $name (no updateCli)"; n_skip=$((n_skip + 1))
  fi
done < <(jq -c '.companions[]' "$DEPS_JSON")

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  exit 0
fi

echo "companions: ok=$n_ok skip=$n_skip fail=$n_fail"
# never fail ops-update over companions
exit 0
