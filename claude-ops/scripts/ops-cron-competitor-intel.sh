#!/usr/bin/env bash
# ops-cron-competitor-intel.sh v2.3 — Weekly Monday 10:00 Europe/Amsterdam
# strategic synthesis cron.
#
# Pipeline (per brand seed):
#   1. Discovery (cached 30d)        — Tavily landscape search
#   2. Per-competitor signal collect  — reddit/hn/appstore/jobs/page-diff (parallel)
#   3. Brand mentions                 — Tavily news (last 7d) + route
#   4. Event log read                 — last 7d from events.jsonl
#   5. LLM synthesis                  — Sonnet, fenced-JSON extraction
#   6. State persist + disk report    — symlink + optional Telegram
#
# Config (preferences.json → .competitor_intel):
#   brand_name        — e.g. "My-Project"                  (REQUIRED)
#   category          — e.g. "AI health coaching apps"  (REQUIRED)
#   max_competitors   — int, default 5
#   report_timezone   — IANA TZ, default UTC
#   app_store         — bool, enable appstore-lookup collectors
#   urls              — object: {<CompetitorName>: {pricing:"...",features:"...",careers:"..."}}
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
EVENTS_PATH="$DATA_DIR/competitor_state/events.jsonl"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib/competitor" 2>/dev/null && pwd || echo "$HOME/.claude/plugins/cache/ops-marketplace/ops/scripts/lib/competitor")"

mkdir -p "$LOG_DIR" "$DATA_DIR/competitor_state" "$DATA_DIR/reports/competitor-intel"
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

# App Store enabled flag
APP_STORE_ENABLED=false
if [[ -f "$PREFS_PATH" ]]; then
  _as=$(jq -r '.competitor_intel.app_store // false' "$PREFS_PATH" 2>/dev/null || echo "false")
  [[ "$_as" == "true" ]] && APP_STORE_ENABLED=true
fi

if [[ -z "$BRAND_NAME" || -z "$BRAND_CATEGORY" ]]; then
  log "SKIP: brand_name + category not configured in preferences.json. Run /ops:setup."
  log "HEARTBEAT_OK"
  exit 0
fi

# ── Resolve credentials ───────────────────────────────────────────────────
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"
TAVILY_KEY="${TAVILY_API_KEY:-}"

[[ -z "$TELEGRAM_TOKEN" ]] && TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
[[ -z "$TAVILY_KEY" ]]     && TAVILY_KEY=$(doppler secrets get TAVILY_API_KEY --plain 2>/dev/null || true)

# Load event router if available
ROUTER_SH="$LIB_DIR/event-router.sh"
HAS_ROUTER=false
if [[ -f "$ROUTER_SH" ]]; then
  # shellcheck disable=SC1090
  . "$ROUTER_SH" && HAS_ROUTER=true || true
fi

route_event() {
  # Pipe stdin JSONL through router if loaded; else append directly to events.jsonl
  if $HAS_ROUTER; then
    route_event_fn  # function from event-router.sh; reads stdin
  else
    tee -a "$EVENTS_PATH"
  fi
}

YEAR=$(date +%Y)
NOW_EPOCH=$(date -u +%s)

# ── Tavily helpers ────────────────────────────────────────────────────────
tavily_search() {
  local query="$1" depth="${2:-basic}" topic="${3:-general}" days="${4:-30}"
  local payload
  payload=$(jq -n --arg q "$query" --arg d "$depth" --arg t "$topic" --argjson days "$days" \
    '{query:$q, search_depth:$d, topic:$t, max_results:5, days:$days}')
  curl -s -X POST "https://api.tavily.com/search" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TAVILY_KEY}" \
    -d "$payload" 2>/dev/null || echo '{"results":[]}'
}

# ── Stage 1: Discovery (cached 30d) ──────────────────────────────────────
KNOWN_COMPETITORS="[]"
LAST_DISCOVERY=""
if [[ -f "$STATE_PATH" ]]; then
  KNOWN_COMPETITORS=$(jq -r --arg b "$BRAND_NAME" '.[$b].competitors // []' "$STATE_PATH" 2>/dev/null || echo "[]")
  LAST_DISCOVERY=$(jq -r --arg b "$BRAND_NAME" '.[$b].last_discovery // ""' "$STATE_PATH" 2>/dev/null || echo "")
fi

DISCOVERY_TEXT=""
NEED_DISCOVERY=true

# Check if 30d cache is still valid
if [[ -n "$LAST_DISCOVERY" ]]; then
  # BSD date -j; fallback to GNU date -d
  DISC_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_DISCOVERY" +%s 2>/dev/null \
    || date -d "$LAST_DISCOVERY" +%s 2>/dev/null || echo 0)
  AGE_DAYS=$(( (NOW_EPOCH - DISC_EPOCH) / 86400 ))
  if (( AGE_DAYS < 30 )) && [[ "$KNOWN_COMPETITORS" != "[]" ]]; then
    NEED_DISCOVERY=false
    log "Stage 1: discovery cache valid (${AGE_DAYS}d old, next refresh in $((30 - AGE_DAYS))d)"
  fi
fi

if $NEED_DISCOVERY; then
  if [[ -z "$TAVILY_KEY" ]]; then
    if [[ "$KNOWN_COMPETITORS" == "[]" ]]; then
      log "SKIP: TAVILY_API_KEY missing and no cached competitors — nothing to process."
      log "HEARTBEAT_OK"
      exit 0
    fi
    log "Stage 1: TAVILY_API_KEY missing — skipping discovery, using cached competitors"
    NEED_DISCOVERY=false
  else
    log "Stage 1: running Tavily discovery for '$BRAND_NAME' in '$BRAND_CATEGORY'"
    DISC_JSON=$(tavily_search \
      "Top competitors to $BRAND_NAME in $BRAND_CATEGORY market $YEAR — list company names" \
      "advanced" "general" 90)
    DISCOVERY_TEXT=$(printf '%s' "$DISC_JSON" \
      | jq -r '.results[]? | "[\(.title // "?")] \((.content // "")[:400])"' 2>/dev/null \
      | head -c 6000)
  fi
fi

log "Stage 1: $(printf '%s' "$KNOWN_COMPETITORS" | jq 'length // 0' 2>/dev/null || echo 0) competitors in prior state"

# ── Stage 2: Per-competitor parallel signal collection ────────────────────
log "Stage 2: parallel signal collection begins"
TMP_EVENTS_DIR=$(mktemp -d)

collect_competitor() {
  local comp="$1"
  local out_file="$TMP_EVENTS_DIR/$(printf '%s' "$comp" | tr -cd 'a-zA-Z0-9_-' | head -c 40).jsonl"

  # reddit + hn always
  timeout 30 bash "$LIB_DIR/reddit-search.sh" "$comp" --days 7 >> "$out_file" 2>/dev/null || true
  timeout 30 bash "$LIB_DIR/hn-search.sh"     "$comp" --days 7 >> "$out_file" 2>/dev/null || true

  # appstore only if enabled in prefs
  if $APP_STORE_ENABLED; then
    timeout 30 bash "$LIB_DIR/appstore-lookup.sh" "$comp" >> "$out_file" 2>/dev/null || true
  fi

  # jobs-feed — derive slug: lowercase + hyphenate spaces/slashes
  local slug
  slug=$(printf '%s' "$comp" | tr '[:upper:] /' '[:lower:]--' | tr -cd 'a-z0-9-')
  timeout 30 bash "$LIB_DIR/jobs-feed.sh" "$slug" >> "$out_file" 2>/dev/null || true

  # page-diff for each URL kind defined in prefs under .competitor_intel.urls.<comp>
  if [[ -f "$PREFS_PATH" ]]; then
    local url_kinds=("pricing" "features" "careers")
    for kind in "${url_kinds[@]}"; do
      local url
      url=$(jq -r --arg c "$comp" --arg k "$kind" \
        '.competitor_intel.urls[$c][$k] // ""' "$PREFS_PATH" 2>/dev/null || echo "")
      if [[ -n "$url" ]]; then
        timeout 30 bash "$LIB_DIR/page-diff.sh" "$BRAND_NAME" "$comp" "$kind" "$url" \
          >> "$out_file" 2>/dev/null || true
      fi
    done
  fi
}

PIDS=()
while IFS= read -r comp; do
  [[ -z "$comp" ]] && continue
  collect_competitor "$comp" &
  PIDS+=($!)
done < <(printf '%s' "$KNOWN_COMPETITORS" | jq -r '.[]?' 2>/dev/null | head -n "$MAX_COMPETITORS")

# Wait for all background collectors
for pid in "${PIDS[@]:-}"; do
  wait "$pid" 2>/dev/null || true
done

# Route all collected events through the event router + accumulate for prompt
EVENTS_JSONL=""
for f in "$TMP_EVENTS_DIR"/*.jsonl; do
  [[ -f "$f" ]] || continue
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    printf '%s\n' "$line" | route_event || true
    EVENTS_JSONL+="$line"$'\n'
  done < "$f"
done
rm -rf "$TMP_EVENTS_DIR"

log "Stage 2: signal collection complete ($(printf '%s' "$EVENTS_JSONL" | grep -c . || echo 0) events collected)"

# ── Stage 3: Brand mentions ───────────────────────────────────────────────
BRAND_TEXT=""
if [[ -n "$TAVILY_KEY" ]]; then
  log "Stage 3: scanning brand mentions for '$BRAND_NAME'"
  BRAND_NEWS_JSON=$(tavily_search \
    "$BRAND_NAME reviews OR mentions OR launch OR funding" "basic" "news" 7)
  BRAND_TEXT=$(printf '%s' "$BRAND_NEWS_JSON" \
    | jq -r '.results[]? | "[\(.title // "?")] \((.content // "")[:300])"' 2>/dev/null \
    | head -c 4000)

  # Route brand mention events
  if $HAS_ROUTER; then
    printf '%s' "$BRAND_NEWS_JSON" | jq -c --arg b "$BRAND_NAME" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.results[]? | {source:"tavily-brand",timestamp:$ts,competitor:$b,title:.title,url:.url,severity:"low",snippet:(.content // "" | .[0:200])}' \
      2>/dev/null | route_event || true
  fi
else
  log "Stage 3: SKIP brand mentions (no TAVILY_KEY)"
fi

# ── Stage 4: Read past 7d of events from events.jsonl ────────────────────
log "Stage 4: reading 7d event log"
CUTOFF_EPOCH=$((NOW_EPOCH - 7 * 86400))
AUDIT_EVENTS=""
if [[ -f "$EVENTS_PATH" ]]; then
  AUDIT_EVENTS=$(jq -rc --argjson cut "$CUTOFF_EPOCH" '
    select(.timestamp? != null)
    | select(
        (.timestamp | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) >= $cut
      )
  ' "$EVENTS_PATH" 2>/dev/null | head -c 100000 || true)
fi
EVENT_COUNT=$(printf '%s' "$AUDIT_EVENTS" | grep -c . || echo 0)
log "Stage 4: $EVENT_COUNT events in 7d window"

# Merge collector events into audit log view (they may not be flushed yet)
if [[ -n "$EVENTS_JSONL" ]]; then
  AUDIT_EVENTS="${AUDIT_EVENTS}"$'\n'"${EVENTS_JSONL}"
fi
# Cap total prompt input
AUDIT_EVENTS=$(printf '%s' "$AUDIT_EVENTS" | head -c 100000)

# ── Stage 5: LLM synthesis ───────────────────────────────────────────────
log "Stage 5: LLM synthesis (Sonnet)"

NEW_STATE_COMPETITORS="$KNOWN_COMPETITORS"
REPORT=""
SYNTHESIS=""

# shellcheck disable=SC1091
if [[ -f "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh" ]]; then
  . "$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"

  PROMPT_FILE=$(mktemp)
  SYSTEM_PROMPT="You are a senior strategic competitor intelligence analyst. Be concise, specific, and action-oriented. Avoid generic summaries."

  cat > "$PROMPT_FILE" <<EOF
Brand: $BRAND_NAME
Category: $BRAND_CATEGORY
Report date: $(TZ="$REPORT_TIMEZONE" date '+%Y-%m-%d')
Previously known competitors: $(printf '%s' "$KNOWN_COMPETITORS" | jq -c '.' 2>/dev/null || echo "[]")

## Discovery research (Tavily, current landscape):
${DISCOVERY_TEXT:-[skipped — cached competitor list used]}

## Brand mentions (last 7d):
${BRAND_TEXT:-[skipped — no Tavily key]}

## Signal event log (last 7d, JSONL):
${AUDIT_EVENTS:-[no events]}

## Your tasks

1. Extract the canonical competitor list from Discovery + events — real product/company names only, no categories. Cap at $MAX_COMPETITORS.
2. Identify NEW entrants vs "Previously known competitors".
3. Identify DROPPED competitors (in prior list, absent now).
4. Synthesize a one-page strategic delta — skip filler, be strategic.

Output format (STRICT):

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

  SYNTHESIS=$(claude_invoke --model claude-sonnet-4-6 --no-session-persistence \
    --system "$SYSTEM_PROMPT" -p < "$PROMPT_FILE" 2>>"$LOG" || echo "")
  rm -f "$PROMPT_FILE"
else
  log "WARN: claude-invoke.sh not found at $PLUGIN_ROOT — using Tavily-only fallback"
fi

# Persist raw synthesis immediately so partial output is never lost
REPORT_DIR="$DATA_DIR/reports/competitor-intel"
BRAND_SLUG=$(printf '%s' "$BRAND_NAME" | tr '[:upper:] ' '[:lower:]-')
SYNTHESIS_FILE="$REPORT_DIR/$(date +%Y-%m-%d)_${BRAND_SLUG}-synthesis.md"
if [[ -n "$SYNTHESIS" ]]; then
  printf '%s\n' "$SYNTHESIS" > "$SYNTHESIS_FILE"
  log "Raw synthesis persisted to $SYNTHESIS_FILE"
fi

# ── JSON + report extraction ──────────────────────────────────────────────
if [[ -n "$SYNTHESIS" ]]; then
  EXTRACTED=""
  # 1. Fenced ```json block
  CAND=$(printf '%s' "$SYNTHESIS" | sed -n '/```json/,/```/p' | sed '1d;$d' \
    | jq -r '.competitors // empty' 2>/dev/null || true)
  [[ -n "$CAND" && "$CAND" != "null" && "$CAND" != "[]" ]] && EXTRACTED="$CAND"

  # 2. Bare {"competitors":[...]} anywhere in output
  if [[ -z "$EXTRACTED" ]]; then
    CAND=$(printf '%s' "$SYNTHESIS" \
      | grep -oE '\{"competitors":\s*\[[^]]*\][^}]*\}' | head -1 \
      | jq -r '.competitors // empty' 2>/dev/null || true)
    [[ -n "$CAND" && "$CAND" != "null" && "$CAND" != "[]" ]] && EXTRACTED="$CAND"
  fi

  # 3. Greedy bullet-list scrape from competitor/entrant sections
  if [[ -z "$EXTRACTED" ]]; then
    CAND=$(printf '%s' "$SYNTHESIS" \
      | awk '/[Cc]ompetitor|[Ee]ntrant/{flag=1} flag && /^\s*[-•*]\s*\*?\*?[A-Z][A-Za-z0-9 .&-]+/' \
      | grep -oE '\*?\*?[A-Z][A-Za-z0-9 .&-]{2,30}\*?\*?' \
      | sed 's/\*//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
      | sort -u | head -10 | jq -R . | jq -s . 2>/dev/null || true)
    [[ -n "$CAND" && "$CAND" != "null" && "$CAND" != "[]" ]] && EXTRACTED="$CAND"
  fi

  [[ -n "$EXTRACTED" ]] && NEW_STATE_COMPETITORS="$EXTRACTED"

  # Dedup + cap competitor list
  NEW_STATE_COMPETITORS=$(printf '%s' "$NEW_STATE_COMPETITORS" \
    | jq -c --argjson max "$MAX_COMPETITORS" 'unique | .[0:$max]' 2>/dev/null \
    || echo "$NEW_STATE_COMPETITORS")

  # Extract report section
  REPORT=$(printf '%s' "$SYNTHESIS" | awk '/---REPORT---/{flag=1; next} flag' | sed '/^```/,/^```$/d')
  if [[ -z "$REPORT" ]]; then
    REPORT=$(printf '%s' "$SYNTHESIS" | sed -E '/^```(json)?$/,/^```$/d')
    log "WARN: ---REPORT--- marker missing — using full synthesis as report"
  fi
fi

# Fallback report if LLM unavailable or returned empty
if [[ -z "$REPORT" ]]; then
  REPORT="*Weekly Competitor Intel — $(TZ="$REPORT_TIMEZONE" date '+%a %d %b %Y')*

*Discovery (raw):*
${DISCOVERY_TEXT:0:1200}

*Brand mentions (raw):*
${BRAND_TEXT:0:1200}

*Signal events (raw, $EVENT_COUNT in 7d):*
$(printf '%s' "$AUDIT_EVENTS" | head -c 800)"
fi

# ── Stage 6: Persist state ────────────────────────────────────────────────
LAST_DISC_TS="$LAST_DISCOVERY"
$NEED_DISCOVERY && LAST_DISC_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TMP_STATE=$(mktemp)
if [[ -f "$STATE_PATH" ]]; then
  jq --arg b "$BRAND_NAME" \
     --argjson c "$NEW_STATE_COMPETITORS" \
     --arg ts "$NOW_TS" \
     --arg ld "$LAST_DISC_TS" \
     --argjson as "$APP_STORE_ENABLED" \
    '.[$b] = (.[$b] // {}) + {competitors:$c, last_run:$ts, last_discovery:$ld, app_store_enabled:$as}' \
    "$STATE_PATH" > "$TMP_STATE" 2>/dev/null \
  || jq -n --arg b "$BRAND_NAME" \
          --argjson c "$NEW_STATE_COMPETITORS" \
          --arg ts "$NOW_TS" \
          --arg ld "$LAST_DISC_TS" \
          --argjson as "$APP_STORE_ENABLED" \
    '{($b): {competitors:$c, last_run:$ts, last_discovery:$ld, app_store_enabled:$as}}' > "$TMP_STATE"
else
  jq -n --arg b "$BRAND_NAME" \
         --argjson c "$NEW_STATE_COMPETITORS" \
         --arg ts "$NOW_TS" \
         --arg ld "$LAST_DISC_TS" \
         --argjson as "$APP_STORE_ENABLED" \
    '{($b): {competitors:$c, last_run:$ts, last_discovery:$ld, app_store_enabled:$as}}' > "$TMP_STATE"
fi
mv "$TMP_STATE" "$STATE_PATH"
log "State persisted: $(printf '%s' "$NEW_STATE_COMPETITORS" | jq 'length // 0' 2>/dev/null || echo 0) competitors tracked for $BRAND_NAME"

# ── Disk report (always) + symlink ───────────────────────────────────────
REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d)_${BRAND_SLUG}.md"
printf '%s\n' "$REPORT" > "$REPORT_FILE"
ln -sf "$REPORT_FILE" "$REPORT_DIR/latest-${BRAND_SLUG}.md"
log "Report written to $REPORT_FILE"

# ── Telegram (additive) ───────────────────────────────────────────────────
if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat "$TELEGRAM_CHAT" --arg text "$REPORT" \
        '{chat_id:$chat, text:$text, parse_mode:"Markdown"}')" \
    >> "$LOG" 2>&1
  log "Competitor intel sent to Telegram chat=$TELEGRAM_CHAT"
else
  log "INFO: TELEGRAM creds not set — report saved to disk only ($REPORT_FILE)"
fi

log "HEARTBEAT_OK"
