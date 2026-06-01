#!/usr/bin/env bash
# wa-bridge-keepalive.sh — keep the whatsmeow whatsapp-bridge ONLINE so phone-originated
# own-sends always sync. systemd Restart=always catches CRASHES; this catches HANGS
# (process alive, websocket dead) which would silently drop every incoming message —
# including your own phone sends, which whatsmeow CANNOT re-fetch once missed.
#
# Liveness = a real HTTP probe of the bridge REST port. NOT `ss | grep :8080` — ss renders
# port 8080 as the service name "webcache", so that grep never matches and would false-restart
# a perfectly healthy bridge (documented ops-inbox footgun). curl treats HTTP 404 as success
# (connection worked); only connection-refused / timeout counts as down.
set -uo pipefail

# single-instance + 50s throttle (timer fires every 60s; never stack)
if [ -r "$HOME/.claude/scripts/lib/once.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.claude/scripts/lib/once.sh"
  claude_once wa-bridge-keepalive 50 || exit 0
fi

PROBE="${WA_BRIDGE_PROBE:-http://127.0.0.1:8080/}"
UNIT="whatsapp-bridge.service"

probe() { curl -s -o /dev/null -m 4 "$PROBE" 2>/dev/null; }

# two probes 3s apart — tolerate a single transient blip
if probe; then exit 0; fi
sleep 3
if probe; then exit 0; fi

# Don't fight systemd if it's already mid-(re)start (crash path owned by Restart=always)
state=$(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null || echo unknown)
if [ "$state" = "activating" ]; then exit 0; fi

# Shared cross-caller restart floor — same stamp file claude_once uses for the key
# "whatsapp-bridge-restart" (wa-inbox-fresh.sh writes it). Read/write the stamp
# DIRECTLY here: a 2nd claude_once call would clobber the self-throttle's EXIT trap
# (bash allows one EXIT trap) and orphan wa-bridge-keepalive.lock, self-disabling the
# watchdog until the 60-min stale-reclaim. A stamp-only floor auto-expires at 180s and
# can never self-block, which is what keepalive needs. One restart / 180s across this
# script + wa-inbox-fresh.sh + whatsapp-bridge-up.sh.
FLOOR_STAMP="$HOME/.claude/.once.whatsapp-bridge-restart.last"
if [ -f "$FLOOR_STAMP" ]; then
  last=$(cat "$FLOOR_STAMP" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - ${last:-0} )) -lt 180 ]; then
    logger -t wa-bridge-keepalive 'restart floor active (<180s) — skip'
    exit 0
  fi
fi
logger -t wa-bridge-keepalive "bridge unresponsive on $PROBE (state=$state) — restarting $UNIT"
systemctl --user restart "$UNIT"
date +%s > "$FLOOR_STAMP" 2>/dev/null
