---
name: revenue-tracker
description: Revenue, billing, and credits analysis agent. Queries AWS Cost Explorer, checks credit balances, cross-references project revenue stages. Returns structured financial snapshot.
model: claude-sonnet-4-5
effort: medium
maxTurns: 20
tools:
  - Bash
  - Read
disallowedTools:
  - Write
  - Edit
  - Agent
---

# REVENUE TRACKER AGENT

Pull all financial data and return a structured snapshot. Read-only.

## Task

Run all AWS cost queries in parallel:

### Current month costs by service

```bash
aws ce get-cost-and-usage \
  --time-period "Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" "UsageQuantity" \
  --group-by "Type=DIMENSION,Key=SERVICE" \
  --output json 2>/dev/null
```

### Last 3 months trend

```bash
START=$(date -v-3m +%Y-%m-01 2>/dev/null || date -d "-3 months" +%Y-%m-01 2>/dev/null)
aws ce get-cost-and-usage \
  --time-period "Start=$START,End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --output json 2>/dev/null
```

### End-of-month forecast

```bash
LAST_DAY=$(date -v$(date +%-m)m -v+1m -v-1d +%Y-%m-%d 2>/dev/null || date -d "$(date +%Y-%m-01) +1 month -1 day" +%Y-%m-%d 2>/dev/null)
aws ce get-cost-forecast \
  --time-period "Start=$(date +%Y-%m-%d),End=$LAST_DAY" \
  --metric "UNBLENDED_COST" \
  --granularity MONTHLY \
  --output json 2>/dev/null
```

### Cost anomalies

```bash
aws ce get-anomalies \
  --date-interval "StartDate=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "-7 days" +%Y-%m-%d),EndDate=$(date +%Y-%m-%d)" \
  --output json 2>/dev/null || echo '{"Anomalies": []}'
```

### Project registry (revenue metadata)

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null | \
  jq '[.projects[] | {alias, name, revenue_stage: (.revenue_stage // "pre-revenue"), mrr: (.mrr // 0), arr: (.arr // 0)}]'
```

## Output format

```json
{
  "timestamp": "[ISO8601]",
  "current_month": {
    "to_date": 0.0,
    "forecast_eom": 0.0,
    "by_service": [{ "service": "[name]", "cost": 0.0, "pct": 0.0 }]
  },
  "trend": [{ "month": "[YYYY-MM]", "cost": 0.0 }],
  "mom_change_pct": 0.0,
  "anomalies": [],
  "credits": {
    "remaining": null,
    "expires": null,
    "note": "check AWS console"
  },
  "revenue": {
    "projects": [],
    "total_mrr": 0,
    "total_arr": 0
  },
  "burn_rate": {
    "monthly_aws": 0.0,
    "net_burn": 0.0,
    "runway_months_credits": null,
    "runway_months_cash": null
  },
  "top_cost_drivers": [
    { "service": "[name]", "cost": 0.0, "trend": "up|down|stable" }
  ]
}
```

Calculate `net_burn` as `monthly_aws - total_mrr`. Positive = burning money, negative = profitable.

Print only the JSON to stdout.
