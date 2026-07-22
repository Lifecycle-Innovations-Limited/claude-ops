#!/usr/bin/env bash
# aws-usage-cost.sh — real AWS burn (RECORD_TYPE=Usage), not credit-masked net.
#
# Doctrine (2026-07-22): Startup credits, SPP discounts, and Savings Plan
# negation make plain UnblendedCost / NetUnblendedCost totals ≈ $0 even when
# gross usage is hundreds/day. ALWAYS filter RECORD_TYPE=Usage for burn,
# pace, spikes, and Bedrock. Report credits only as a separate mask line.
#
# Usage:
#   aws-usage-cost.sh snapshot          # JSON: mtd_usage, prev_usage, daily[], top_services[], mask[]
#   aws-usage-cost.sh daily [N]         # last N days Usage totals (default 7)
#   aws-usage-cost.sh by-service [mtd|prev]
#   aws-usage-cost.sh record-types      # Credit / Usage / SP breakdown (mask)
#   aws-usage-cost.sh all               # human-readable brief for ops dashboards
#
# Env:
#   AWS_REGION / AWS_DEFAULT_REGION (default us-east-1 for CE — global service)
#   AWS_PROFILE
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
USAGE_FILTER='{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'

today() { date +%Y-%m-%d; }
month_start() { date +%Y-%m-01; }
# macOS date(1) first; GNU date fallback
days_ago() {
  local n="${1:-7}"
  date -v-"${n}"d +%Y-%m-%d 2>/dev/null || date -d "${n} days ago" +%Y-%m-%d
}
prev_month_start() {
  date -v-1m +%Y-%m-01 2>/dev/null || date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-%d
}
prev_month_end() { date +%Y-%m-01; }

ce() {
  aws ce get-cost-and-usage --region "$REGION" "$@" 2>/dev/null
}

cmd_daily() {
  local n="${1:-7}"
  local start end
  start=$(days_ago "$n")
  end=$(today)
  ce --time-period "Start=${start},End=${end}" \
    --granularity DAILY --metrics UnblendedCost \
    --filter "$USAGE_FILTER" --output json \
    | jq -c '[.ResultsByTime[] | {day: .TimePeriod.Start, usage: (.Total.UnblendedCost.Amount | tonumber)}]'
}

cmd_by_service() {
  local which="${1:-mtd}"
  local start end
  if [ "$which" = "prev" ]; then
    start=$(prev_month_start)
    end=$(prev_month_end)
  else
    start=$(month_start)
    end=$(today)
  fi
  ce --time-period "Start=${start},End=${end}" \
    --granularity MONTHLY --metrics UnblendedCost \
    --filter "$USAGE_FILTER" \
    --group-by Type=DIMENSION,Key=SERVICE --output json \
    | jq -c '[.ResultsByTime[0].Groups[]? | {service: .Keys[0], usage: (.Metrics.UnblendedCost.Amount | tonumber)}] | sort_by(-.usage)'
}

cmd_total() {
  local start="$1" end="$2"
  ce --time-period "Start=${start},End=${end}" \
    --granularity MONTHLY --metrics UnblendedCost \
    --filter "$USAGE_FILTER" --output json \
    | jq -r '.ResultsByTime[0].Total.UnblendedCost.Amount // "0"'
}

cmd_record_types() {
  local start end
  start=$(month_start)
  end=$(today)
  ce --time-period "Start=${start},End=${end}" \
    --granularity MONTHLY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=RECORD_TYPE --output json \
    | jq -c '[.ResultsByTime[0].Groups[]? | {type: .Keys[0], amount: (.Metrics.UnblendedCost.Amount | tonumber)}]'
}

cmd_snapshot() {
  local mtd prev daily top mask avg pace
  mtd=$(cmd_total "$(month_start)" "$(today)")
  prev=$(cmd_total "$(prev_month_start)" "$(prev_month_end)")
  daily=$(cmd_daily 7)
  top=$(cmd_by_service mtd | jq -c '.[0:10]')
  mask=$(cmd_record_types)
  avg=$(echo "$daily" | jq '[.[].usage] | if length>0 then (add/length) else 0 end')
  # pace: avg daily * days in month
  local dim
  dim=$(date -v+1m -v1d -v-1d +%d 2>/dev/null || date -d "$(date +%Y-%m-01) +1 month -1 day" +%d)
  pace=$(echo "$avg $dim" | awk '{printf "%.2f", $1*$2}')

  local credit_sum spp
  credit_sum=$(echo "$mask" | jq '[.[] | select(.type|test("Credit";"i")) | .amount] | add // 0')
  spp=$(echo "$mask" | jq '[.[] | select(.type|test("Solution Provider|Discount";"i")) | .amount] | add // 0')

  jq -n \
    --argjson mtd_usage "${mtd:-0}" \
    --argjson prev_usage "${prev:-0}" \
    --argjson daily "$daily" \
    --argjson top_services "$top" \
    --argjson record_types "$mask" \
    --argjson avg_daily_7d "$avg" \
    --argjson eom_pace "$pace" \
    --argjson credits_mtd "$credit_sum" \
    --argjson discounts_mtd "$spp" \
    --arg metric "UnblendedCost" \
    --arg filter "RECORD_TYPE=Usage" \
    --arg note "Credits mask net totals; burn = Usage only" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      generated_at: $generated_at,
      metric: $metric,
      filter: $filter,
      note: $note,
      mtd_usage: $mtd_usage,
      prev_month_usage: $prev_usage,
      avg_daily_7d: $avg_daily_7d,
      eom_pace: $eom_pace,
      credits_mtd: $credits_mtd,
      discounts_mtd: $discounts_mtd,
      daily: $daily,
      top_services: $top_services,
      record_types: $record_types
    }'
}

cmd_all() {
  local snap
  snap=$(cmd_snapshot) || { echo "AWS Cost Explorer unavailable"; return 1; }
  echo "$snap" | jq -r '
    "AWS USAGE BURN (RECORD_TYPE=Usage — not credit-masked net)",
    "  MTD usage:     $\(.mtd_usage | floor)",
    "  Prev month:    $\(.prev_month_usage | floor)",
    "  7d avg/day:    $\(.avg_daily_7d | . * 100 | floor / 100)",
    "  EOM pace:      $\(.eom_pace | floor)",
    "  Credits MTD:   $\(.credits_mtd | floor)  (mask — do not treat net $0 as low burn)",
    "  Top services:",
    (.top_services[0:5][] | "    \(.service): $\(.usage | floor)")
  '
}

main() {
  local sub="${1:-snapshot}"
  shift || true
  case "$sub" in
    snapshot) cmd_snapshot ;;
    daily) cmd_daily "${1:-7}" ;;
    by-service) cmd_by_service "${1:-mtd}" ;;
    record-types) cmd_record_types ;;
    all|brief) cmd_all ;;
    -h|--help|help)
      sed -n '2,20p' "$0"
      ;;
    *)
      echo "unknown subcommand: $sub" >&2
      exit 2
      ;;
  esac
}

main "$@"
