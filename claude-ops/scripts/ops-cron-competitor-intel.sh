#!/usr/bin/env bash
# ops-cron-competitor-intel.sh — Weekly Competitor Intel cron job
# Migrated from OpenClaw "Weekly Competitor Intel" (cron: 0 10 * * MON, tz: Europe/Amsterdam)
# Searches competitors (AG1, Huel), own brand reviews, reports to Telegram
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/competitor-intel.log"

mkdir -p "$LOG_DIR"
log() { printf '%s [competitor-intel] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# ── Resolve credentials ───────────────────────────────────────────────────
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-1335137548}"
TAVILY_KEY="${TAVILY_API_KEY:-}"

if [[ -z "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
fi
if [[ -z "$TAVILY_KEY" ]]; then
  TAVILY_KEY=$(doppler secrets get TAVILY_API_KEY --plain 2>/dev/null || true)
fi

YEAR=$(date +%Y)
FINDINGS=()

# ── Search function via Tavily (or fallback curl) ─────────────────────────
search_web() {
  local query="$1"
  local label="$2"
  local result=""

  if [[ -n "$TAVILY_KEY" ]]; then
    result=$(curl -s -X POST "https://api.tavily.com/search" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TAVILY_KEY}" \
      -d "{\"query\": \"$query\", \"max_results\": 3, \"search_depth\": \"basic\"}" \
      2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
if not results:
    print('No results found')
else:
    snippets = [r.get('title','') + ': ' + r.get('content','')[:120] for r in results[:2]]
    print(' | '.join(snippets))
" 2>/dev/null || echo "search unavailable")
  else
    # Fallback: SerpAPI-compatible curl search via DuckDuckGo HTML (best-effort)
    result=$(curl -s -A "Mozilla/5.0" \
      "https://html.duckduckgo.com/html/?q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote('$query'))")" \
      2>/dev/null | python3 -c "
import sys, re
html = sys.stdin.read()
titles = re.findall(r'class=\"result__title\"[^>]*>.*?<a[^>]*>(.*?)</a>', html, re.DOTALL)
clean = [re.sub('<[^>]+>','',t).strip() for t in titles[:3]]
print(' | '.join(clean[:2]) if clean else 'No results')
" 2>/dev/null || echo "search unavailable")
  fi

  log "Search [$label]: ${result:0:100}..."
  echo "$result"
}

# ── Run searches ──────────────────────────────────────────────────────────
log "Running weekly competitor intelligence searches"

AG1_RESULT=$(search_web "AG1 Athletic Greens price change $YEAR" "AG1 price")
HUEL_RESULT=$(search_web "Huel Daily Greens new products $YEAR" "Huel new")
BRAND_RESULT=$(search_web "AlwaysBright supplement reviews $YEAR" "AlwaysBright reviews")

# ── Build report ──────────────────────────────────────────────────────────
DATE_LABEL=$(TZ="Europe/Amsterdam" date "+%a %d %b %Y")
REPORT="*Weekly Competitor Intel* ($DATE_LABEL)

*AG1 / Athletic Greens:*
$AG1_RESULT

*Huel Daily Greens:*
$HUEL_RESULT

*AlwaysBright Brand Mentions:*
$BRAND_RESULT"

log "Report built — sending to Telegram"

# ── Send to Telegram ──────────────────────────────────────────────────────
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"$TELEGRAM_CHAT\", \"text\": $(echo "$REPORT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"parse_mode\": \"Markdown\"}" \
    >> "$LOG" 2>&1
  log "Competitor intel sent to Telegram chat=$TELEGRAM_CHAT"
else
  log "WARN: TELEGRAM_BOT_TOKEN not set — printing report to stdout"
  echo "$REPORT"
fi

log "HEARTBEAT_OK"
