#!/usr/bin/env bash
# lib/calendar-tz.sh — resolve the dashboard display zone and localize calendar
# event times into it.
#
# Why this exists: calendar feeds return each event in the zone of the calendar
# that owns it, so a single day's events arrive as a mix of offsets. Printing
# the raw clock half of the timestamp renders every event as if the viewer were
# standing in that calendar's zone, which makes unrelated events look adjacent.
# Every time must be moved to ONE display zone before it is printed.
#
# Sourcing convention (after lib/registry-path.sh, which exports OPS_DATA_DIR):
#   . "${PLUGIN_ROOT}/lib/calendar-tz.sh"
#
# Exports:
#   ops_display_tz       — echo the zone to render in. Resolution order:
#                            1. $OPS_TZ
#                            2. .timezone in $OPS_DATA_DIR/preferences.json
#                            3. "" — meaning the system zone
#                          Never a literal zone name: the operator's location is
#                          configuration, not source.
#   ops_calendar_rows N  — read dashboard calendar JSON on stdin, write at most N
#                          TSV rows "<time>\t<summary>\t<calendar>" on stdout,
#                          where <time> is HH:MM in the display zone, or the
#                          literal ALLDAY for an all-day event.

ops_display_tz() {
  local tz prefs
  tz="${OPS_TZ:-}"
  if [ -z "$tz" ]; then
    prefs="${OPS_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}}/preferences.json"
    if [ -f "$prefs" ] && command -v jq >/dev/null 2>&1; then
      tz="$(jq -r '.timezone // ""' "$prefs" 2>/dev/null || printf '')"
      [ "$tz" = "null" ] && tz=""
    fi
  fi
  printf '%s' "$tz"
}

# Fallback used only when python3 is unavailable: previous behaviour, raw clock.
# It is wrong across zones, but it is better than an empty CALENDAR section, and
# it is never reached on a machine that has python3.
_ops_calendar_rows_raw() {
  local limit="$1"
  jq -r --argjson n "$limit" '.events[0:$n][] |
    if .allday then
      "ALLDAY\t\(.summary)\t\(.calendar)"
    else
      "\(.start | split("T")[1] // "" | .[0:5])\t\(.summary)\t\(.calendar)"
    end' 2>/dev/null || true
}

ops_calendar_rows() {
  local limit="${1:-8}" tz
  tz="$(ops_display_tz)"

  if ! command -v python3 >/dev/null 2>&1; then
    _ops_calendar_rows_raw "$limit"
    return 0
  fi

  python3 -c '
import json, sys

from datetime import datetime

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - very old interpreters
    ZoneInfo = None

limit = int(sys.argv[1])
tzname = sys.argv[2]

target = None
if tzname and ZoneInfo is not None:
    try:
        target = ZoneInfo(tzname)
    except Exception:
        # An unusable configured zone must not blank the section; fall through
        # to the system zone, which is still one consistent zone.
        target = None


def localize(value):
    """HH:MM in the display zone. Never invents an offset it was not given."""
    if not value or "T" not in value:
        return ""
    wall = value.split("T", 1)[1][:5]
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return wall
    if stamp.tzinfo is None:
        # No offset in the feed means we do not know which zone this clock is
        # in. Shifting it would be a guess, so print it unchanged.
        return wall
    stamp = stamp.astimezone(target) if target is not None else stamp.astimezone()
    return stamp.strftime("%H:%M")


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

events = data.get("events") or []
out = []
for event in events[:limit]:
    summary = str(event.get("summary") or "(no title)")
    calendar = str(event.get("calendar") or "")
    if event.get("allday"):
        # An all-day event has no instant, only a date. Converting it is the
        # classic regression: it drags the event onto the previous or next day
        # for any viewer west or east of the calendar. Pass it through.
        when = "ALLDAY"
    else:
        when = localize(str(event.get("start") or ""))
    out.append("\t".join(part.replace("\t", " ").replace("\n", " ")
                         for part in (when, summary, calendar)))

sys.stdout.write("".join(line + "\n" for line in out))
' "$limit" "$tz" 2>/dev/null || true
}
