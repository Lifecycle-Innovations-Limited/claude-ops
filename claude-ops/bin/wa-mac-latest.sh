#!/usr/bin/env bash
# wa-mac-latest.sh — Fallback WhatsApp reader.
# Reads the Mac WhatsApp.app local store (ChatStorage.sqlite, unencrypted) over
# Tailscale SSH as ground truth when the whatsmeow bridge's sync lags or misses
# inbound messages (esp. @lid chats). Read-only.
#
# Usage:
#   wa-mac-latest.sh --recent [N]              latest N messages across ALL chats (default 15)
#   wa-mac-latest.sh --contact <q> [N]         latest N for a contact by name or number (default 12)
#   wa-mac-latest.sh --since "YYYY-MM-DD HH:MM" all messages since a local timestamp
#   add --json for machine-readable output
# Env: WA_MAC_SSH (direct/Tailscale target) and/or WA_MAC_CF_HOST (cloudflared
#      SSH hostname fallback) — resolved via wa-mac-transport.sh, Tailscale first.
set -euo pipefail
# shellcheck source=wa-mac-transport.sh
. "$(dirname "${BASH_SOURCE[0]}")/wa-mac-transport.sh" 2>/dev/null || . "$HOME/bin/wa-mac-transport.sh"
DB='$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite'
AE=978307200
JSON=0; MODE="recent"; ARG=""; N=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --recent) MODE="recent" ;;
    --contact) MODE="contact"; ARG="${2:-}"; shift ;;
    --since) MODE="since"; ARG="${2:-}"; shift ;;
    *) N="$1" ;;
  esac; shift
done
case "$MODE" in recent) LIMIT="${N:-15}";; contact) LIMIT="${N:-12}";; *) LIMIT="" ;; esac
dt="datetime(ZMESSAGEDATE+$AE,'unixepoch','localtime')"
case "$MODE" in
  recent)  SQL="SELECT $dt,m.ZISFROMME,s.ZPARTNERNAME,substr(m.ZTEXT,1,160) FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION=s.Z_PK WHERE m.ZTEXT IS NOT NULL ORDER BY m.ZMESSAGEDATE DESC LIMIT $LIMIT;" ;;
  contact) q=$(printf '%s' "$ARG"|sed "s/'/''/g"); SQL="SELECT $dt,m.ZISFROMME,s.ZPARTNERNAME,substr(m.ZTEXT,1,200) FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION=s.Z_PK WHERE (s.ZPARTNERNAME LIKE '%$q%' OR s.ZCONTACTJID LIKE '%$q%') AND m.ZTEXT IS NOT NULL ORDER BY m.ZMESSAGEDATE DESC LIMIT $LIMIT;" ;;
  since)   ts=$(printf '%s' "$ARG"|sed "s/'/''/g"); SQL="SELECT $dt,m.ZISFROMME,s.ZPARTNERNAME,substr(m.ZTEXT,1,160) FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION=s.Z_PK WHERE m.ZTEXT IS NOT NULL AND $dt >= '$ts' ORDER BY m.ZMESSAGEDATE DESC;" ;;
esac
wa_mac_resolve || { echo "ERROR: Mac unreachable over tailscale AND cloudflare — cannot read WhatsApp ground truth" >&2; exit 2; }
raw=$(timeout 35 ssh "${WA_MAC_SSH_ARGS[@]}" "sqlite3 -separator $'\x1f' \"$DB\" \"$SQL\"" 2>&1) || { echo "ERROR: could not read Mac WhatsApp DB (transport=$WA_MAC_TRANSPORT). $raw" >&2; exit 2; }
[ "${WA_MAC_QUIET:-0}" = 1 ] || echo "wa-mac: transport=$WA_MAC_TRANSPORT" >&2
if [ "$JSON" = 1 ]; then
  printf '%s\n' "$raw" | python3 -c 'import sys,json;US="\x1f";o=[]
for l in sys.stdin:
 l=l.rstrip("\n")
 if not l:continue
 p=l.split(US)
 if len(p)<4:continue
 o.append({"date":p[0],"from_me":p[1]=="1","who":p[2],"text":p[3]})
print(json.dumps(o,ensure_ascii=False,indent=2))'
else
  printf '%s\n' "$raw" | python3 -c 'import sys
US="\x1f"
for l in sys.stdin:
 l=l.rstrip("\n")
 if not l:continue
 p=l.split(US)
 if len(p)<4:continue
 d="→ me " if p[1]=="1" else "← them"
 print(f"{p[0]}  {d}  [{p[2]}]  {p[3]}")'
fi
