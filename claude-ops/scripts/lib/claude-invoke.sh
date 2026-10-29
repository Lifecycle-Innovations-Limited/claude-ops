#!/usr/bin/env bash
# claude-invoke.sh — env-gated wrapper for claude -p daemon callers.
#
# Usage (source this file, then call claude_invoke):
#   . "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"
#   claude_invoke --no-session-persistence [other claude args]
#
# Gate:
#   CLAUDE_OPS_USE_CREDIT_POOL=1  ->  route through claude-p-as.mjs (credit pool)
#   unset / 0 / any other value   ->  call `claude` directly (current-keychain account)
#
# Repo root resolution order:
#   1. $CLAUDE_OPS_ROOT env var
#   2. $PLUGIN_ROOT (set by deploy-fix-common.sh / plugin loader)
#   3. Walk up from ${BASH_SOURCE[0]} until scripts/account-rotation/claude-p-as.mjs is found
#      (bash only; silently skipped in /bin/sh)

_claude_invoke_find_root() {
  # 1. Explicit env override
  if [ -n "${CLAUDE_OPS_ROOT:-}" ]; then
    printf '%s' "$CLAUDE_OPS_ROOT"
    return 0
  fi
  # 2. PLUGIN_ROOT set by plugin loader / deploy-fix-common.sh
  if [ -n "${PLUGIN_ROOT:-}" ] && [ -f "${PLUGIN_ROOT}/scripts/account-rotation/claude-p-as.mjs" ]; then
    printf '%s' "$PLUGIN_ROOT"
    return 0
  fi
  # 3. Walk up from this file (bash only — BASH_SOURCE is undefined in /bin/sh)
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    local dir
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    while [ "$dir" != "/" ]; do
      if [ -f "$dir/scripts/account-rotation/claude-p-as.mjs" ]; then
        printf '%s' "$dir"
        return 0
      fi
      dir="$(dirname "$dir")"
    done
  fi
  printf ''
  return 1
}

# 2026-10-26: headless runs must never start the telegram channel plugin; it polls
# getUpdates with the claudecode bot token (from ~/.claude/channels/telegram/.env)
# and knocks hermes-primary claudecode out with telegram_polling_conflict.
CLAUDE_INVOKE_NO_TG_SETTINGS='{"enabledPlugins":{"telegram@claude-plugins-official":false}}'
_CLAUDE_INVOKE_SETTINGS_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/headless-settings.py"

_claude_invoke_exec() (
  local child rc=0
  env -u ANTHROPIC_API_KEY -u CLAUDE_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN "$@" <&0 &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 143' TERM
  trap 'kill -INT "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 130' INT
  wait "$child" || rc=$?
  exit "$rc"
)

claude_invoke() {
  local settings="$CLAUDE_INVOKE_NO_TG_SETTINGS" settings_file=""
  local CLAUDE_SETTINGS_OWNER_PID="${BASHPID:-$$}"
  export CLAUDE_SETTINGS_OWNER_PID
  local documents=() args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --settings)
        [ "$#" -ge 2 ] || { printf 'claude-invoke: --settings requires a value\n' >&2; return 2; }
        documents+=("$2"); shift 2 ;;
      --settings=*) documents+=("${1#--settings=}"); shift ;;
      --) args+=("$@"); break ;;
      *) args+=("$1"); shift ;;
    esac
  done
  if [ "${#documents[@]}" -gt 0 ]; then
    settings="$(printf '%s\0' "${documents[@]}" | python3 -I "$_CLAUDE_INVOKE_SETTINGS_HELPER")" || return $?
    settings_file="$settings"
  fi
  # Function subshell owns cleanup without replacing a caller's traps.
  _claude_invoke_run "$settings" "$settings_file" "${args[@]}"
}

_claude_invoke_run() (
  local settings="$1" settings_file="$2"
  shift 2
  [ -z "$settings_file" ] || trap 'rm -f -- "$settings_file"' EXIT
  if [ "${CLAUDE_OPS_USE_CREDIT_POOL:-0}" = "1" ]; then
    local repo_root
    repo_root="$(_claude_invoke_find_root)" || repo_root=""
    local wrapper="${repo_root}/scripts/account-rotation/claude-p-as.mjs"
    if [ -z "$repo_root" ] || [ ! -f "$wrapper" ]; then
      # Wrapper not found — log a warning and fall back to direct claude so
      # daemon jobs are never silently dropped due to misconfiguration.
      printf '[claude-invoke] WARNING: claude-p-as.mjs not found (root=%s) — falling back to direct claude\n' "${repo_root:-unresolved}" >&2
      _claude_invoke_exec claude --settings "$settings" "$@"
      return $?
    fi
    _claude_invoke_exec node "$wrapper" -- --settings "$settings" "$@"
  else
    _claude_invoke_exec claude --settings "$settings" "$@"
  fi
)
