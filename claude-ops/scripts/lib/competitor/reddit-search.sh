#!/usr/bin/env bash
# Reddit signal collector for competitor intel v2.3
# Usage: reddit-search.sh <brand-or-competitor-name> [--days N]
set -euo pipefail

LOG_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
LOG_FILE="$LOG_DIR/competitor-reddit.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

if [[ $# -lt 1 ]]; then
  log "ERROR: missing competitor name arg"
  exit 0
fi

COMP="$1"; shift || true
DAYS=7
while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="${2:-7}"; shift 2 ;;
    *) shift ;;
  esac
done

# Map days to Reddit's t= window (week is the most useful default; clamp out-of-band values)
if   [[ "$DAYS" -le 1 ]]; then T_WINDOW="day"
elif [[ "$DAYS" -le 7 ]]; then T_WINDOW="week"
elif [[ "$DAYS" -le 31 ]]; then T_WINDOW="month"
elif [[ "$DAYS" -le 365 ]]; then T_WINDOW="year"
else T_WINDOW="all"
fi

UA="claude-ops-competitor-intel/2.3 (+https://github.com/Lifecycle-Innovations-Limited/claude-ops)"
QUERY=$(printf '%s' "$COMP" | jq -sRr @uri)
URL="https://www.reddit.com/search.json?q=${QUERY}&t=${T_WINDOW}&limit=25&sort=new"

RESP=$(curl -sS --max-time 15 -A "$UA" -H "Accept: application/json" "$URL" 2>>"$LOG_FILE") || {
  log "ERROR: curl failed for query=$COMP"
  exit 0
}

if ! printf '%s' "$RESP" | jq -e '.data.children' >/dev/null 2>&1; then
  log "ERROR: parse failed for query=$COMP (resp len=${#RESP})"
  exit 0
fi

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '%s' "$RESP" | jq -c --arg comp "$COMP" --arg now "$NOW_ISO" '
  .data.children[]?.data
  | {
      title:        (.title // ""),
      permalink:    (.permalink // ""),
      subreddit:    (.subreddit // ""),
      score:        (.score // 0),
      num_comments: (.num_comments // 0),
      selftext:     (.selftext // ""),
      created_utc:  (.created_utc // 0)
    }
  | . as $p
  | ($p.selftext | .[0:300]) as $snippet
  | ($p.title + " " + $p.selftext | ascii_downcase) as $hay
  | (if   ($p.score > 100 and $p.num_comments > 20) then "high"
     elif ($p.score > 20)
          or ($hay | test("complaint|\\bvs\\b|alternative|switching from")) then "med"
     else "low" end) as $sev
  | {
      source:       "reddit",
      timestamp:    $now,
      competitor:   $comp,
      title:        $p.title,
      url:          ("https://www.reddit.com" + $p.permalink),
      subreddit:    $p.subreddit,
      score:        $p.score,
      num_comments: $p.num_comments,
      severity:     $sev,
      snippet:      $snippet
    }
' 2>>"$LOG_FILE" || {
  log "ERROR: jq transform failed for query=$COMP"
  exit 0
}

exit 0
