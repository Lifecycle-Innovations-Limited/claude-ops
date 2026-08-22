#!/usr/bin/env bash
# grok-reauth-egress.sh — pick residential egress for Grok device OAuth.
# Order: caller env → EFG SOCKS → Bright Data residential → ISP → mobile → SOCKS fallback.
# Source before grok-oauth-reauth. Never prints credential values.
set -euo pipefail

log() { echo "[grok-reauth-egress] $*" >&2; }

if [[ -n "${GROK_REAUTH_HTTP_PROXY:-}" || -n "${GROK_REAUTH_SOCKS:-}" ]]; then
  log "using caller-provided proxy env"
  return 0 2>/dev/null || exit 0
fi

# 1) Local SOCKS (EFG / residential tunnel)
for port in "${GROK_REAUTH_SOCKS_PORT:-1089}" 1089 1087; do
  if timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
      --proxy "socks5h://127.0.0.1:${port}" https://accounts.x.ai/ 2>/dev/null || echo 000)"
    if [[ "$code" != "000" && "$code" != "403" ]]; then
      export GROK_REAUTH_SOCKS="socks5://127.0.0.1:${port}"
      log "selected local SOCKS port=${port} (http ${code})"
      return 0 2>/dev/null || exit 0
    fi
    log "local SOCKS port=${port} http=${code}"
  fi
done

# 2) Bright Data HTTP proxy tiers via curl --proxy-user (no password in URL literals)
probe_brd_tier() {
  local tier="$1" zone="$2"
  local uid host port sess user code
  # password material only from env at probe time — never echoed
  local -a pass_keys
  case "$tier" in
    residential) pass_keys=(BRIGHT_DATA_RESIDENTIAL_PROXY_PASSWORD BRIGHT_DATA_PROXY_PASSWORD BRIGHT_DATA_PASS BRIGHT_DATA_TOKEN) ;;
    isp) pass_keys=(BRIGHT_DATA_ISP_PROXY_PASSWORD BRIGHT_DATA_PROXY_PASSWORD BRIGHT_DATA_PASS BRIGHT_DATA_TOKEN) ;;
    mobile) pass_keys=(BRIGHT_DATA_MOBILE_PROXY_PASSWORD BRIGHT_DATA_MOBILE_PASSWORD BRIGHT_DATA_PASS BRIGHT_DATA_TOKEN) ;;
    *) return 1 ;;
  esac
  local pass=""
  local k
  for k in "${pass_keys[@]}"; do
    if [[ -n "${!k:-}" ]]; then pass="${!k}"; break; fi
  done
  uid="${BRIGHT_DATA_USERID:-${BRIGHT_DATA_CUSTOMER:-${BRIGHT_DATA_USER:-}}}"
  host="${BRIGHT_DATA_PROXY_HOST:-brd.superproxy.io}"
  port="${BRIGHT_DATA_PROXY_PORT:-44445}"
  [[ -n "$uid" && -n "$zone" && -n "$pass" ]] || return 1
  sess="gr$(date +%s | tail -c 6)${tier:0:1}"
  user="brd-customer-${uid}-zone-${zone}-country-nl-session-${sess}"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    --proxy "http://${host}:${port}" \
    --proxy-user "${user}:${pass}" \
    https://accounts.x.ai/ 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then
    # Export for Playwright-style consumers (username/password split preferred)
    export GROK_REAUTH_HTTP_PROXY_HOST="${host}"
    export GROK_REAUTH_HTTP_PROXY_PORT="${port}"
    export GROK_REAUTH_HTTP_PROXY_USER="${user}"
    export GROK_REAUTH_HTTP_PROXY_PASS="${pass}"
    # Combined form for tools that only accept one URL (not logged)
    export GROK_REAUTH_HTTP_PROXY="http://${user}:${pass}@${host}:${port}"
    log "selected Bright Data tier=${tier} zone=${zone} (http ${code})"
    return 0
  fi
  log "Bright Data tier=${tier} zone=${zone} http=${code}"
  return 1
}

Z_RES="${BRIGHT_DATA_RESIDENTIAL_PROXY_ZONE:-${BRIGHT_DATA_RESIDENTIAL_ZONE:-${BRIGHT_DATA_ZONE:-}}}"
Z_ISP="${BRIGHT_DATA_ISP_PROXY_ZONE:-${BRIGHT_DATA_ISP_ZONE:-}}"
Z_MOB="${BRIGHT_DATA_MOBILE_PROXY_ZONE:-${BRIGHT_DATA_MOBILE_ZONE:-}}"

if [[ -n "$Z_RES" ]] && probe_brd_tier residential "$Z_RES"; then
  return 0 2>/dev/null || exit 0
fi
if [[ -n "$Z_ISP" ]] && probe_brd_tier isp "$Z_ISP"; then
  return 0 2>/dev/null || exit 0
fi
if [[ -n "$Z_MOB" ]] && probe_brd_tier mobile "$Z_MOB"; then
  return 0 2>/dev/null || exit 0
fi

# 3) Last resort SOCKS even if previously 403 (browser may pass CF)
if timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/1089" 2>/dev/null; then
  export GROK_REAUTH_SOCKS="socks5://127.0.0.1:1089"
  log "fallback local SOCKS port=1089 (may hit CF)"
  return 0 2>/dev/null || exit 0
fi

log "no egress selected — reauth may use tool defaults"
return 0 2>/dev/null || exit 0
