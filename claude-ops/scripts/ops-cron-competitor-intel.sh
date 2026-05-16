#!/usr/bin/env bash
# ops-cron-competitor-intel.sh — Weekly self-discovering competitor intel
#
# Pipeline (per brand seed):
#   1. Tavily discovery   → top competitors to {brand} in {category}
#   2. State merge        → diff vs competitor_state.json, flag NEW entrants
#   3. Tavily news pass   → recent moves per top-5 competitor (last 7d)
#   4. Tavily brand pass  → own-brand reviews / mentions
#   5. LLM synthesis      → claude_invoke (Sonnet) one-page strategic delta
#   6. Telegram digest + persist new state for next week's delta
#
# Config (preferences.json → .competitor_intel):
#   brand_name        — e.g. "My-Project"           (REQUIRED)
#   category          — e.g. "AI health coaching apps"  (REQUIRED)
#   max_competitors   — int, default 5
#   report_timezone   — IANA TZ, default UTC
#
# Env overrides: BRAND_NAME, BRAND_CATEGORY, MAX_COMPETITORS, REPORT_TIMEZONE
#
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/ops-marketplace/ops/$(ls -1 "$HOME/.claude/plugins/cache/ops-marketplace/ops/" 2>/dev/null | sort -V | tail -1)}"
DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/competitor-intel.log"
PREFS_PATH="$DATA_DIR/preferences.json"
STATE_PATH="$DATA_DIR/competitor_state.json"

mkdir -p "$LOG_DIR"
log() { printf '%s [competitor-intel] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# ── Resolve config ────────────────────────────────────────────────────────
pref_get() {
  local key="$1"
  [[ -f "$PREFS_PATH" ]] || { echo ""; return; }
  jq -r --arg k "$key" '.competitor_intel[$k] // ""' "$PREFS_PATH" 2>/dev/null || echo ""
}

BRAND_NAME="${BRAND_NAME:-$(pref_get brand_name)}"
BRAND_CATEGORY="${BRAND_CATEGORY:-$(pref_get category)}"
MAX_COMPETITORS="${MAX_COMPETITORS:-$(pref_get max_competitors)}"
REPORT_TIMEZONE="${REPORT_TIMEZONE:-$(pref_get report_timezone)}"
MAX_COMPETITORS="${MAX_COMPETITORS:-5}"
REPORT_TIMEZONE="${REPORT_TIMEZONE:-UTC}"

if [[ -z "$BRAND_NAME" || -z "$BRAND_CATEGORY" ]]; then
  log "SKIP: brand_name + category not configured in preferences.json. Run /ops:setup."
  log "HEARTBEAT_OK"
  exit 0
fi

# ── Resolve credentials ───────────────────────────────────────────────────
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"
TAVILY_KEY="${TAVILY_API_KEY:-}"

if [[ -z "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
fi
if [[ -z "$TAVILY_KEY" ]]; then
  TAVILY_KEY=$(doppler secrets get TAVILY_API_KEY --plain 2>/dev/null || true)
fi

if [[ -z "$TAVILY_KEY" ]]; then
  log "SKIP: TAVILY_API_KEY not available — can't run intelligent search."
  log "HEARTBEAT_OK"
  exit 0
fi

YEAR=$(date +%Y)

# ── Tavily helpers ────────────────────────────────────────────────────────
tavily_search() {
  # $1=query, $2=depth(basic|advanced), $3=topic(general|news), $4=days
  local query="$1" depth="${2:-basic}" topic="${3:-general}" days="${4:-30}"
  local payload
  payload=$(jq -n --arg q "$query" --arg d "$depth" --arg t "$topic" --argjson days "$days" \
    '{query:$q, search_depth:$d, topic:$t, max_results:5, days:$days}')

  curl -s -X POST "https://api.tavily.com/search" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TAVILY_KEY}" \
    -d "$payload" 2>/dev/null || echo '{"results":[]}'
}

# ── Stage 1: Discovery — surface current competitor landscape ─────────────
log "Stage 1: discovering competitors to '$BRAND_NAME' in category '$BRAND_CATEGORY'"
DISCOVERY_QUERY="Top competitors to $BRAND_NAME in $BRAND_CATEGORY market $YEAR — list company names"
DISCOVERY_JSON=$(tavily_search "$DISCOVERY_QUERY" "advanced" "general" 90)
DISCOVERY_TEXT=$(echo "$DISCOVERY_JSON" | jq -r '.results[]? | "[\(.title // "?")] \((.content // "")[:400])"' 2>/dev/null | head -c 6000)

# ── Stage 2: Load prior state ─────────────────────────────────────────────
KNOWN_COMPETITORS="[]"
if [[ -f "$STATE_PATH" ]]; then
  KNOWN_COMPETITORS=$(jq -r --arg b "$BRAND_NAME" '.[$b].competitors // []' "$STATE_PATH" 2>/dev/null || echo "[]")
fi
log "Stage 2: $(echo "$KNOWN_COMPETITORS" | jq 'length // 0' 2>/dev/null || echo 0) competitors in prior state"

# ── Stage 3: Brand mentions (own reviews/news) ────────────────────────────
log "Stage 3: scanning brand mentions for '$BRAND_NAME'"
BRAND_NEWS_JSON=$(tavily_search "$BRAND_NAME reviews OR mentions OR launch OR funding" "basic" "news" 7)
BRAND_TEXT=$(echo "$BRAND_NEWS_JSON" | jq -r '.results[]? | "[\(.title // "?")] \((.content // "")[:300])"' 2>/dev/null | head -c 4000)

# ── Stage 4: Recent moves per known competitor (cap at MAX_COMPETITORS) ───
COMPETITOR_MOVES=""
if [[ "$KNOWN_COMPETITORS" != "[]" && "$KNOWN_COMPETITORS" != "" ]]; then
  log "Stage 4: scanning recent moves for known competitors"
  while IFS= read -r comp; do
    [[ -z "$comp" ]] && continue
    NEWS_JSON=$(tavily_search "$comp pricing OR launch OR funding OR product $YEAR" "basic" "news" 7)
    SNIP=$(echo "$NEWS_JSON" | jq -r '.results[]? | "  • \(.title // "?"): \((.content // "")[:200])"' 2>/dev/null | head -3)
    [[ -n "$SNIP" ]] && COMPETITOR_MOVES+=$'\n## '"$comp"$'\n'"$SNIP"$'\n'
  done < <(echo "$KNOWN_COMPETITORS" | jq -r '.[]?' 2>/dev/null | head -n "$MAX_COMPETITORS")
fi

# ── Stage 5: LLM synthesis — strategic delta report ───────────────────────
log "Stage 5: LLM synthesis (Sonnet)"

NEW_STATE_COMPETITORS="$KNOWN_COMPETITORS"
REPORT=""

# shellcheck disable=SC1091
if [[ -f "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh" ]]; then
  . "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"

  PROMPT_FILE=$(mktemp)
  cat > "$PROMPT_FILE" <<EOF
You are a strategic competitor intelligence analyst.

Brand: $BRAND_NAME
Category: $BRAND_CATEGORY
Date: $(TZ="$REPORT_TIMEZONE" date '+%Y-%m-%d')
Previously known competitors: $(echo "$KNOWN_COMPETITORS" | jq -c '.' 2>/dev/null || echo "[]")

## Raw Tavily research

### Discovery pass (current landscape):
$DISCOVERY_TEXT

### Brand mentions (last 7 days, $BRAND_NAME):
$BRAND_TEXT

### Recent competitor moves (last 7 days):
$COMPETITOR_MOVES

## Your tasks

1. Extract the canonical competitor list from the Discovery pass — return ONLY actual product/company names, not generic categories. Cap at $MAX_COMPETITORS.
2. Identify NEW entrants (in current list but not in "Previously known competitors").
3. Identify DROPPED competitors (in prior list but absent from current landscape).
4. Synthesize a one-page strategic delta. Skip filler. Strategic, not generic.

Output format (STRICT — must be parseable):

\`\`\`json
{"competitors": ["name1","name2"]}
\`\`\`

---REPORT---
*$BRAND_NAME Competitor Intel — $(TZ="$REPORT_TIMEZONE" date '+%a %d %b %Y')*

*NEW entrants:*
...

*Competitor moves this week:*
...

*Brand signal:*
...

*Threats & opportunities:*
...
EOF

  SYNTHESIS=$(claude_invoke --model claude-sonnet-4-6 --no-session-persistence -p < "$PROMPT_FILE" 2>>"$LOG" || echo "")
  rm -f "$PROMPT_FILE"

  if [[ -n "$SYNTHESIS" ]]; then
    EXTRACTED=$(echo "$SYNTHESIS" | sed -n '/```json/,/```/p' | sed '1d;$d' | jq -r '.competitors // []' 2>/dev/null || echo "")
    [[ -n "$EXTRACTED" && "$EXTRACTED" != "null" ]] && NEW_STATE_COMPETITORS="$EXTRACTED"
    REPORT=$(echo "$SYNTHESIS" | awk '/---REPORT---/{flag=1; next} flag' | sed '/^```/,/^```$/d')
  fi
else
  log "WARN: claude-invoke.sh not found at $PLUGIN_ROOT — using Tavily-only fallback"
fi

# Fallback report if LLM unavailable or returned empty
if [[ -z "$REPORT" ]]; then
  REPORT="*Weekly Competitor Intel — $(TZ="$REPORT_TIMEZONE" date '+%a %d %b %Y')*

*Discovery (raw):*
${DISCOVERY_TEXT:0:1200}

*Brand mentions (raw):*
${BRAND_TEXT:0:1200}"
fi

# ── Persist state ─────────────────────────────────────────────────────────
TMP_STATE=$(mktemp)
if [[ -f "$STATE_PATH" ]]; then
  jq --arg b "$BRAND_NAME" --argjson c "$NEW_STATE_COMPETITORS" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.[$b] = {competitors: $c, last_run: $ts}' "$STATE_PATH" > "$TMP_STATE" 2>/dev/null \
    || jq -n --arg b "$BRAND_NAME" --argjson c "$NEW_STATE_COMPETITORS" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '{($b): {competitors: $c, last_run: $ts}}' > "$TMP_STATE"
else
  jq -n --arg b "$BRAND_NAME" --argjson c "$NEW_STATE_COMPETITORS" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{($b): {competitors: $c, last_run: $ts}}' > "$TMP_STATE"
fi
mv "$TMP_STATE" "$STATE_PATH"
log "State persisted: $(echo "$NEW_STATE_COMPETITORS" | jq 'length // 0' 2>/dev/null || echo 0) competitors tracked for $BRAND_NAME"

# ── Stage 6: Send to Telegram ─────────────────────────────────────────────
log "Stage 6: dispatching Telegram digest"
if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat "$TELEGRAM_CHAT" --arg text "$REPORT" \
        '{chat_id: $chat, text: $text, parse_mode: "Markdown"}')" \
    >> "$LOG" 2>&1
  log "Competitor intel sent to Telegram chat=$TELEGRAM_CHAT"
else
  log "WARN: TELEGRAM creds not set — printing report to stdout"
  printf '%s\n' "$REPORT"
fi

log "HEARTBEAT_OK"
