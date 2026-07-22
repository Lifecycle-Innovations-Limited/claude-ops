---
name: ops-revenue
description: Revenue and costs tracker. AWS spend via aws ce, credits tracker, project revenue stages. Shows burn rate, runway estimate, credits expiring.
argument-hint: '[costs|revenue|credits|runway|all]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - WebFetch
  - Write
effort: low
maxTurns: 20
disallowedTools:
  - Edit
  - NotebookEdit
---

# OPS ► REVENUE & COSTS

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps correctly

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before the cost report

3. **Secrets**: AWS Cost Explorer requires credentials.
   ### Secret Resolution
   - AWS: check `$AWS_PROFILE` / `$AWS_ACCESS_KEY_ID` → `doppler secrets get AWS_ACCESS_KEY_ID --plain` → vault query cmd from prefs
   - If no credentials available, report "AWS costs unavailable — credentials not configured" and show only the revenue pipeline from registry

## CLI/API Reference

### AWS burn doctrine (CRITICAL — 2026-07-22)

**Never report plain `UnblendedCost` / `NetUnblendedCost` totals as "spend".**
Startup credits, SPP discounts, and Savings Plan negation make those nets ≈ $0
while real Usage burn is hundreds/day. **Always** use `RECORD_TYPE=Usage` for
burn, pace, spikes, runway, and Bedrock. Show credits only as a mask line.

Canonical helper (prefer this over raw `aws ce`):

```!
${CLAUDE_PLUGIN_ROOT}/scripts/aws-usage-cost.sh snapshot 2>/dev/null || echo '{}'
```

```!
${CLAUDE_PLUGIN_ROOT}/scripts/aws-usage-cost.sh all 2>/dev/null || true
```

| Command | Usage | Output |
| ------- | ----- | ------ |
| `scripts/aws-usage-cost.sh snapshot` | MTD/prev Usage burn + 7d daily + top services + credit mask | JSON |
| `scripts/aws-usage-cost.sh daily 7` | Last N days Usage totals | JSON array |
| `scripts/aws-usage-cost.sh by-service mtd` | MTD Usage by service | JSON array |
| `scripts/aws-usage-cost.sh record-types` | Credit / Usage / SP breakdown (mask only) | JSON array |
| `aws ce get-cost-and-usage … --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'` | Raw Usage-only CE (fallback if helper missing) | Cost JSON |
| `aws ce list-savings-plans-purchase-recommendation` | Savings plan recommendations | JSON |

---

## Phase 1 — Gather financial data in parallel

### FinOps dashboard — canonical revenue + burn

If `FINOPS_DASHBOARD_URL` and `FINOPS_OPS_API_TOKEN` are configured, the
dashboard is the single source of truth for per-project MRR, 30d revenue,
and current burn. Per-DBA breakdown comes from the Stripe revenue
snapshots ingested via `/api/ops/revenue`. Falls open to `{}` if unset —
the per-source AWS / RevenueCat queries below run as fallback.

**If the dashboard `current_month_spend` is ≈ $0 while Usage burn from
`aws-usage-cost.sh` is material, trust the helper** (dashboard may still be
credit-masked or ingest-empty). Always dual-check with the Usage helper.

```!
${CLAUDE_PLUGIN_ROOT}/scripts/finops-bridge.sh snapshot 2>/dev/null || echo "{}"
```

```!
${CLAUDE_PLUGIN_ROOT}/scripts/finops-bridge.sh revenue project 2>/dev/null || echo "{}"
```

When the dashboard returns data, render the per-project MRR section from
`groups[]` rather than from RevenueCat-only data.

### AWS costs — Usage burn (authoritative)

```!
${CLAUDE_PLUGIN_ROOT}/scripts/aws-usage-cost.sh snapshot 2>/dev/null || echo '{}'
```

Fallback if helper missing:

```bash
USAGE_FILTER='{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'
aws ce get-cost-and-usage \
  --time-period "Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --filter "$USAGE_FILTER" \
  --group-by "Type=DIMENSION,Key=SERVICE" \
  --output json 2>/dev/null
```

### AWS costs (last 3 months Usage trend)

```bash
USAGE_FILTER='{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'
aws ce get-cost-and-usage \
  --time-period "Start=$(date -v-3m +%Y-%m-01 2>/dev/null || date -d '3 months ago' +%Y-%m-01),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --filter "$USAGE_FILTER" \
  --output json 2>/dev/null
```

### AWS credits / discount mask (not spend)

```!
${CLAUDE_PLUGIN_ROOT}/scripts/aws-usage-cost.sh record-types 2>/dev/null || echo '[]'
```

```bash
aws ce list-savings-plans-purchase-recommendation --output json 2>/dev/null || echo '{}'
aws ce get-credits --output json 2>/dev/null || echo "credits API unavailable"
```

### AWS cost forecast (end of month)

Note: CE forecasts are often net-of-credits. Prefer `eom_pace` from
`aws-usage-cost.sh snapshot` (7d Usage avg × days in month) as the burn forecast.

```bash
aws ce get-cost-forecast \
  --time-period "Start=$(date +%Y-%m-%d),End=$(date +%Y-%m-28)" \
  --metric "UNBLENDED_COST" \
  --granularity MONTHLY \
  --output json 2>/dev/null
```
### Project registry (revenue stage)

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null | jq '[.projects[] | {alias, name, stage: (.revenue_stage // .revenue.stage // "pre-revenue"), mrr: (.mrr // 0), source: (.source // "git"), type: (.type // "repo")}]'
```

### External project revenue (Shopify, custom SaaS)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-external 2>/dev/null || echo '[]'
```

For Shopify projects showing `status: "healthy"`, pull GMV via Shopify Admin API:

```bash
# For each Shopify project in registry with valid credentials:
STORE_URL="[from project.shopify.store_url]"
TOKEN="[from env var named in project.shopify.credential_key]"
curl -s -H "X-Shopify-Access-Token: $TOKEN" \
  "https://$STORE_URL/admin/api/2024-10/orders.json?status=any&created_at_min=$(date -v-30d +%Y-%m-%dT00:00:00Z 2>/dev/null)&limit=250" 2>/dev/null
```

Include Shopify GMV in the revenue pipeline table with source=shopify.

---

## Phase 2 — Render dashboard

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► REVENUE & COSTS — [month]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AWS USAGE BURN (RECORD_TYPE=Usage — not credit-masked net)
 This month usage:    $[X]     ← from aws-usage-cost.sh mtd_usage
 Forecast (EOM pace): $[X]     ← eom_pace (7d Usage avg × days)
 Last month usage:    $[X]
 MoM change:          [+/-X%]
 7d avg/day:          $[X]

 Top services (Usage):
 [service]  $[X]  ([%] of usage)
 [service]  $[X]
 ...

CREDITS / MASK (do not report as low spend)
 Credits applied MTD:    $[X]  (record_types Credit)
 Discounts MTD:          $[X]
 Net after mask:         ~$0 is EXPECTED when credits cover burn
 Credits remaining:      $[X] (if API available)
 Expires:                [date]
 Months cover at pace:   [N]

REVENUE PIPELINE
 PROJECT        SOURCE     STAGE           MRR/GMV    STATUS
 ──────────────────────────────────────────────────────────────
 [project]      git        [stage]         $[X]       [status]
 [project]      shopify    [stage]         $[X] GMV   [status]
 [project]      custom     [stage]         $[X]       [status]
 ...
 ──────────────────────────────────────────────────────────────
 TOTAL MRR                                 $[X]
 TOTAL SHOPIFY GMV (30d)                   $[X]

RUNWAY ESTIMATE
 Monthly burn (AWS):  $[X]
 Total MRR:           $[X]
 Net burn:            $[X/month]
 Credits cover:       [N months]
 Cash runway:         [depends on external data]

──────────────────────────────────────────────────────
```

Use **batched AskUserQuestion calls** (max 4 options each):

AskUserQuestion call 1:

```
  [Drill into AWS costs by service]
  [Show cost anomalies (spike detection)]
  [Export cost report]
  [More...]
```

AskUserQuestion call 2 (only if "More..."):

```
  [Update project revenue stage]
  [Set budget alert]
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
