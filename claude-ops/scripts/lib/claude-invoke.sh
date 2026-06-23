#!/usr/bin/env bash
# claude-invoke.sh — env-gated wrapper for claude -p daemon callers.
#
# Usage (source this file, then call claude_invoke):
#   . "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"
#   claude_invoke --model claude-sonnet-4-6 --no-session-persistence [other claude args]
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

_claude_invoke_sanitize_args() {
  CLAUDE_INVOKE_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --model)
        shift
        if [[ "${1:-}" =~ [Hh]aiku ]]; then
          CLAUDE_INVOKE_ARGS+=(--model claude-sonnet-4-6)
        else
          CLAUDE_INVOKE_ARGS+=(--model "$1")
        fi
        ;;
      --model=*)
        local model="${1#--model=}"
        if [[ "$model" =~ [Hh]aiku ]]; then
          CLAUDE_INVOKE_ARGS+=(--model=claude-sonnet-4-6)
        else
          CLAUDE_INVOKE_ARGS+=("$1")
        fi
        ;;
      *)
        CLAUDE_INVOKE_ARGS+=("$1")
        ;;
    esac
    shift
  done
}

_claude_invoke_exec() {
  env -u ANTHROPIC_API_KEY -u CLAUDE_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN "$@"
}

claude_invoke() {
  local CLAUDE_INVOKE_ARGS
  _claude_invoke_sanitize_args "$@"
  if [ "${CLAUDE_OPS_USE_CREDIT_POOL:-0}" = "1" ]; then
    local repo_root
    repo_root="$(_claude_invoke_find_root)" || repo_root=""
    local wrapper="${repo_root}/scripts/account-rotation/claude-p-as.mjs"
    if [ -z "$repo_root" ] || [ ! -f "$wrapper" ]; then
      # Wrapper not found — log a warning and fall back to direct claude so
      # daemon jobs are never silently dropped due to misconfiguration.
      printf '[claude-invoke] WARNING: claude-p-as.mjs not found (root=%s) — falling back to direct claude\n' "${repo_root:-unresolved}" >&2
      _claude_invoke_exec claude "${CLAUDE_INVOKE_ARGS[@]}"
      return $?
    fi
    _claude_invoke_exec node "$wrapper" -- "${CLAUDE_INVOKE_ARGS[@]}"
  else
    _claude_invoke_exec claude "${CLAUDE_INVOKE_ARGS[@]}"
  fi
}
