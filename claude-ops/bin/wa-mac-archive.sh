#!/usr/bin/env bash
# wa-mac-archive.sh — Tier-4 WhatsApp archive fallback via the Mac WhatsApp.app.
#
# When the whatsmeow bridge cannot archive (app-state 429 rate-overlimit, LTHash
# wedge that resync can't heal), this script archives chats through the REAL
# WhatsApp.app on the owner's Mac via AppleScript UI automation over SSH.
# Because the Mac app is a first-class WhatsApp client, its archive mutations
# sync server-side to the phone AND propagate back to the bridge — no bridge
# app-state writes needed, so the 429 path is bypassed entirely.
#
# SCOPE GUARD: this script can ONLY archive. It never sends, deletes, or mutates
# anything else. Outbound sends remain on the bridge under the Rule-6 gate.
#
# Usage:
#   wa-mac-archive.sh --contact "<name or number>"        archive one chat
#   wa-mac-archive.sh --jid <pn@s.whatsapp.net>           archive one chat by JID
#   wa-mac-archive.sh --batch <file>                      one JID-or-name per line
#   add --dry-run to resolve + report without touching the UI
#   add --force   to bypass the owner-idle gate (USE SPARINGLY — takes over the screen)
#
# OWNER-IDLE GATE: UI automation drives the visible WhatsApp.app, stealing focus
# from whoever is at the Mac. By default this script REFUSES to run unless the
# Mac's HID input has been idle ≥ WA_MAC_IDLE_MIN seconds (default 600). It also
# restores the previously-frontmost app when done.
#
# Transport: wa-mac-transport.sh (Tailscale first, Cloudflare tunnel fallback).
# Env: WA_MAC_SSH / WA_MAC_CF_HOST (see wa-mac-transport.sh), WA_MAC_PACE (s,
#      default 4), WA_MAC_IDLE_MIN (s, default 600)
set -euo pipefail
# shellcheck source=wa-mac-transport.sh
. "$(dirname "${BASH_SOURCE[0]}")/wa-mac-transport.sh" 2>/dev/null || . "$HOME/bin/wa-mac-transport.sh"

DB='$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite'
PACE="${WA_MAC_PACE:-4}"
IDLE_MIN="${WA_MAC_IDLE_MIN:-600}"
DRY=0; FORCE=0; TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --contact|--jid) TARGETS+=("${2:?}"); shift ;;
    --batch) while IFS= read -r l; do [ -n "$l" ] && TARGETS+=("$l"); done < "${2:?}"; shift ;;
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac; shift
done
[ ${#TARGETS[@]} -gt 0 ] || { echo "no targets — use --contact/--jid/--batch" >&2; exit 64; }

wa_mac_resolve || { echo "wa-mac-archive: Mac unreachable (tailscale + cloudflare)" >&2; exit 7; }
echo "wa-mac-archive: transport=$WA_MAC_TRANSPORT, targets=${#TARGETS[@]}, pace=${PACE}s"

# Owner-idle gate — never steal the screen from an active user.
idle_secs() {
  wa_mac_ssh "ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print int(\$NF/1000000000); exit}'" 2>/dev/null || echo 0
}
check_idle_gate() {
  [ "$DRY" = 0 ] && [ "$FORCE" = 0 ] || return 0
  idle=$(idle_secs); idle="${idle:-0}"
  if [ "$idle" -lt "$IDLE_MIN" ]; then
    echo "wa-mac-archive: REFUSED — owner active at the Mac (idle ${idle}s < ${IDLE_MIN}s)." >&2
    echo "wa-mac-archive: retry when idle, lower WA_MAC_IDLE_MIN, or pass --force (visible takeover)." >&2
    exit 75
  fi
  echo "wa-mac-archive: idle gate passed (owner idle ${idle}s)"
}

# AppleScript runner: opens the chat via in-app search, then clicks the menu-bar
# item whose name contains "Archive" (locale-robust: NL "Archiveer" also matches
# via the fallback list). Runs inside the Aqua session via launchctl asuser.
run_archive_ui() { # $1 = partner display name
  local name="$1"
  # The UI automation runs REMOTELY on the Mac — require the remote host to be
  # Darwin before driving it (also satisfies the macOS-only-tool lint guard).
  if [ "${WA_MAC_REMOTE_OS:=$(wa_mac_ssh uname 2>/dev/null)}" = "Darwin" ]; then
  wa_mac_ssh 'cat > /tmp/wa_archive.scpt && UID_N=$(id -u) && sudo -n launchctl asuser "$UID_N" sudo -u "$(whoami)" osascript /tmp/wa_archive.scpt' <<EOF
on run
  set chatName to "$(printf '%s' "$name" | sed 's/"/\\"/g')"
  -- remember the user's frontmost app so we can hand focus straight back
  tell application "System Events"
    set prevApp to name of first process whose frontmost is true
  end tell
  set archived to false
  try
    tell application "WhatsApp" to activate
    delay 1.2
    tell application "System Events"
      tell process "WhatsApp"
        keystroke "f" using {command down}
        delay 0.6
        keystroke chatName
        delay 1.4
        key code 125 -- down: first search result
        delay 0.4
        key code 36  -- return: open chat
        delay 1.0
        -- click the "Archive chat" menu item — EXACT-prefix match per locale,
        -- and never an item that merely contains "Archive" (e.g. the "Archived"
        -- folder navigation item, which the v1 matcher hit by mistake).
        repeat with mb in menu bar items of menu bar 1
          try
            repeat with mi in menu items of menu 1 of mb
              set t to (name of mi as text)
              ignoring case
                if (t starts with "Archive chat") or (t starts with "Archiveer chat") or (t starts with "Chat archivieren") then
                  click mi
                  set archived to true
                  exit repeat
                end if
              end ignoring
            end repeat
          end try
          if archived then exit repeat
        end repeat
        key code 53 -- esc: clear search state
      end tell
    end tell
  on error errMsg number errNum
    try
      if prevApp is not "WhatsApp" then tell application prevApp to activate
    end try
    error errMsg number errNum
  end try
  -- restore whatever the user had frontmost
  try
    if prevApp is not "WhatsApp" then tell application prevApp to activate
  end try
  if not archived then error "no 'Archive chat' menu item found for " & chatName
end run
EOF
  else
    echo "remote host is not Darwin — refusing UI automation" >&2
    return 1
  fi
}

check_idle_gate

ok=0; fail=0; skip=0
for t in "${TARGETS[@]}"; do
  q=$(printf '%s' "$t" | sed "s/'/''/g")
  row=$(wa_mac_ssh "sqlite3 -separator $'\x1f' \"$DB\" \"SELECT ZPARTNERNAME, COALESCE(ZARCHIVED,0) FROM ZWACHATSESSION WHERE ZCONTACTJID='$q' OR ZPARTNERNAME LIKE '%$q%' ORDER BY ZLASTMESSAGEDATE DESC LIMIT 1;\"" 2>/dev/null || true)
  name="${row%%$'\x1f'*}"; arch="${row##*$'\x1f'}"
  if [ -z "$name" ]; then echo "  MISS  $t (no Mac chat found)"; fail=$((fail+1)); continue; fi
  if [ "$arch" = "1" ]; then echo "  SKIP  $name (already archived on Mac)"; skip=$((skip+1)); continue; fi
  if [ "$DRY" = 1 ]; then echo "  DRY   $name"; ok=$((ok+1)); continue; fi
  ui_err=""
  if ui_err=$(run_archive_ui "$name" 2>&1 >/dev/null); then
    sleep 1
    v=$(wa_mac_ssh "sqlite3 \"$DB\" \"SELECT COALESCE(ZARCHIVED,0) FROM ZWACHATSESSION WHERE ZPARTNERNAME='$(printf '%s' "$name" | sed "s/'/''/g")' ORDER BY ZLASTMESSAGEDATE DESC LIMIT 1;\"" 2>/dev/null || echo "?")
    if [ "$v" = "1" ]; then echo "  OK    $name (verified ZARCHIVED=1)"; else echo "  OK?   $name (UI action done, ZARCHIVED=$v — verify visually)"; fi
    ok=$((ok+1))
  else
    if [ -n "$ui_err" ]; then
      echo "  FAIL  $name ($ui_err)"
    else
      echo "  FAIL  $name (remote AppleScript error — check Accessibility permission for sshd on the Mac)"
    fi
    fail=$((fail+1))
  fi
  sleep "$PACE"
done
echo "wa-mac-archive: done — ok=$ok skip=$skip fail=$fail"
[ "$fail" -eq 0 ]
