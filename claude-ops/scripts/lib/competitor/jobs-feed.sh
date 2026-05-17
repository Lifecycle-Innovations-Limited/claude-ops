#!/usr/bin/env bash
# Public job-board signal collector for competitor intel v2.3
# Usage: jobs-feed.sh <competitor-company-slug> [--source greenhouse|lever|auto]
set -euo pipefail

LOG_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
LOG_FILE="$LOG_DIR/competitor-jobs.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

if [[ $# -lt 1 ]]; then
  log "ERROR: missing competitor slug arg"
  exit 0
fi

SLUG="$1"; shift || true
SOURCE="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-auto}"; shift 2 ;;
    *) shift ;;
  esac
done

UA="claude-ops-competitor-intel/2.3 (+https://github.com/Lifecycle-Innovations-Limited/claude-ops)"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

fetch() {
  # $1 = url ; prints body, returns curl exit code; HTTP status appended on last line
  local url="$1" tmp status
  tmp=$(mktemp)
  status=$(curl -sS --max-time 15 -A "$UA" -H "Accept: application/json" -o "$tmp" -w '%{http_code}' "$url" 2>>"$LOG_FILE") || { rm -f "$tmp"; return 1; }
  cat "$tmp"; rm -f "$tmp"
  printf '\n%s' "$status"
}

emit_greenhouse() {
  local body="$1"
  printf '%s' "$body" | jq -c --arg comp "$SLUG" --arg now "$NOW_ISO" '
    .jobs[]?
    | {
        id:         (.id | tostring),
        title:      (.title // ""),
        location:   ((.location.name // "") | tostring),
        department: ((.departments[0].name // "") | tostring),
        posted_at:  (.updated_at // ""),
        url:        (.absolute_url // ""),
        content:    (.content // "")
      }
    | . as $j
    | ($j.content | gsub("<[^>]+>"; "") | gsub("&[a-z]+;"; " ") | gsub("\\s+"; " ") | .[0:200]) as $snip
    | (if   ($j.title | test("VP|Head of|Director|Chief"; "i")) then "high"
       elif ($j.title | test("Founding"; "i")) then "med"
       else "low" end) as $sev
    | {source:"jobs", timestamp:$now, competitor:$comp, board:"greenhouse",
       posting_id:$j.id, title:$j.title, location:$j.location, department:$j.department,
       posted_at:$j.posted_at, url:$j.url, severity:$sev, snippet:$snip}
  ' 2>>"$LOG_FILE" || log "ERROR: greenhouse jq transform failed for slug=$SLUG"
}

emit_lever() {
  local body="$1"
  printf '%s' "$body" | jq -c --arg comp "$SLUG" --arg now "$NOW_ISO" '
    .[]?
    | {
        id:         (.id // ""),
        title:      (.text // ""),
        location:   ((.categories.location // "") | tostring),
        department: ((.categories.team // "") | tostring),
        created_ms: (.createdAt // 0),
        url:        (.hostedUrl // ""),
        desc:       (.descriptionPlain // "")
      }
    | . as $j
    | ($j.desc | gsub("\\s+"; " ") | .[0:200]) as $snip
    | (if ($j.created_ms > 0) then ($j.created_ms / 1000 | strftime("%Y-%m-%dT%H:%M:%SZ")) else "" end) as $posted
    | (if   ($j.title | test("VP|Head of|Director|Chief"; "i")) then "high"
       elif ($j.title | test("Founding"; "i")) then "med"
       else "low" end) as $sev
    | {source:"jobs", timestamp:$now, competitor:$comp, board:"lever",
       posting_id:$j.id, title:$j.title, location:$j.location, department:$j.department,
       posted_at:$posted, url:$j.url, severity:$sev, snippet:$snip}
  ' 2>>"$LOG_FILE" || log "ERROR: lever jq transform failed for slug=$SLUG"
}

try_greenhouse() {
  local url="https://boards-api.greenhouse.io/v1/boards/${SLUG}/jobs?content=true"
  local out status body
  out=$(fetch "$url") || { log "ERROR: curl failed greenhouse slug=$SLUG"; return 2; }
  status=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d')
  case "$status" in
    200) emit_greenhouse "$body"; return 0 ;;
    404) return 1 ;;
    *)   log "ERROR: greenhouse HTTP $status slug=$SLUG"; return 2 ;;
  esac
}

try_lever() {
  local url="https://api.lever.co/v0/postings/${SLUG}?mode=json"
  local out status body
  out=$(fetch "$url") || { log "ERROR: curl failed lever slug=$SLUG"; return 2; }
  status=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d')
  case "$status" in
    200) emit_lever "$body"; return 0 ;;
    404) return 1 ;;
    *)   log "ERROR: lever HTTP $status slug=$SLUG"; return 2 ;;
  esac
}

case "$SOURCE" in
  greenhouse) try_greenhouse || true ;;
  lever)      try_lever || true ;;
  auto|*)
    if ! try_greenhouse; then
      try_lever || true
    fi
    ;;
esac

exit 0
