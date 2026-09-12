#!/usr/bin/env bash
# Regression: the CALENDAR section must convert every event into ONE display
# zone before printing.
#
# The bug: the renderer printed the clock half of each timestamp verbatim, so an
# event stored with a +02:00 offset showed its +02:00 wall clock to a viewer
# four hours behind UTC. Two events almost six hours apart then rendered five
# minutes apart, inventing a conflict. Events already stored in the viewer's own
# zone rendered correctly, which is why it went unnoticed.
#
# All data below is synthetic and uses fixed-offset zones only, so the test
# gives the same answer on every machine and names nobody's location.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$PLUGIN_ROOT/bin/ops-dash"
LIB="$PLUGIN_ROOT/lib/calendar-tz.sh"

fail=0
note() { echo "FAIL: $*"; fail=1; }

[ -f "$LIB" ] || { echo "FAIL: missing lib/calendar-tz.sh"; exit 1; }
# shellcheck source=../lib/calendar-tz.sh
. "$LIB"

# Viewer sits four hours behind UTC. Etc/GMT+4 is that zone (POSIX inverts the
# sign) and is a fixed offset, so there is no DST ambiguity to argue about.
VIEWER="Etc/GMT+4"

# The conversion needs a zone database. On a stripped container there is none,
# and the helper then correctly falls back to the system zone — which would make
# the assertions below fail for a reason that is not the bug. Say so plainly
# instead of reporting a misleading wrong time.
if ! python3 -c 'from zoneinfo import ZoneInfo; ZoneInfo("Etc/GMT+4")' 2>/dev/null; then
  echo "SKIP: no zone database available; cannot assert cross-zone rendering"
  grep -Eq '\.start \| split\("T"\)' "$DASH" \
    && { echo "FAIL: ops-dash still prints a raw wall clock from the timestamp"; exit 1; }
  grep -Fq 'ops_calendar_rows' "$DASH" \
    || { echo "FAIL: ops-dash does not use ops_calendar_rows"; exit 1; }
  echo "PASS: structural checks only (zone database unavailable)"
  exit 0
fi

FIXTURE=$(cat <<'EOF'
{"configured":true,"events":[
 {"summary":"Sync A","calendar":"team-a@example.invalid","start":"2026-09-12T17:05:00+02:00","end":"2026-09-12T17:35:00+02:00","allday":false},
 {"summary":"Sync B","calendar":"team-b@example.invalid","start":"2026-09-12T17:00:00-04:00","end":"2026-09-12T17:30:00-04:00","allday":false},
 {"summary":"Offsite","calendar":"team-a@example.invalid","start":"2026-09-12","end":"2026-09-13","allday":true}
]}
EOF
)

rows=$(printf '%s' "$FIXTURE" | OPS_TZ="$VIEWER" ops_calendar_rows 8)

got_a=$(printf '%s\n' "$rows" | awk -F'\t' '$2=="Sync A"{print $1}')
got_b=$(printf '%s\n' "$rows" | awk -F'\t' '$2=="Sync B"{print $1}')
got_all=$(printf '%s\n' "$rows" | awk -F'\t' '$2=="Offsite"{print $1}')

# 17:05+02:00 is 15:05 UTC, which is 11:05 for this viewer.
[ "$got_a" = "11:05" ] || note "event stored at +02:00 rendered '$got_a', expected 11:05"
# Already in the viewer's zone: must survive the conversion untouched.
[ "$got_b" = "17:00" ] || note "event already in the viewer zone rendered '$got_b', expected 17:00"
# The false conflict: these two must not land minutes apart.
[ "$got_a" != "$got_b" ] || note "two distinct instants collapsed onto the same clock time"
# All-day has no instant. Converting it drags it onto an adjacent day.
[ "$got_all" = "ALLDAY" ] || note "all-day event rendered '$got_all', expected ALLDAY"

# Same fixture, a different display zone, must move the offset events and leave
# the all-day event alone.
rows_utc=$(printf '%s' "$FIXTURE" | OPS_TZ="Etc/UTC" ops_calendar_rows 8)
[ "$(printf '%s\n' "$rows_utc" | awk -F'\t' '$2=="Sync A"{print $1}')" = "15:05" ] \
  || note "display zone is not applied: +02:00 event did not render as 15:05 in UTC"
[ "$(printf '%s\n' "$rows_utc" | awk -F'\t' '$2=="Offsite"{print $1}')" = "ALLDAY" ] \
  || note "all-day event shifted when the display zone changed"

# A timestamp with no offset must not be shifted; we do not know its zone.
naive=$(printf '%s' '{"events":[{"summary":"Naive","calendar":"c@example.invalid","start":"2026-09-12T09:30:00","allday":false}]}' \
  | OPS_TZ="$VIEWER" ops_calendar_rows 8 | awk -F'\t' '{print $1}')
[ "$naive" = "09:30" ] || note "offset-less timestamp was shifted to '$naive', expected 09:30"

# Degenerate inputs must stay quiet rather than break the section.
for bad in '' '{}' '{"configured":true,"events":[]}' 'not json'; do
  out=$(printf '%s' "$bad" | OPS_TZ="$VIEWER" ops_calendar_rows 8 || true)
  [ -z "$out" ] || note "input '$bad' produced output: $out"
done

# The limit argument still caps the row count.
n=$(printf '%s' "$FIXTURE" | OPS_TZ="$VIEWER" ops_calendar_rows 2 | grep -c . || true)
[ "$n" = "2" ] || note "row limit not honoured: got $n rows for a limit of 2"

# The renderer must go through the helper, not slice the raw timestamp again.
if grep -Eq '\.start \| split\("T"\)' "$DASH"; then
  note "ops-dash still prints a raw wall clock from the timestamp"
fi
grep -Fq 'ops_calendar_rows' "$DASH" || note "ops-dash does not use ops_calendar_rows"

# The display zone is configuration, never a literal in the source.
grep -Fq 'OPS_TZ' "$LIB" || note "lib/calendar-tz.sh does not honour \$OPS_TZ"
grep -Fq 'preferences.json' "$LIB" || note "lib/calendar-tz.sh does not fall back to preferences.json"

[ "$fail" -eq 0 ]
echo "PASS: ops-dash calendar times render in one resolved display zone; all-day events unshifted"
