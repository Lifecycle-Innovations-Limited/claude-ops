#!/usr/bin/env bash
# Hacker News signal collector for competitor intel v2.3
# Usage: hn-search.sh <brand-or-competitor-name> [--days N]
set -euo pipefail

LOG_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
LOG_FILE="$LOG_DIR/competitor-hn.log"
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

# Compute UNIX timestamp N days ago (BSD + GNU date compatible)
if date -u -v-1d +%s >/dev/null 2>&1; then
  SINCE_TS=$(date -u -v-"${DAYS}"d +%s)
else
  SINCE_TS=$(date -u -d "${DAYS} days ago" +%s)
fi

UA="claude-ops-competitor-intel/2.3 (+https://github.com/Lifecycle-Innovations-Limited/claude-ops)"
QUERY=$(printf '%s' "$COMP" | jq -sRr @uri)
URL="https://hn.algolia.com/api/v1/search?query=${QUERY}&tags=story&numericFilters=created_at_i>${SINCE_TS}&hitsPerPage=20"

RESP=$(curl -sS --max-time 15 -A "$UA" -H "Accept: application/json" "$URL" 2>>"$LOG_FILE") || {
  log "ERROR: curl failed for query=$COMP"
  exit 0
}

if ! printf '%s' "$RESP" | jq -e '.hits' >/dev/null 2>&1; then
  log "ERROR: parse failed for query=$COMP (resp len=${#RESP})"
  exit 0
fi

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '%s' "$RESP" | jq -c --arg comp "$COMP" --arg now "$NOW_ISO" '
  .hits[]?
  | {
      objectID:     (.objectID // ""),
      title:        (.title // ""),
      ext_url:      (.url // ""),
      points:       (.points // 0),
      num_comments: (.num_comments // 0),
      author:       (.author // ""),
      story_text:   (.story_text // "")
    }
  | . as $p
  | ($p.story_text | gsub("<[^>]+>"; "") | .[0:300]) as $snippet
  | (if   ($p.points > 100 and $p.num_comments > 30) then "high"
     elif ($p.points > 30)
          or ($p.title | test("Show HN|Launch HN|is hiring"; "i")) then "med"
     else "low" end) as $sev
  | (if ($p.ext_url | length) > 0 then $p.ext_url
     else "https://news.ycombinator.com/item?id=" + $p.objectID end) as $url
  | {
      source:       "hn",
      timestamp:    $now,
      competitor:   $comp,
      title:        $p.title,
      url:          $url,
      points:       $p.points,
      num_comments: $p.num_comments,
      author:       $p.author,
      severity:     $sev,
      snippet:      $snippet
    }
' 2>>"$LOG_FILE" || {
  log "ERROR: jq transform failed for query=$COMP"
  exit 0
}

exit 0
