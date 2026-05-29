#!/usr/bin/env bash
# icloud-reminder.sh "<summary>" ["<notes>"] ["<due YYYY-MM-DD>"] ["<stable-uid-seed>"]
# Pushes a VTODO to iCloud Reminders via CalDAV.
# Requires EMAIL_COS_ICLOUD_ENABLE=true and:
#   ICLOUD_APPLE_ID  — Apple ID email (from env / ~/.mcp-secrets.env)
#   ICLOUD_APP_PW    — App-specific password (NOT the main Apple password)
#   EMAIL_COS_ICLOUD_LIST_URL — CalDAV URL of the target Reminders list
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

if [ "${EMAIL_COS_ICLOUD_ENABLE:-false}" != "true" ]; then
  echo "icloud-reminder: iCloud channel disabled (EMAIL_COS_ICLOUD_ENABLE != true)" >&2
  exit 0
fi
if [ -z "${ICLOUD_APPLE_ID:-}" ] || [ -z "${ICLOUD_APP_PW:-}" ]; then
  echo "icloud-reminder: ICLOUD_APPLE_ID / ICLOUD_APP_PW not set" >&2
  exit 1
fi
if [ -z "${EMAIL_COS_ICLOUD_LIST_URL:-}" ]; then
  echo "icloud-reminder: EMAIL_COS_ICLOUD_LIST_URL not configured" >&2
  exit 1
fi

SUMMARY="${1:?summary required}"
NOTES="${2:-}"
DUE="${3:-}"
SEED="${4:-$SUMMARY}"

LIST="$EMAIL_COS_ICLOUD_LIST_URL"
TUID="cc-$(printf '%s' "$SEED" | sha1sum | cut -c1-24)"

DUE_LINE=""
[ -n "$DUE" ] && DUE_LINE="DUE;VALUE=DATE:$(printf '%s' "$DUE" | tr -d '-')"

# Escape ICS special chars in text fields.
esc(){ printf '%s' "$1" | sed 's/\\/\\\\/g; s/;/\\;/g; s/,/\\,/g' | tr '\n' ' '; }

ICS="BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ClaudeCode//email-chief-of-staff//EN
BEGIN:VTODO
UID:${TUID}
SUMMARY:$(esc "$SUMMARY")
DESCRIPTION:$(esc "$NOTES")${DUE_LINE:+$'\n'"$DUE_LINE"}
PRIORITY:5
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR"

code=$(curl -s -o /dev/null -w "%{http_code}" -L \
  -u "${ICLOUD_APPLE_ID}:${ICLOUD_APP_PW}" -X PUT \
  "${LIST}/${TUID}.ics" -H "Content-Type: text/calendar; charset=utf-8" \
  --data "$ICS")
case "$code" in
  201|204) echo "reminder ok ($code): $SUMMARY" ;;
  *) echo "reminder FAILED ($code): $SUMMARY" >&2; exit 1 ;;
esac
