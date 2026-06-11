#!/usr/bin/env bash
# wa-mac-transport.sh — shared transport resolver for reaching the owner's Mac
# (the machine running WhatsApp.app, used as ground-truth fallback by
# wa-mac-latest.sh and wa-mac-archive.sh).
#
# Resolves a working SSH transport in priority order:
#   1. Tailscale / direct SSH   (WA_MAC_SSH, e.g. user@100.x.y.z)
#   2. Cloudflare tunnel SSH    (WA_MAC_CF_HOST, e.g. ssh-mac.example.com,
#      via `cloudflared access ssh` ProxyCommand — works when Tailscale is down)
#
# Source this file, then call:
#   wa_mac_resolve            # sets WA_MAC_TRANSPORT (tailscale|cloudflare|none)
#                             # and fills WA_MAC_SSH_ARGS array; rc 1 if none work
#   wa_mac_ssh <cmd...>       # run a command on the Mac over the resolved transport
#
# Env (no committed defaults — set these in your shell profile, never here):
#   WA_MAC_SSH       direct ssh target, user@host           (transport 1)
#   WA_MAC_CF_HOST   cloudflared SSH hostname                (transport 2, optional)
#   WA_MAC_CF_USER   ssh user for the CF path (default: user part of WA_MAC_SSH)
#   WA_MAC_SSH_OPTS  extra ssh options (optional)

WA_MAC_TS_TARGET="${WA_MAC_SSH:-}"
WA_MAC_CF_HOST="${WA_MAC_CF_HOST:-}"
WA_MAC_CF_USER="${WA_MAC_CF_USER:-${WA_MAC_TS_TARGET%%@*}}"
WA_MAC_TRANSPORT="none"
WA_MAC_SSH_ARGS=()

_wa_mac_common_opts=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)

wa_mac_resolve() {
  # 1. Tailscale / direct SSH
  if [ -n "$WA_MAC_TS_TARGET" ] && \
     ssh "${_wa_mac_common_opts[@]}" ${WA_MAC_SSH_OPTS:-} "$WA_MAC_TS_TARGET" true 2>/dev/null; then
    WA_MAC_TRANSPORT="tailscale"
    WA_MAC_SSH_ARGS=("${_wa_mac_common_opts[@]}" "$WA_MAC_TS_TARGET")
    return 0
  fi
  # 2. Cloudflare tunnel SSH (cloudflared access ssh)
  if [ -n "$WA_MAC_CF_HOST" ] && [ -n "$WA_MAC_CF_USER" ] && command -v cloudflared >/dev/null 2>&1; then
    local proxy="cloudflared access ssh --hostname $WA_MAC_CF_HOST"
    if ssh "${_wa_mac_common_opts[@]}" -o ProxyCommand="$proxy" \
         ${WA_MAC_SSH_OPTS:-} "${WA_MAC_CF_USER}@${WA_MAC_CF_HOST}" true 2>/dev/null; then
      WA_MAC_TRANSPORT="cloudflare"
      WA_MAC_SSH_ARGS=("${_wa_mac_common_opts[@]}" -o ProxyCommand="$proxy" "${WA_MAC_CF_USER}@${WA_MAC_CF_HOST}")
      return 0
    fi
  fi
  WA_MAC_TRANSPORT="none"
  WA_MAC_SSH_ARGS=()
  return 1
}

wa_mac_ssh() {
  if [ "$WA_MAC_TRANSPORT" = "none" ] || [ ${#WA_MAC_SSH_ARGS[@]} -eq 0 ]; then
    wa_mac_resolve || { echo "wa-mac: Mac unreachable (tailscale + cloudflare both down/unconfigured)" >&2; return 7; }
  fi
  ssh "${WA_MAC_SSH_ARGS[@]}" "$@"
}
