#!/usr/bin/env bash
# cloudflared-watchdog — self-heal when the tunnel has no usable ingress.
#
# Symptoms this catches (the boot-time empty-ingress outage):
#   cloudflared.service running and registered, but no ingress rules loaded
#   (boot-time race: cloudflared started before Cloudflare pushed the v2
#   dashboard config). cloudflared returns 503 for every request, but
#   systemd thinks it's healthy because the process is up.
#
# Strategy:
#   1. Read tunnel token from cloudflared.service to derive ACCOUNT + TUNNEL.
#   2. Fetch v2 dashboard config from Cloudflare API; count hostnames.
#   3. If hostnames > 0 AND the journal has 'No ingress rules' AFTER the
#      current cloudflared process start time → restart it.
#
# Requires /etc/cloudflared-watchdog.env with:
#   CLOUDFLARE_API_TOKEN=<token with Account:Tunnel:Read>

set -u
LOG_TAG='cloudflared-watchdog'
ENV_FILE='/etc/cloudflared-watchdog.env'
UNIT='/etc/systemd/system/cloudflared.service'

log() { logger -t "$LOG_TAG" -- "$*"; echo "[$LOG_TAG] $*" >&2; }

[[ -r $ENV_FILE ]] || { log "missing $ENV_FILE — exit 0"; exit 0; }
# shellcheck disable=SC1090
. $ENV_FILE
[[ -n ${CLOUDFLARE_API_TOKEN:-} ]] || { log 'CLOUDFLARE_API_TOKEN unset — exit 0'; exit 0; }

TOKEN_B64=$(grep -oE 'token [A-Za-z0-9+/=]+' $UNIT | head -1 | awk '{print $2}')
[[ -n $TOKEN_B64 ]] || { log 'no tunnel token in unit — exit 0'; exit 0; }

DECODED=$(echo "$TOKEN_B64" | base64 -d 2>/dev/null || true)
ACCOUNT=$(echo "$DECODED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["a"])' 2>/dev/null || true)
TUNNEL=$(echo "$DECODED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["t"])' 2>/dev/null || true)
[[ -n $ACCOUNT && -n $TUNNEL ]] || { log 'token decode failed — exit 0'; exit 0; }

CONFIG_JSON=$(curl -sf -m 10 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/configurations" 2>/dev/null || true)
[[ -n $CONFIG_JSON ]] || { log 'cloudflare api unreachable — exit 0'; exit 0; }

HOSTNAME_COUNT=$(echo "$CONFIG_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    ing = d.get("result", {}).get("config", {}).get("ingress", [])
    print(sum(1 for r in ing if r.get("hostname")))
except Exception:
    print(0)
' 2>/dev/null || echo 0)

if [[ $HOSTNAME_COUNT -lt 1 ]]; then
  log "dashboard config has zero hostnames — nothing to enforce"
  exit 0
fi

# Get the cloudflared process start timestamp (ExecMainStartTimestamp).
# Only count 'No ingress rules' warnings that appear AFTER this — older
# warnings refer to a previous run we already self-healed from.
START_TS=$(systemctl show cloudflared -p ExecMainStartTimestamp --value 2>/dev/null)
if [[ -z $START_TS || $START_TS == 'n/a' ]]; then
  log 'cloudflared not running according to systemd — exit 0'
  exit 0
fi

NO_INGRESS_RECENT=$(journalctl -u cloudflared --since "$START_TS" --no-pager 2>/dev/null \
  | grep -c 'No ingress rules were defined' || true)

if [[ $NO_INGRESS_RECENT -gt 0 ]]; then
  log "empty-ingress state in current run (hostnames=$HOSTNAME_COUNT, started=$START_TS) — restarting cloudflared"
  systemctl restart cloudflared
  exit 0
fi

log "ok: hostnames=$HOSTNAME_COUNT, current run is clean"
exit 0
