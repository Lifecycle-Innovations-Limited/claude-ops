#!/usr/bin/env bash
# windsor-data-sanity.sh — detect the Windsor.ai "all-zero" pattern (expired plan / blocked reads).
#
# When a Windsor.ai subscription lapses (`get_current_user` → `is_paid: false`),
# reads keep "working" but silently return only zeros / empty rows. Dashboards and
# blended-ROAS math then report zeros as if they were real data. This script sums
# a set of numeric fields from a Windsor JSON payload (REST response or cache
# file) and warns when they are ALL exactly zero.
#
# Usage:
#   windsor-data-sanity.sh [FILE] [PATHS]
#
#   FILE   JSON file to inspect (a Windsor cache or REST response).
#          Use "-" or omit to read from stdin.
#   PATHS  Comma-separated jq paths to sum. Default recursively sums every
#          `spend`, `impressions`, and `reach` field, which covers the
#          facebook (Meta) + google_ads spend/impressions and instagram reach
#          signals used for expired-plan detection.
#
# Besides the all-zero sum, it also detects Windsor's quota/plan-limit text
# pattern: when the plan is expired/over limit, the API can return HTTP 200
# with a text row inside the data, e.g.
#   {"data":[{"source":"Uh-oh! You've reached your plan limit... Upgrade here..."}]}
# so `has("data")` checks "succeed" while the payload is garbage.
#
# Output / exit codes:
#   ok                                                             exit 0  (real signal present)
#   warn: windsor quota/plan-limit message detected (plan expired?) exit 1  (quota text row)
#   warn: windsor all-zero pattern (plan expired?)                 exit 1  (all-zero or empty)
#   error: ...                                                     exit 2  (bad input / usage)
#
# Examples:
#   windsor-data-sanity.sh ~/.claude/cache/windsor-30d.json
#   curl -s "$WINDSOR_URL" | windsor-data-sanity.sh
#   windsor-data-sanity.sh cache.json '.data[].spend,.data[].impressions'
#
# See docs/integrations/windsor-ai.md → "Data sanity / expired-plan detection".
set -euo pipefail

FILE="${1:--}"
PATHS="${2:-..|.spend?,..|.impressions?,..|.reach?}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 2
fi

if [ "$FILE" != "-" ] && [ ! -r "$FILE" ]; then
  echo "error: cannot read file: $FILE" >&2
  exit 2
fi

# Build a jq filter that collects every value at every requested path, coerces
# numeric strings, ignores non-numbers, and sums the result.
FILTER="["
first=1
old_ifs="$IFS"
IFS=','
for p in $PATHS; do
  # Trim surrounding whitespace.
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  [ -n "$p" ] || continue
  if [ "$first" -eq 1 ]; then
    first=0
  else
    FILTER="$FILTER,"
  fi
  FILTER="${FILTER}[${p}]"
done
IFS="$old_ifs"
FILTER="$FILTER] | flatten
  | map(if type == \"string\" then (tonumber? // 0)
        elif type == \"number\" then .
        else 0 end)
  | add // 0"

if [ "$first" -eq 1 ]; then
  echo "error: no jq paths given" >&2
  exit 2
fi

# Buffer the input so we can run multiple jq passes (stdin is read once).
if [ "$FILE" = "-" ]; then
  INPUT="$(cat)"
  SRC_DESC="on stdin"
else
  INPUT="$(cat "$FILE")"
  SRC_DESC="in $FILE"
fi

if ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  echo "error: invalid JSON $SRC_DESC" >&2
  exit 2
fi

# Quota/plan-limit text pattern: an expired/over-limit plan can return HTTP 200
# with a marketing text row inside the data instead of metrics. Case-insensitive
# match on known phrases in any string value of the payload.
QUOTA_FILTER='[.. | strings] | any(test("upgrade here|plan limit|free plan|uh-oh"; "i"))'
if printf '%s' "$INPUT" | jq -e "$QUOTA_FILTER" >/dev/null 2>&1; then
  echo "warn: windsor quota/plan-limit message detected (plan expired?)"
  exit 1
fi

total="$(printf '%s' "$INPUT" | jq "$FILTER" 2>/dev/null)" \
  || { echo "error: invalid JSON $SRC_DESC" >&2; exit 2; }

# Non-zero (positive or negative) anywhere → real signal.
if awk -v t="$total" 'BEGIN { exit (t + 0 != 0 ? 0 : 1) }'; then
  echo "ok"
  exit 0
fi

echo "warn: windsor all-zero pattern (plan expired?)"
exit 1
