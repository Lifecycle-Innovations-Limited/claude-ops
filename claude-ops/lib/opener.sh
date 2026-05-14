#!/usr/bin/env bash
# opener.sh — Cross-OS URL / file / directory opener for claude-ops.
#
# Thin wrapper around os-detect.sh's `ops_opener` that actually spawns the
# resolved command and handles the edge cases each host platform cares about.
# Safe to source or invoke directly.
#
# Sourced usage:
#   source "$(dirname "$0")/../lib/opener.sh"
#   ops_open_url "https://example.com"
#
# CLI usage:
#   bash opener.sh url https://example.com
#   bash opener.sh dir /path/to/folder
#   bash opener.sh open anything
#
# Design notes:
#   - Never blocks: commands are spawned in the background with stdin/stdout
#     detached so OAuth prompts and browser launches don't hang the caller.
#   - Logs the resolved command to stderr for debuggability.
#   - Returns non-zero on missing opener or validation failures; callers can
#     decide whether that's fatal.

# ─── Re-source guard ────────────────────────────────────────────────────────
if [[ -n "${__OPS_OPENER_SH_LOADED__:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__OPS_OPENER_SH_LOADED__=1

# Only tighten shell options when run directly; preserve caller's env when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# ─── Pull in os-detect.sh (for ops_opener / ops_os) ─────────────────────────
if [[ -z "${__OPS_OS_DETECT_SH_LOADED__:-}" ]]; then
  # shellcheck source=./os-detect.sh
  source "$(dirname "${BASH_SOURCE[0]}")/os-detect.sh"
fi

# ─── __ops_open_log: stderr breadcrumb for debugging ────────────────────────
__ops_open_log() {
  printf 'opener: using %s for %s\n' "$1" "$2" >&2
}

# ─── __ops_is_remote_session: detect SSH / mobile / headless contexts ───────
# Returns 0 (true) when the caller is sitting at a TTY where `open URL` would
# launch a browser the user cannot see — typically Termius/iSH over SSH, a
# tmux pane on a remote host, or any explicit OPS_MOBILE/OPS_PRINT_URLS
# override. In those cases ops_open_url should print the URL instead of
# spawning the host's opener.
#
# Overrides:
#   OPS_PRINT_URLS=1  → always print
#   OPS_MOBILE=1      → always print (also shortens skill output elsewhere)
#   OPS_FORCE_OPEN=1  → always spawn opener (debugging / explicit local use)
__ops_is_remote_session() {
  [[ "${OPS_PRINT_URLS:-}" == "1" ]] && return 0
  [[ "${OPS_MOBILE:-}"     == "1" ]] && return 0
  [[ "${OPS_FORCE_OPEN:-}" == "1" ]] && return 1
  [[ -n "${SSH_CONNECTION:-}" || -n "${SSH_CLIENT:-}" || -n "${SSH_TTY:-}" ]] && return 0
  return 1
}

# ─── __ops_print_url: visible, copy-able URL block for SSH / mobile users ───
__ops_print_url() {
  local url="$1"
  printf '\n' >&2
  printf '  Open this URL on your device:\n' >&2
  printf '\n' >&2
  printf '  %s\n' "$url" >&2
  printf '\n' >&2
}

# ─── __ops_resolve_opener: pick a command, honoring os-detect first ─────────
# Echoes the full opener command string, or empty if none.
__ops_resolve_opener() {
  local cmd=""
  cmd="$(ops_opener 2>/dev/null || true)"
  if [[ -n "$cmd" ]]; then
    echo "$cmd"
    return 0
  fi
  # Hardcoded fallback cascade — first one that exists wins.
  if command -v open >/dev/null 2>&1;        then echo "open"; return 0; fi
  if command -v wslview >/dev/null 2>&1;     then echo "wslview"; return 0; fi
  if command -v xdg-open >/dev/null 2>&1;    then echo "xdg-open"; return 0; fi
  if command -v cmd.exe >/dev/null 2>&1;     then echo "cmd.exe /c start"; return 0; fi
  echo ""
  return 1
}

# ─── ops_open: open any target in the host's default handler ────────────────
# Usage: ops_open <target>
# Returns 0 on spawn success, 1 on any failure.
ops_open() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "opener: missing target" >&2
    return 1
  fi

  local cmd
  if ! cmd="$(__ops_resolve_opener)" || [[ -z "$cmd" ]]; then
    echo "opener: no URL opener available on this host" >&2
    return 1
  fi

  __ops_open_log "$cmd" "$target"

  # "cmd.exe /c start" needs a title placeholder so targets with spaces don't
  # get mis-parsed as the window title.
  if [[ "$cmd" == "cmd.exe /c start" ]]; then
    cmd.exe /c start "" "$target" >/dev/null 2>&1 &
    return 0
  fi

  # Split on whitespace to support multi-token commands. `exec`-less background.
  # shellcheck disable=SC2086
  $cmd "$target" >/dev/null 2>&1 &
  return 0
}

# ─── ops_open_url: URL-only variant with scheme validation ──────────────────
ops_open_url() {
  local url="${1:-}"
  if [[ -z "$url" ]]; then
    echo "opener: missing url" >&2
    return 1
  fi
  if [[ ! "$url" =~ ^https?://|^mailto:|^tel: ]]; then
    echo "opener: refusing to open non-URL scheme: $url" >&2
    return 1
  fi
  # On SSH/mobile sessions, `open URL` would launch a browser on the SSH
  # target instead of the user's device — print a copy-able block instead.
  if __ops_is_remote_session; then
    __ops_print_url "$url"
    return 0
  fi
  ops_open "$url"
}

# ─── ops_open_dir: directory-only variant with existence check ──────────────
ops_open_dir() {
  local dir="${1:-}"
  if [[ -z "$dir" ]]; then
    echo "opener: missing directory path" >&2
    return 1
  fi
  if [[ ! -e "$dir" ]]; then
    echo "opener: directory does not exist: $dir" >&2
    return 1
  fi
  if [[ ! -d "$dir" ]]; then
    echo "opener: not a directory: $dir" >&2
    return 1
  fi
  ops_open "$dir"
}

# ─── CLI entry ──────────────────────────────────────────────────────────────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    open)      shift; ops_open "$@" ;;
    url)       shift; ops_open_url "$@" ;;
    dir)       shift; ops_open_dir "$@" ;;
    *) echo "usage: opener.sh {open|url|dir} <target>" >&2; exit 2 ;;
  esac
fi
