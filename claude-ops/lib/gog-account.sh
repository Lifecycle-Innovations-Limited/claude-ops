#!/usr/bin/env bash
# lib/gog-account.sh — resolve the gog account + unlock its token store.
#
# Why this exists: `gog` refuses every command with
#   "missing --account (or set GOG_ACCOUNT, ...)"
# as soon as more than one token is stored, and it refuses again with
#   "no TTY available for keyring file backend password prompt"
# when the keyring password is not in the environment. Both failures exit
# non-zero with a message on stderr, which callers used to swallow into
# "gog not authenticated" — a checker that cannot measure reading as a clean
# negative result. Source this file instead of guessing.
#
# Usage:
#   source "$PLUGIN_ROOT/lib/gog-account.sh"
#   if ops_gog_ready; then
#     gog gmail search -a "$OPS_GOG_ACCOUNT" ...
#   else
#     echo "$OPS_GOG_NOTE"
#   fi
#
# Resolution order for the account:
#   1. $GOG_ACCOUNT / $GMAIL_ACCOUNT
#   2. .gmail_account in preferences.json
#   3. the account marked "default" by `gog auth list`
#   4. the only stored oauth account, if there is exactly one
#
# Resolution order for the keyring password (only when unset):
#   1. $GOG_KEYRING_PASSWORD
#   2. $OPS_GOG_ENV_FILE
#   3. $HOME/.config/claude-ops/gog.env
#   4. $HOME/.env-load.sh (sourced in a subshell, value exported back)
#
# No secret is ever printed; only the account address is echoed.

OPS_GOG_ACCOUNT=""
OPS_GOG_NOTE=""

_ops_gog_load_keyring_password() {
  [ -n "${GOG_KEYRING_PASSWORD:-}" ] && return 0

  local f
  for f in "${OPS_GOG_ENV_FILE:-}" "$HOME/.config/claude-ops/gog.env"; do
    [ -n "$f" ] && [ -r "$f" ] || continue
    # shellcheck disable=SC1090
    local v
    v=$(set -a; . "$f" >/dev/null 2>&1; printf '%s' "${GOG_KEYRING_PASSWORD:-}")
    if [ -n "$v" ]; then
      export GOG_KEYRING_PASSWORD="$v"
      return 0
    fi
  done

  if [ -r "$HOME/.env-load.sh" ]; then
    local v
    v=$(. "$HOME/.env-load.sh" >/dev/null 2>&1; printf '%s' "${GOG_KEYRING_PASSWORD:-}")
    if [ -n "$v" ]; then
      export GOG_KEYRING_PASSWORD="$v"
      return 0
    fi
  fi

  return 1
}

_ops_gog_resolve_account() {
  local acct="${GOG_ACCOUNT:-${GMAIL_ACCOUNT:-}}"

  if [ -z "$acct" ]; then
    local prefs="${PREFS_PATH:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
    if [ -r "$prefs" ] && command -v jq >/dev/null 2>&1; then
      acct=$(jq -r '.gmail_account // .channels.email.account // empty' "$prefs" 2>/dev/null)
    fi
  fi

  if [ -z "$acct" ]; then
    local list
    list=$(gog auth list 2>/dev/null) || list=""
    if [ -n "$list" ]; then
      acct=$(printf '%s\n' "$list" | awk -F'\t' '$2=="default"{print $1; exit}')
      if [ -z "$acct" ]; then
        local n
        n=$(printf '%s\n' "$list" | awk -F'\t' '$NF=="oauth"' | wc -l | tr -d ' ')
        [ "$n" = "1" ] && acct=$(printf '%s\n' "$list" | awk -F'\t' '$NF=="oauth"{print $1; exit}')
      fi
    fi
  fi

  printf '%s' "$acct"
}

# ops_gog_ready — 0 when gog can actually run a call, non-zero otherwise.
# Sets OPS_GOG_ACCOUNT on success, OPS_GOG_NOTE with the real reason on failure.
ops_gog_ready() {
  if ! command -v gog >/dev/null 2>&1; then
    OPS_GOG_NOTE="gog CLI not installed"
    return 1
  fi

  OPS_GOG_ACCOUNT=$(_ops_gog_resolve_account)
  if [ -z "$OPS_GOG_ACCOUNT" ]; then
    OPS_GOG_NOTE="no gog account — run: gog auth add <email> --services gmail,calendar"
    return 1
  fi

  _ops_gog_load_keyring_password || true

  local probe
  probe=$(gog gmail search -a "$OPS_GOG_ACCOUNT" -j --results-only --no-input --max 1 "in:inbox" 2>&1)
  case "$probe" in
    *"no TTY available"*|*GOG_KEYRING_PASSWORD*)
      OPS_GOG_NOTE="gog token store locked — set GOG_KEYRING_PASSWORD (or \$HOME/.config/claude-ops/gog.env)"
      return 1
      ;;
    *"missing --account"*)
      OPS_GOG_NOTE="gog rejected account '$OPS_GOG_ACCOUNT'"
      return 1
      ;;
    *"invalid_grant"*|*"token expired"*|*"unauthorized"*)
      OPS_GOG_NOTE="gog token for $OPS_GOG_ACCOUNT expired — re-run: gog auth add $OPS_GOG_ACCOUNT"
      return 1
      ;;
  esac

  return 0
}
