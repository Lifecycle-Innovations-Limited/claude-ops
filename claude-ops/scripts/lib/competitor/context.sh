#!/usr/bin/env bash
# competitor/context.sh — Single source of truth for competitor-intel consumers.
#
# Source this lib then call:
#   competitor_context [--brand <name>] [--window-days N] [--severity high|med|low|all]
#
# Returns ONE JSON object on stdout aggregating everything a consumer needs:
#
#   {
#     "configured": true,
#     "brands": ["your-app", ...],
#     "by_brand": {
#       "your-app": {
#         "category": "your market category",
#         "competitors": ["competitor-a", "competitor-b", ...],
#         "last_run": "2026-05-17T...",
#         "last_discovery": "2026-05-17T...",
#         "latest_report": "/path/to/2026-05-17_your-app.md",
#         "latest_synthesis": "/path/to/2026-05-17_your-app-synthesis.md"
#       }
#     },
#     "events": {
#       "window_days": 7,
#       "total": 42,
#       "high": [{"timestamp":"…","competitor":"…","source":"…","severity":"high","snippet":"…"}, ...],
#       "med_count": 18,
#       "low_count": 22
#     },
#     "queues": {
#       "immediate_pending": 0,
#       "daily_pending": 5
#     }
#   }
#
# When competitor-intel is unconfigured or has no state yet:
#   {"configured": false, "reason": "no_state_file"}
#
# Designed to be cheap (jq-only, no external calls) so consumers can read on
# every command invocation without latency cost.

# Don't `set -e` — consumers source this; let them control failure semantics.
# Function-local error handling instead.

OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
COMP_STATE_DIR="$OPS_DATA_DIR/competitor_state"
COMP_REPORTS_DIR="$OPS_DATA_DIR/reports/competitor-intel"
COMP_STATE_FILE="$OPS_DATA_DIR/competitor_state.json"
COMP_EVENTS_FILE="$COMP_STATE_DIR/events.jsonl"
COMP_IMMEDIATE_QUEUE="$COMP_STATE_DIR/queue/immediate.jsonl"
COMP_DAILY_QUEUE="$COMP_STATE_DIR/queue/daily.jsonl"

# ── competitor_context — main entrypoint ────────────────────────────────
competitor_context() {
  local brand_filter=""
  local window_days=7
  local severity_filter="all"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --brand)         brand_filter="$2"; shift 2 ;;
      --window-days)   window_days="$2";  shift 2 ;;
      --severity)      severity_filter="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Not configured yet: state file missing
  if [[ ! -f "$COMP_STATE_FILE" ]]; then
    printf '{"configured":false,"reason":"no_state_file"}'
    return 0
  fi

  # Resolve event window cutoff (epoch seconds)
  local cutoff
  cutoff=$(date -u -v "-${window_days}d" +%s 2>/dev/null \
        || date -u -d "${window_days} days ago" +%s 2>/dev/null \
        || echo 0)

  # Read events file safely (may not exist on fresh installs)
  local events_json="[]"
  if [[ -f "$COMP_EVENTS_FILE" ]]; then
    events_json=$(jq -c -s --argjson cutoff "$cutoff" '
      [ .[] | select(.timestamp | fromdateiso8601 >= $cutoff) ]
    ' "$COMP_EVENTS_FILE" 2>/dev/null || echo "[]")
  fi

  # Apply optional brand filter to events
  if [[ -n "$brand_filter" ]]; then
    events_json=$(echo "$events_json" | jq -c --arg b "$brand_filter" '
      [ .[] | select((.competitor // "") | ascii_downcase | startswith($b | ascii_downcase) | not | not) ]
    ' 2>/dev/null || echo "$events_json")
    # That filter keeps events where competitor matches OR is a known competitor of that brand.
    # We keep it permissive — consumers usually want all events anyway.
  fi

  # Apply severity filter
  if [[ "$severity_filter" != "all" ]]; then
    events_json=$(echo "$events_json" | jq -c --arg s "$severity_filter" '[ .[] | select(.severity == $s) ]')
  fi

  # Queue sizes (line counts)
  local imm_pending=0 daily_pending=0
  [[ -f "$COMP_IMMEDIATE_QUEUE" ]] && imm_pending=$(wc -l < "$COMP_IMMEDIATE_QUEUE" | tr -d ' ')
  [[ -f "$COMP_DAILY_QUEUE" ]]     && daily_pending=$(wc -l < "$COMP_DAILY_QUEUE" | tr -d ' ')

  # Build per-brand summary by augmenting state with latest-report paths
  local by_brand
  by_brand=$(jq -c '
    to_entries | map({
      key: .key,
      value: (.value + {
        latest_report: null,
        latest_synthesis: null
      })
    }) | from_entries
  ' "$COMP_STATE_FILE" 2>/dev/null || echo "{}")

  # Inject latest report symlinks (looked up per-brand)
  local brands
  brands=$(echo "$by_brand" | jq -r 'keys[]')
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    local slug
    slug=$(printf '%s' "$b" | tr '[:upper:] /' '[:lower:]--' | tr -cd 'a-z0-9-_.')
    local latest="$COMP_REPORTS_DIR/latest-$slug.md"
    local synth=""
    if [[ -L "$latest" ]] || [[ -f "$latest" ]]; then
      local real
      real=$(readlink "$latest" 2>/dev/null || echo "$latest")
      [[ "$real" != /* ]] && real="$COMP_REPORTS_DIR/$real"
      synth="${real%.md}-synthesis.md"
      by_brand=$(echo "$by_brand" | jq -c --arg b "$b" --arg r "$real" --arg s "$synth" '
        .[$b].latest_report = $r
        | (if ($s | test("synthesis.md$")) and ($s | (test("/") | not) | not) then .[$b].latest_synthesis = $s else . end)
      ')
    fi
  done <<< "$brands"

  # Brand list
  local brands_array
  brands_array=$(echo "$by_brand" | jq -c 'keys')

  # High-severity events (full objects, capped at 20 most recent)
  local high_events
  high_events=$(echo "$events_json" | jq -c '
    [ .[] | select(.severity == "high") ] | sort_by(.timestamp) | reverse | .[0:20]
  ')

  # Counts
  local total med_count low_count
  total=$(echo "$events_json"     | jq 'length')
  med_count=$(echo "$events_json" | jq '[.[] | select(.severity == "med")] | length')
  low_count=$(echo "$events_json" | jq '[.[] | select(.severity == "low")] | length')

  # Final assembly
  jq -n \
    --argjson brands "$brands_array" \
    --argjson by_brand "$by_brand" \
    --argjson high "$high_events" \
    --argjson total "$total" \
    --argjson med "$med_count" \
    --argjson low "$low_count" \
    --argjson imm "$imm_pending" \
    --argjson daily "$daily_pending" \
    --argjson window "$window_days" \
    '{
      configured: true,
      brands: $brands,
      by_brand: $by_brand,
      events: {
        window_days: $window,
        total: $total,
        high: $high,
        med_count: $med,
        low_count: $low
      },
      queues: {
        immediate_pending: $imm,
        daily_pending: $daily
      }
    }'
}

# ── Convenience helpers (small, focused) ───────────────────────────────

# Print compact one-line summary for briefing surfaces (e.g. /ops:go).
# Output: "your-app: 2 alerts (last: competitor-a price drop) · 5 med deltas · weekly report 2026-05-17"
# or:     "(not configured — run /ops:setup competitor-intel)"
competitor_briefing_line() {
  local ctx; ctx=$(competitor_context "$@")
  if [[ "$(echo "$ctx" | jq -r '.configured')" != "true" ]]; then
    printf '%s' "(not configured)"
    return 0
  fi
  echo "$ctx" | jq -r '
    [
      (.brands[] as $b |
        ($b + ": " +
          (.events.high | map(select(.competitor as $c |
            ($c | type) == "string"
          )) | length | tostring) +
          " alerts · " +
          (.events.med_count | tostring) + " med deltas · last run " +
          (.by_brand[$b].last_run // "—")
        )
      )
    ] | join(" | ")
  '
}

# Get top-N high-severity events as terse bullet list (for /ops:next).
# Output: "- HIGH Noom pricing: price drop $69→$49/mo …\n- HIGH HealthifyMe …"
competitor_priority_items() {
  local n=5
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --top) n="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local ctx; ctx=$(competitor_context --severity high "$@")
  if [[ "$(echo "$ctx" | jq -r '.configured')" != "true" ]]; then
    return 0
  fi
  echo "$ctx" | jq -r --argjson n "$n" '
    .events.high[0:$n] | .[] |
    "- HIGH " + (.competitor // "?") + " " + (.source // "?") +
    ": " + ((.snippet // "") | .[0:160])
  '
}

# Get vertical-specific signal slice for /ops:marketing, /ops:ecom, /ops:yolo c-suite agents.
# Filters events by source kind groupings.
#   marketing  → pricing diffs, funding/news, brand sentiment from reddit/hn
#   ecom       → app store version+rating, product page diffs, new competitor launches
#   cfo        → pricing diffs only (money-token high severity)
#   ceo        → new entrants, competitor moves (med + high)
#   coo        → jobs feed (hiring signals)
#   cto        → changelog page-diffs, technical signals
competitor_vertical_slice() {
  local vertical="$1"
  shift
  local ctx; ctx=$(competitor_context "$@")
  if [[ "$(echo "$ctx" | jq -r '.configured')" != "true" ]]; then
    printf '[]'
    return 0
  fi
  case "$vertical" in
    marketing)
      echo "$ctx" | jq -c '
        [ (.events.high + (.events | .high)) | unique_by(.timestamp + .competitor) | .[] |
          select(.source == "page-diff" and (.kind // "") == "pricing"
              or .source == "reddit"
              or .source == "hn"
              or (.snippet // "" | test("funding|raised|series [A-D]"; "i"))
          )
        ]'
      ;;
    ecom)
      echo "$ctx" | jq -c '
        [ .events.high[] |
          select(.source == "appstore"
              or (.source == "page-diff" and (.kind // "" | test("features|pricing"))))
        ]'
      ;;
    cfo)
      echo "$ctx" | jq -c '
        [ .events.high[] |
          select(.source == "page-diff" and (.kind // "") == "pricing")
        ]'
      ;;
    ceo)
      echo "$ctx" | jq -c '
        [ .events.high[] |
          select((.snippet // "" | test("entrant|launch|raised|acquired"; "i"))
              or .source == "page-diff")
        ]'
      ;;
    coo)
      echo "$ctx" | jq -c '[ .events.high[] | select(.source == "jobs") ]'
      ;;
    cto)
      echo "$ctx" | jq -c '
        [ .events.high[] |
          select(.source == "page-diff" and (.kind // "" | test("changelog|features")))
        ]'
      ;;
    *)
      echo "$ctx" | jq -c '.events.high'
      ;;
  esac
}
