---
name: ops-revenue
description: Revenue and costs tracker. AWS spend via aws ce, credits tracker, project revenue stages. Shows burn rate, runway estimate, credits expiring.
argument-hint: "[costs|revenue|credits|runway|all]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - WebFetch
  - Write
---

# OPS ► REVENUE & COSTS

## CLI/API Reference

### aws CLI (Cost Explorer)

| Command | Usage | Output |
|---------|-------|--------|
| `aws ce get-cost-and-usage --time-period Start=<YYYY-MM-DD>,End=<YYYY-MM-DD> --granularity MONTHLY --metrics "UnblendedCost" --group-by "Type=DIMENSION,Key=SERVICE" --output json` | Cost by service | Cost JSON |
| `aws ce get-cost-and-usage --time-period Start=<YYYY-MM-DD>,End=<YYYY-MM-DD> --granularity MONTHLY --metrics "UnblendedCost" --output json` | Total cost | Cost JSON |
| `aws ce get-cost-forecast --time-period Start=<YYYY-MM-DD>,End=<YYYY-MM-DD> --metric "UNBLENDED_COST" --granularity MONTHLY --output json` | End-of-month forecast | Forecast JSON |
| `aws ce list-savings-plans-purchase-recommendation --output json` | Savings plan recommendations | JSON |

---

## Phase 1 — Gather financial data in parallel

### AWS costs (current month)

```bash
aws ce get-cost-and-usage \
  --time-period "Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by "Type=DIMENSION,Key=SERVICE" \
  --output json 2>/dev/null
```

### AWS costs (last 3 months trend)

```bash
aws ce get-cost-and-usage \
  --time-period "Start=$(date -v-3m +%Y-%m-01),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --output json 2>/dev/null
```

### AWS credits remaining

```bash
aws ce list-savings-plans-purchase-recommendation --output json 2>/dev/null || echo '{}'
aws ce get-credits --output json 2>/dev/null || echo "credits API unavailable"
```

### AWS cost forecast (end of month)

```bash
aws ce get-cost-forecast \
  --time-period "Start=$(date +%Y-%m-%d),End=$(date +%Y-%m-28)" \
  --metric "UNBLENDED_COST" \
  --granularity MONTHLY \
  --output json 2>/dev/null
```

### Project registry (revenue stage)

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null | jq '[.projects[] | {alias, name, stage: (.revenue_stage // "pre-revenue"), mrr: (.mrr // 0)}]'
```

---

## Phase 2 — Render dashboard

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► REVENUE & COSTS — [month]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AWS SPEND
 This month to date:  $[X]
 Forecast (EOM):      $[X]
 Last month:          $[X]
 MoM change:          [+/-X%]

 Top services:
 [service]  $[X]  ([%] of total)
 [service]  $[X]
 ...

CREDITS
 AWS credits remaining:  $[X]
 Expires:                [date]
 Burn rate at current:   [N months remaining]

REVENUE PIPELINE
 PROJECT        STAGE           MRR      STATUS
 ────────────────────────────────────────────────
 [project]      [stage]         $[X]     [status]
 ...
 ────────────────────────────────────────────────
 TOTAL MRR                      $[X]

RUNWAY ESTIMATE
 Monthly burn (AWS):  $[X]
 Total MRR:           $[X]
 Net burn:            $[X/month]
 Credits cover:       [N months]
 Cash runway:         [depends on external data]

──────────────────────────────────────────────────────
 Actions:
 a) Drill into AWS costs by service
 b) Show cost anomalies (spike detection)
 c) Export cost report
 d) Update project revenue stage
 e) Set budget alert

 → Type a letter or describe what you need
──────────────────────────────────────────────────────
```

---

## Route by `$ARGUMENTS`

| Argument | Action                       |
| -------- | ---------------------------- |
| costs    | Show only AWS cost breakdown |
| credits  | Show only credits and expiry |
| revenue  | Show only revenue pipeline   |
| runway   | Calculate and show runway    |
| (empty)  | Show full dashboard          |

Use AskUserQuestion after the dashboard for next action.

---

## Native tool usage

### WebFetch — billing API fallback

When `aws ce` commands fail or return incomplete data, use `WebFetch` to query the AWS Cost Explorer API directly. Also useful for fetching Stripe/billing provider data if configured.

### Write — export reports

When user selects "Export cost report" (option c), use `Write` to save the report as a dated file:
```
Write(file_path: "/tmp/ops-revenue-[date].md", content: "[formatted report]")
```
