#!/usr/bin/env bash
set -euo pipefail

# App Store ranking + review signal collector — competitor intel v2.3
# Usage: appstore-lookup.sh <competitor-app-name> [--country US]

COMPETITOR_NAME="${1:-}"
COUNTRY="US"

if [[ -z "$COMPETITOR_NAME" ]]; then
  echo "Usage: appstore-lookup.sh <competitor-app-name> [--country US]" >&2
  exit 1
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --country) COUNTRY="${2:-US}"; shift 2 ;;
    *) shift ;;
  esac
done

LOG_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
LOG_FILE="$LOG_DIR/competitor-appstore.log"
mkdir -p "$LOG_DIR"

log_err() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] appstore-lookup ERROR: $*" >> "$LOG_FILE"; }

# URL-encode the search term (jq @uri as fallback)
ENCODED_TERM="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$COMPETITOR_NAME" 2>/dev/null \
  || jq -rn --arg t "$COMPETITOR_NAME" '$t | @uri')"

SEARCH_URL="https://itunes.apple.com/search?term=${ENCODED_TERM}&country=${COUNTRY}&entity=software&limit=5"

RESPONSE="$(curl -fsSL --max-time 10 "$SEARCH_URL" 2>/dev/null)" || {
  log_err "curl failed for '$COMPETITOR_NAME'"
  exit 0
}

RESULT_COUNT="$(printf '%s' "$RESPONSE" | jq -r '.resultCount // 0')"
if [[ "$RESULT_COUNT" -eq 0 ]]; then
  exit 0
fi

# Pick first result with kind == "software"
MATCH="$(printf '%s' "$RESPONSE" | jq -c '
  .results[]
  | select(.kind == "software")
  ' | head -1)"

if [[ -z "$MATCH" ]]; then
  exit 0
fi

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TRACK_ID="$(printf '%s' "$MATCH" | jq -r '.trackId')"
TRACK_NAME="$(printf '%s' "$MATCH" | jq -r '.trackName // ""')"
SELLER="$(printf '%s' "$MATCH" | jq -r '.sellerName // ""')"
VERSION="$(printf '%s' "$MATCH" | jq -r '.version // ""')"
RELEASE_DATE="$(printf '%s' "$MATCH" | jq -r '.currentVersionReleaseDate // ""')"
RATING="$(printf '%s' "$MATCH" | jq -r '.averageUserRating // 0')"
RATING_COUNT="$(printf '%s' "$MATCH" | jq -r '.userRatingCount // 0')"
PRICE="$(printf '%s' "$MATCH" | jq -r '.price // 0')"
CURRENCY="$(printf '%s' "$MATCH" | jq -r '.currency // "USD"')"

# Severity heuristic
SEVERITY="low"
if [[ -n "$RELEASE_DATE" ]]; then
  # Days since release
  # macOS: date -j -f; Linux: date -d
  RELEASE_EPOCH="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$RELEASE_DATE" +%s 2>/dev/null \
    || date -d "$RELEASE_DATE" +%s 2>/dev/null || echo 0)"
  DAYS_AGO=$(( ($(date -u +%s) - RELEASE_EPOCH) / 86400 ))
  if [[ "$DAYS_AGO" -le 7 ]]; then
    SEVERITY="high"
  fi
fi
if [[ "$SEVERITY" != "high" && "$RATING_COUNT" -gt 10000 ]]; then
  SEVERITY="med"
fi

# Format release date as YYYY-MM-DD
RELEASE_SHORT="${RELEASE_DATE:0:10}"

SNIPPET="${SELLER} · v${VERSION} released ${RELEASE_SHORT}"

jq -cn \
  --arg source "appstore" \
  --arg timestamp "$NOW_ISO" \
  --arg competitor "$COMPETITOR_NAME" \
  --argjson trackId "$TRACK_ID" \
  --arg version "$VERSION" \
  --arg release_date "$RELEASE_DATE" \
  --argjson rating "$RATING" \
  --argjson rating_count "$RATING_COUNT" \
  --argjson price "$PRICE" \
  --arg currency "$CURRENCY" \
  --arg severity "$SEVERITY" \
  --arg snippet "$SNIPPET" \
  '{source:$source,timestamp:$timestamp,competitor:$competitor,trackId:$trackId,version:$version,release_date:$release_date,rating:$rating,rating_count:$rating_count,price:$price,currency:$currency,severity:$severity,snippet:$snippet}'
