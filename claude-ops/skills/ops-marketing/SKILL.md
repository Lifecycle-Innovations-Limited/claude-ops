---
name: ops-marketing
description: Marketing command center. Email campaigns (Klaviyo), paid ads (Meta/Google), analytics (GA4), SEO, and social media metrics. One dashboard for all marketing channels.
argument-hint: "[email|ads|analytics|seo|social|campaigns|setup]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - Agent
  - TeamCreate
  - SendMessage
  - AskUserQuestion
  - WebFetch
  - WebSearch
effort: medium
maxTurns: 40
---

# OPS ► MARKETING COMMAND CENTER

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps correctly
   - `klaviyo_private_key`, `meta_ads_token`, `meta_ad_account_id`, `ga4_property_id`, `google_search_console_site` — check userConfig keys before env vars
   - `google_ads_developer_token`, `google_ads_client_id`, `google_ads_client_secret`, `google_ads_refresh_token`, `google_ads_customer_id`, `google_ads_login_customer_id` — Google Ads credentials

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before running any channel queries

3. **Secrets**: Resolve API keys via userConfig → env vars → Doppler (see Credential Resolution section below)

## CLI/API Reference

### Klaviyo REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://a.klaviyo.com/api/lists/?fields[list]=name,id,profile_count` | GET | All lists + subscriber counts |
| `https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,'email')&sort=-created_at` | GET | Recent campaigns |
| `https://a.klaviyo.com/api/flows/?filter=equals(status,'live')` | GET | Active flows |
| `https://a.klaviyo.com/api/metrics/` | GET | Available metrics |

**Auth header**: `Authorization: Klaviyo-API-Key ${KLAVIYO_KEY}` | **Revision header**: `revision: 2024-10-15`

### Meta Graph API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://graph.facebook.com/v18.0/${META_ACCOUNT}/insights?fields=spend,...&date_preset=last_7d` | GET | Account-level ad spend |
| `https://graph.facebook.com/v18.0/${META_ACCOUNT}/campaigns?fields=name,status,insights{...}` | GET | Campaign breakdown |
| `https://graph.facebook.com/v18.0/me/accounts?fields=instagram_business_account` | GET | Linked Instagram account |

**Auth header**: `Authorization: Bearer ${META_TOKEN}`

### Google Analytics 4 (Data API)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport` | POST | Run custom report |

**Auth**: gcloud ADC — `GA4_TOKEN=$(gcloud auth application-default print-access-token)`

### Google Search Console

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://searchconsole.googleapis.com/webmasters/v3/sites/${GSC_SITE_ENCODED}/searchAnalytics/query` | POST | Search performance data |

**Auth**: Same gcloud ADC token as GA4

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when gathering channel data in parallel. This enables:
- Agents share context and can coordinate mid-flight
- You can steer priorities in real-time
- Agents report progress as they complete

**Team setup** (only when flag is enabled):
```
TeamCreate("marketing-team")
Agent(team_name="marketing-team", name="email-metrics", prompt="Pull Klaviyo subscriber counts, campaign stats, and flow metrics")
Agent(team_name="marketing-team", name="ads-metrics", prompt="Pull Meta Ads spend, ROAS, and campaign breakdown")
Agent(team_name="marketing-team", name="analytics-metrics", prompt="Pull GA4 sessions, conversions, and traffic sources")
Agent(team_name="marketing-team", name="seo-metrics", prompt="Pull Search Console clicks, impressions, and top queries")
```

If the flag is NOT set, use standard fire-and-forget subagents.

## Credential Resolution

Resolve credentials in this order for each service:

### Klaviyo
```bash
KLAVIYO_KEY="${KLAVIYO_PRIVATE_KEY:-$(claude plugin config get klaviyo_private_key 2>/dev/null)}"
if [ -z "$KLAVIYO_KEY" ]; then
  KLAVIYO_KEY="$(doppler secrets get KLAVIYO_PRIVATE_KEY --plain 2>/dev/null)"
fi
```

### Meta Ads
```bash
META_TOKEN="${META_ADS_TOKEN:-$(claude plugin config get meta_ads_token 2>/dev/null)}"
META_ACCOUNT="${META_AD_ACCOUNT_ID:-$(claude plugin config get meta_ad_account_id 2>/dev/null)}"
if [ -z "$META_TOKEN" ]; then
  META_TOKEN="$(doppler secrets get META_ADS_TOKEN --plain 2>/dev/null)"
fi
```

### GA4
```bash
GA4_PROPERTY="${GA4_PROPERTY_ID:-$(claude plugin config get ga4_property_id 2>/dev/null)}"
# GA4 uses gcloud application default credentials — check if configured:
gcloud auth application-default print-access-token 2>/dev/null
```

### Google Search Console
```bash
GSC_SITE="${GOOGLE_SEARCH_CONSOLE_SITE:-$(claude plugin config get google_search_console_site 2>/dev/null)}"
# Uses same gcloud ADC as GA4
```

### Google Ads

```bash
GADS_API_VERSION="v23"
GADS_DEV_TOKEN="${GOOGLE_ADS_DEVELOPER_TOKEN:-$(claude plugin config get google_ads_developer_token 2>/dev/null)}"
GADS_CLIENT_ID="${GOOGLE_ADS_CLIENT_ID:-$(claude plugin config get google_ads_client_id 2>/dev/null)}"
GADS_CLIENT_SECRET="${GOOGLE_ADS_CLIENT_SECRET:-$(claude plugin config get google_ads_client_secret 2>/dev/null)}"
GADS_REFRESH_TOKEN="${GOOGLE_ADS_REFRESH_TOKEN:-$(claude plugin config get google_ads_refresh_token 2>/dev/null)}"
GADS_CUSTOMER_ID="${GOOGLE_ADS_CUSTOMER_ID:-$(claude plugin config get google_ads_customer_id 2>/dev/null)}"
GADS_LOGIN_CUSTOMER_ID="${GOOGLE_ADS_LOGIN_CUSTOMER_ID:-$(claude plugin config get google_ads_login_customer_id 2>/dev/null)}"

# Doppler fallback
if [ -z "$GADS_REFRESH_TOKEN" ]; then
  GADS_REFRESH_TOKEN="$(doppler secrets get GOOGLE_ADS_REFRESH_TOKEN --plain 2>/dev/null)"
fi
if [ -z "$GADS_DEV_TOKEN" ]; then
  GADS_DEV_TOKEN="$(doppler secrets get GOOGLE_ADS_DEVELOPER_TOKEN --plain 2>/dev/null)"
fi

# Strip dashes from customer ID (API requires no dashes)
GADS_CUSTOMER_ID="${GADS_CUSTOMER_ID//-/}"

# Refresh access token (expires in ~1 hour — always refresh before API calls)
GADS_ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data "client_id=${GADS_CLIENT_ID}" \
  --data "client_secret=${GADS_CLIENT_SECRET}" \
  --data "refresh_token=${GADS_REFRESH_TOKEN}" \
  --data "grant_type=refresh_token" | jq -r '.access_token')

# Common headers for all Google Ads API calls
GADS_HEADERS=(-H "Content-Type: application/json" -H "Authorization: Bearer ${GADS_ACCESS_TOKEN}" -H "developer-token: ${GADS_DEV_TOKEN}")
if [ -n "$GADS_LOGIN_CUSTOMER_ID" ]; then
  GADS_HEADERS+=(-H "login-customer-id: ${GADS_LOGIN_CUSTOMER_ID}")
fi
```

---

## Sub-command Routing

Route `$ARGUMENTS` to the correct section below:

| Input | Action |
|---|---|
| (empty), dashboard | Run full marketing dashboard |
| email, klaviyo | Klaviyo email metrics |
| ads, meta | Meta Ads performance |
| google-ads, gads | Google Ads dashboard + campaign management (see ## google-ads section) |
| analytics, ga4 | GA4 sessions + conversions |
| seo, gsc | Search Console metrics |
| social | Social media aggregator |
| campaigns | Cross-channel campaign overview |
| setup | Configure API keys |

---

## email / klaviyo

Pull Klaviyo metrics for last 30 days.

### Subscriber count
```bash
curl -s "https://a.klaviyo.com/api/lists/?fields[list]=name,id,profile_count" \
  -H "Authorization: Klaviyo-API-Key ${KLAVIYO_KEY}" \
  -H "revision: 2024-10-15" | jq '.data[] | {name: .attributes.name, id: .id, count: .attributes.profile_count}'
```

### Recent campaigns (last 10)
```bash
curl -s "https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,'email')&sort=-created_at&page[size]=10&fields[campaign]=name,status,created_at,send_time" \
  -H "Authorization: Klaviyo-API-Key ${KLAVIYO_KEY}" \
  -H "revision: 2024-10-15" | jq '.data[] | {name: .attributes.name, status: .attributes.status, sent: .attributes.send_time}'
```

### Flow metrics (active flows)
```bash
curl -s "https://a.klaviyo.com/api/flows/?filter=equals(status,'live')&fields[flow]=name,status,created,trigger_type" \
  -H "Authorization: Klaviyo-API-Key ${KLAVIYO_KEY}" \
  -H "revision: 2024-10-15" | jq '.data[] | {name: .attributes.name, trigger: .attributes.trigger_type}'
```

### Key email metrics (opens, clicks, revenue via metric aggregates)
```bash
# Get metric IDs first
curl -s "https://a.klaviyo.com/api/metrics/" \
  -H "Authorization: Klaviyo-API-Key ${KLAVIYO_KEY}" \
  -H "revision: 2024-10-15" | jq '.data[] | select(.attributes.name | test("Opened Email|Clicked Email|Placed Order")) | {name: .attributes.name, id: .id}'
```

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EMAIL (KLAVIYO) — last 30d
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Lists:        [list_name] — [N] subscribers
 Campaigns:    [N sent] | [N drafts]
 Active Flows: [N]

 RECENT CAMPAIGNS
 [name]  [status]  sent [date]
 ...
```

---

## ads / meta

Pull Meta Ads insights for the configured ad account.

### Account-level spend (last 7 days)
```bash
curl -s "https://graph.facebook.com/v18.0/${META_ACCOUNT}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,action_values&date_preset=last_7d&level=account" \
  -H "Authorization: Bearer ${META_TOKEN}" | jq '{spend: .data[0].spend, impressions: .data[0].impressions, clicks: .data[0].clicks, ctr: .data[0].ctr, cpc: .data[0].cpc}'
```

### Campaign breakdown (last 7 days)
```bash
curl -s "https://graph.facebook.com/v18.0/${META_ACCOUNT}/campaigns?fields=name,status,daily_budget,lifetime_budget,insights{spend,impressions,clicks,actions,action_values}&date_preset=last_7d" \
  -H "Authorization: Bearer ${META_TOKEN}" | jq '.data[] | {name: .name, status: .status, spend: .insights.data[0].spend}'
```

### ROAS calculation
From `action_values` array: extract `action_type == "purchase"` value, divide by spend.

### Top performing ads (last 7d)
```bash
curl -s "https://graph.facebook.com/v18.0/${META_ACCOUNT}/ads?fields=name,adset_id,insights{spend,impressions,clicks,actions,action_values,ctr,cpc}&date_preset=last_7d&limit=10" \
  -H "Authorization: Bearer ${META_TOKEN}" | jq '.data | sort_by(.insights.data[0].spend | tonumber) | reverse | .[0:5] | .[] | {name: .name, spend: .insights.data[0].spend, ctr: .insights.data[0].ctr}'
```

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 META ADS — last 7d
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Spend:       $[X]
 ROAS:        [X]x
 Purchases:   [N]  ($[X] revenue)
 Impressions: [N]  CTR: [X]%
 CPC:         $[X]

 CAMPAIGNS
 [name]  [status]  $[spend]  [roas]x ROAS
 ...

 TOP ADS (by spend)
 [name]  $[spend]  [ctr]% CTR
```

---

## analytics / ga4

Pull GA4 data via the Data API using gcloud ADC.

### Get access token
```bash
GA4_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
```

### Sessions + conversions (last 7d)
```bash
curl -s -X POST "https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport" \
  -H "Authorization: Bearer ${GA4_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
    "metrics": [
      {"name": "sessions"},
      {"name": "totalUsers"},
      {"name": "conversions"},
      {"name": "totalRevenue"},
      {"name": "bounceRate"},
      {"name": "averageSessionDuration"}
    ]
  }' | jq '.rows[0].metricValues | {sessions: .[0].value, users: .[1].value, conversions: .[2].value, revenue: .[3].value, bounce_rate: .[4].value}'
```

### Traffic sources (last 7d)
```bash
curl -s -X POST "https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport" \
  -H "Authorization: Bearer ${GA4_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
    "dimensions": [{"name": "sessionDefaultChannelGrouping"}],
    "metrics": [{"name": "sessions"}, {"name": "conversions"}],
    "orderBys": [{"metric": {"metricName": "sessions"}, "desc": true}],
    "limit": 8
  }' | jq '.rows[] | {channel: .dimensionValues[0].value, sessions: .metricValues[0].value, conversions: .metricValues[1].value}'
```

### Top pages (last 7d)
```bash
curl -s -X POST "https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport" \
  -H "Authorization: Bearer ${GA4_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
    "dimensions": [{"name": "pagePath"}],
    "metrics": [{"name": "screenPageViews"}, {"name": "averageSessionDuration"}],
    "orderBys": [{"metric": {"metricName": "screenPageViews"}, "desc": true}],
    "limit": 10
  }' | jq '.rows[] | {page: .dimensionValues[0].value, views: .metricValues[0].value}'
```

If `GA4_TOKEN` is empty or gcloud not available, output: `GA4 not configured — run /ops:marketing setup or configure gcloud ADC`.

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ANALYTICS (GA4) — last 7d
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Sessions:     [N]     Users: [N]
 Conversions:  [N]     CVR:   [X]%
 Revenue:      $[X]
 Bounce Rate:  [X]%    Avg Session: [Xm Xs]

 TRAFFIC SOURCES
 [channel]  [N sessions]  [N conversions]
 ...

 TOP PAGES
 [path]  [N views]
```

---

## seo / gsc

Pull Google Search Console data.

### Get access token (same gcloud ADC)
```bash
GSC_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
GSC_SITE_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${GSC_SITE}', safe=''))" 2>/dev/null || echo "${GSC_SITE}" | sed 's|:|%3A|g; s|/|%2F|g')
```

### Search performance (last 28 days)
```bash
curl -s -X POST "https://searchconsole.googleapis.com/webmasters/v3/sites/${GSC_SITE_ENCODED}/searchAnalytics/query" \
  -H "Authorization: Bearer ${GSC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "'$(date -v-28d +%Y-%m-%d 2>/dev/null || date -d '28 days ago' +%Y-%m-%d)'",
    "endDate": "'$(date +%Y-%m-%d)'",
    "dimensions": [],
    "rowLimit": 1
  }' | jq '{clicks: .rows[0].clicks, impressions: .rows[0].impressions, ctr: .rows[0].ctr, position: .rows[0].position}'
```

### Top queries (last 28 days)
```bash
curl -s -X POST "https://searchconsole.googleapis.com/webmasters/v3/sites/${GSC_SITE_ENCODED}/searchAnalytics/query" \
  -H "Authorization: Bearer ${GSC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "'$(date -v-28d +%Y-%m-%d 2>/dev/null || date -d '28 days ago' +%Y-%m-%d)'",
    "endDate": "'$(date +%Y-%m-%d)'",
    "dimensions": ["query"],
    "rowLimit": 20,
    "dimensionFilterGroups": []
  }' | jq '.rows[] | {query: .keys[0], clicks: .clicks, impressions: .impressions, position: (.position | floor)}'
```

### Top pages by clicks
```bash
curl -s -X POST "https://searchconsole.googleapis.com/webmasters/v3/sites/${GSC_SITE_ENCODED}/searchAnalytics/query" \
  -H "Authorization: Bearer ${GSC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "'$(date -v-28d +%Y-%m-%d 2>/dev/null || date -d '28 days ago' +%Y-%m-%d)'",
    "endDate": "'$(date +%Y-%m-%d)'",
    "dimensions": ["page"],
    "rowLimit": 10
  }' | jq '.rows[] | {page: .keys[0], clicks: .clicks, impressions: .impressions, position: (.position | floor)}'
```

If GSC not configured, output: `Search Console not configured — run /ops:marketing setup`.

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SEO (SEARCH CONSOLE) — last 28d
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Clicks:       [N]
 Impressions:  [N]
 CTR:          [X]%
 Avg Position: [X]

 TOP QUERIES
 [query]  [clicks] clicks  pos [N]
 ...

 TOP PAGES
 [url]  [clicks] clicks  [impressions] impr
```

---

## social

Aggregate available social media metrics. Check which are configured.

### Instagram (via Meta Graph API — same token as Meta Ads)
```bash
# Get Instagram Business Account ID linked to the ad account
curl -s "https://graph.facebook.com/v18.0/me/accounts?fields=instagram_business_account" \
  -H "Authorization: Bearer ${META_TOKEN}" | jq '.data[].instagram_business_account.id' 2>/dev/null

# Then pull media insights
curl -s "https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}?fields=followers_count,media_count,profile_views" \
  -H "Authorization: Bearer ${META_TOKEN}" | jq '{followers: .followers_count, posts: .media_count, profile_views: .profile_views}'
```

### YouTube (if configured via gcloud)
```bash
YT_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
curl -s "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true" \
  -H "Authorization: Bearer ${YT_TOKEN}" | jq '.items[0].statistics | {subscribers: .subscriberCount, views: .viewCount, videos: .videoCount}'
```

Show `[not configured]` for any unconfigured channels rather than failing.

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SOCIAL MEDIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Instagram:  [N followers]  [N posts]  [N profile views]
 YouTube:    [N subscribers]  [N total views]
 TikTok:     [not configured] — set TIKTOK_ACCESS_TOKEN
```

---

## google-ads

**Credential check**: If `GADS_DEV_TOKEN` or `GADS_REFRESH_TOKEN` is empty after resolution, print:
`Warning: Google Ads not configured. Run /ops:setup marketing to set up credentials.`
and stop.

**Token refresh**: Run the access token refresh curl (from Credential Resolution above) at the start of every google-ads invocation. If `GADS_ACCESS_TOKEN` is null or "null", print:
`Warning: Google Ads token refresh failed. Check client_id/client_secret/refresh_token in /ops:setup.`
and stop.

Route `$ARGUMENTS` within the google-ads section:

| Input | Action |
|---|---|
| (empty), dashboard, overview | Campaign performance dashboard (last 7 days) |
| search-terms, terms | Search Terms Report with negative keyword candidates (last 30 days) |
| budget-recs, recommendations, recs | Budget optimization recommendations from Google |
| campaigns, manage | Campaign management — list, create, pause, enable, adjust budget |
| keywords, kw, keyword-planner | Keyword Planner — discover keywords with volume and bid data |
| ad-groups, ag | Ad group management — list, create, add/remove keywords, adjust bids |

### Dashboard (default — no args, `dashboard`, `overview`)

```bash
# Campaign performance — last 7 days
CAMPAIGNS=$(curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary '{
    "query": "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != REMOVED ORDER BY metrics.cost_micros DESC LIMIT 20"
  }')

# Check for API error
GADS_ERROR=$(echo "$CAMPAIGNS" | jq -r '.[0].error.message // empty' 2>/dev/null)
if [ -n "$GADS_ERROR" ]; then
  echo "Google Ads API error: ${GADS_ERROR}"
  echo "Check credentials with /ops:marketing setup."
  exit 0
fi

# Check for empty results
CAMPAIGN_COUNT=$(echo "$CAMPAIGNS" | jq '[.[].results[]?] | length' 2>/dev/null || echo "0")
if [ "$CAMPAIGN_COUNT" -eq 0 ]; then
  echo "No active campaigns found in the last 7 days."
  exit 0
fi

# Compute totals
TOTAL_SPEND=$(echo "$CAMPAIGNS" | jq '[.[].results[]?.metrics.costMicros // "0" | tonumber] | add / 1000000' 2>/dev/null)
TOTAL_CONVERSIONS=$(echo "$CAMPAIGNS" | jq '[.[].results[]?.metrics.conversions // "0" | tonumber] | add' 2>/dev/null)
TOTAL_VALUE=$(echo "$CAMPAIGNS" | jq '[.[].results[]?.metrics.conversionsValue // "0" | tonumber] | add' 2>/dev/null)
OVERALL_ROAS=$(awk "BEGIN { if (${TOTAL_SPEND:-0} > 0) printf \"%.2f\", ${TOTAL_VALUE:-0} / ${TOTAL_SPEND:-1}; else print \"—\" }")
TOTAL_SPEND_FMT=$(awk "BEGIN { printf \"%.2f\", ${TOTAL_SPEND:-0} }")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GOOGLE ADS — Last 7 Days"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Total Spend: \$${TOTAL_SPEND_FMT}"
echo "Total Conversions: ${TOTAL_CONVERSIONS}"
echo "Overall ROAS: ${OVERALL_ROAS}"
echo ""

# Print table header
printf "| %-30s | %-8s | %-10s | %-10s | %-8s | %-8s | %-6s | %-6s | %-6s |\n" \
  "Campaign" "Status" "Budget/day" "Spend" "Impr" "Clicks" "CTR" "Conv" "ROAS"
printf "|%s|%s|%s|%s|%s|%s|%s|%s|%s|\n" \
  "--------------------------------" "----------" "------------" "------------" "----------" "----------" "--------" "--------" "--------"

# Print each campaign row
echo "$CAMPAIGNS" | jq -r '.[].results[]? | [
  .campaign.name,
  .campaign.status,
  (.campaignBudget.amountMicros // "0" | tonumber / 1000000),
  (.metrics.costMicros // "0" | tonumber / 1000000),
  (.metrics.impressions // "0" | tonumber),
  (.metrics.clicks // "0" | tonumber),
  (.metrics.conversions // "0" | tonumber),
  (.metrics.conversionsValue // "0" | tonumber),
  (.metrics.costMicros // "0" | tonumber)
] | @tsv' 2>/dev/null | while IFS=$'\t' read -r name status budget_raw spend_raw impr_raw clicks_raw conv_raw value_raw cost_raw; do
  BUDGET=$(awk "BEGIN { printf \"%.2f\", ${budget_raw:-0} }")
  SPEND=$(awk "BEGIN { printf \"%.2f\", ${spend_raw:-0} }")
  CTR=$(awk "BEGIN { if (${impr_raw:-0} > 0) printf \"%.2f\", ${clicks_raw:-0} / ${impr_raw:-0} * 100; else print \"0.00\" }")
  ROAS=$(awk "BEGIN { if (${spend_raw:-0} > 0) printf \"%.2f\", ${value_raw:-0} / ${spend_raw:-1}; else print \"—\" }")
  printf "| %-30s | %-8s | \$%-9s | \$%-9s | %-8s | %-8s | %-5s%% | %-6s | %-6s |\n" \
    "${name:0:30}" "$status" "$BUDGET" "$SPEND" "$impr_raw" "$clicks_raw" "$CTR" "$conv_raw" "$ROAS"
done
```

### Search Terms (`search-terms`, `terms`)

```bash
SEARCH_TERMS=$(curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary '{
    "query": "SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.impressions > 0 ORDER BY metrics.impressions DESC LIMIT 100"
  }')

# Check for API error
GADS_ST_ERROR=$(echo "$SEARCH_TERMS" | jq -r '.[0].error.message // empty' 2>/dev/null)
if [ -n "$GADS_ST_ERROR" ]; then
  echo "Google Ads API error: ${GADS_ST_ERROR}"
  echo "Check credentials with /ops:marketing setup."
  exit 0
fi

TERM_COUNT=$(echo "$SEARCH_TERMS" | jq '[.[].results[]?] | length' 2>/dev/null || echo "0")
if [ "$TERM_COUNT" -eq 0 ]; then
  echo "No search term data found for the last 30 days."
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SEARCH TERMS REPORT — Last 30 Days"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

printf "| %-30s | %-10s | %-20s | %-15s | %-6s | %-6s | %-7s | %-6s |\n" \
  "Search Term" "Status" "Campaign" "Ad Group" "Impr" "Clicks" "Cost" "Conv"
printf "|%s|%s|%s|%s|%s|%s|%s|%s|\n" \
  "--------------------------------" "------------" "----------------------" "-----------------" "--------" "--------" "---------" "--------"

# Status mapping and table rows
echo "$SEARCH_TERMS" | jq -r '.[].results[]? | [
  .searchTermView.searchTerm,
  .searchTermView.status,
  .campaign.name,
  .adGroup.name,
  (.metrics.impressions // "0" | tostring),
  (.metrics.clicks // "0" | tostring),
  (.metrics.costMicros // "0" | tonumber / 1000000 | tostring),
  (.metrics.conversions // "0" | tostring)
] | @tsv' 2>/dev/null | while IFS=$'\t' read -r term status campaign adgroup impr clicks cost_raw conv; do
  case "$status" in
    ADDED)    STATUS_LABEL="✓ Added"   ;;
    EXCLUDED) STATUS_LABEL="✗ Excluded" ;;
    *)        STATUS_LABEL="○ New"     ;;
  esac
  COST=$(awk "BEGIN { printf \"%.2f\", ${cost_raw:-0} }")
  printf "| %-30s | %-10s | %-20s | %-15s | %-6s | %-6s | \$%-6s | %-6s |\n" \
    "${term:0:30}" "$STATUS_LABEL" "${campaign:0:20}" "${adgroup:0:15}" "$impr" "$clicks" "$COST" "$conv"
done

echo ""
echo "Negative keyword candidates (high spend, zero conversions):"

echo "$SEARCH_TERMS" | jq -r '.[].results[]? | select(
  (.metrics.conversions // "0" | tonumber) == 0 and
  (.metrics.costMicros // "0" | tonumber) > 1000000
) | "  • \(.searchTermView.searchTerm) — $\(.metrics.costMicros | tonumber / 1000000 | tostring | split(".") | .[0] + "." + (.[1] // "00")[0:2])"' 2>/dev/null || echo "  (none found)"
```

### Budget Recommendations (`budget-recs`, `recommendations`, `recs`)

```bash
RECS=$(curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary '{
    "query": "SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.impact, recommendation.campaign_budget_recommendation FROM recommendation WHERE recommendation.type IN (CAMPAIGN_BUDGET, MOVE_UNUSED_BUDGET, MARGINAL_ROI_CAMPAIGN_BUDGET, FORECASTING_CAMPAIGN_BUDGET)"
  }')

# Check for API error
GADS_REC_ERROR=$(echo "$RECS" | jq -r '.[0].error.message // empty' 2>/dev/null)
if [ -n "$GADS_REC_ERROR" ]; then
  echo "Google Ads API error: ${GADS_REC_ERROR}"
  echo "Check credentials with /ops:marketing setup."
  exit 0
fi

REC_COUNT=$(echo "$RECS" | jq '[.[].results[]?] | length' 2>/dev/null || echo "0")
if [ "$REC_COUNT" -eq 0 ]; then
  echo "No budget recommendations available. Google needs campaign data to generate recommendations."
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  BUDGET RECOMMENDATIONS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

printf "| %-22s | %-25s | %-15s | %-13s | %-20s |\n" \
  "Type" "Campaign" "Current Budget" "Recommended" "Impact"
printf "|%s|%s|%s|%s|%s|\n" \
  "------------------------" "---------------------------" "-----------------" "---------------" "----------------------"

echo "$RECS" | jq -r '.[].results[]? | [
  .recommendation.type,
  .recommendation.campaign,
  (.recommendation.campaignBudgetRecommendation.currentBudgetAmountMicros // "0" | tonumber / 1000000 | tostring),
  (.recommendation.campaignBudgetRecommendation.recommendedBudgetAmountMicros // "0" | tonumber / 1000000 | tostring),
  (.recommendation.impact.baseMetrics.impressions // "0" | tonumber | tostring),
  (.recommendation.impact.potentialMetrics.impressions // "0" | tonumber | tostring)
] | @tsv' 2>/dev/null | while IFS=$'\t' read -r rec_type campaign current_raw recommended_raw base_impr_raw pot_impr_raw; do
  case "$rec_type" in
    CAMPAIGN_BUDGET)             TYPE_LABEL="Increase Budget"      ;;
    MOVE_UNUSED_BUDGET)          TYPE_LABEL="Move Unused Budget"   ;;
    MARGINAL_ROI_CAMPAIGN_BUDGET) TYPE_LABEL="Marginal ROI"        ;;
    FORECASTING_CAMPAIGN_BUDGET) TYPE_LABEL="Forecasting"          ;;
    *)                           TYPE_LABEL="$rec_type"            ;;
  esac
  CURRENT=$(awk "BEGIN { printf \"%.2f\", ${current_raw:-0} }")
  RECOMMENDED=$(awk "BEGIN { printf \"%.2f\", ${recommended_raw:-0} }")
  IMPACT=$(awk "BEGIN {
    base = ${base_impr_raw:-0}; pot = ${pot_impr_raw:-0}
    if (base > 0) printf \"+%.0f%% impressions\", (pot - base) / base * 100
    else print \"—\"
  }")
  printf "| %-22s | %-25s | \$%-14s | \$%-12s | %-20s |\n" \
    "$TYPE_LABEL" "${campaign:0:25}" "$CURRENT" "$RECOMMENDED" "$IMPACT"
done
```

### Campaign Management (`campaigns`, `manage`)

**List campaigns:**

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary '{
    "query": "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != REMOVED ORDER BY campaign.name LIMIT 50"
  }'
```

Output as table:
```
| # | Campaign ID | Name | Status | Channel | Budget/day |
```

**Create campaign** (`campaigns create`):

Collect from user via AskUserQuestion (free text, one at a time):
1. Campaign name
2. Daily budget in dollars (convert to micros: `BUDGET_MICROS=$(awk "BEGIN {printf \"%d\", $DOLLARS * 1000000}")`)
3. Channel type — AskUserQuestion with options: `[Search, Display, Shopping, Video]`
   Map to API values: `SEARCH`, `DISPLAY`, `SHOPPING`, `VIDEO`

Two-step mutate:

Step 1 — Create budget:
```bash
BUDGET_RESP=$(curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/campaignBudgets:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"create\": {
        \"name\": \"Budget for ${CAMPAIGN_NAME}\",
        \"deliveryMethod\": \"STANDARD\",
        \"amountMicros\": \"${BUDGET_MICROS}\"
      }
    }]
  }")
BUDGET_RESOURCE=$(echo "$BUDGET_RESP" | jq -r '.results[0].resourceName')
```

Step 2 — Create campaign (always in PAUSED status for safety):
```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/campaigns:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"create\": {
        \"name\": \"${CAMPAIGN_NAME}\",
        \"campaignBudget\": \"${BUDGET_RESOURCE}\",
        \"advertisingChannelType\": \"${CHANNEL_TYPE}\",
        \"status\": \"PAUSED\",
        \"manualCpc\": {},
        \"networkSettings\": {
          \"targetGoogleSearch\": true,
          \"targetSearchNetwork\": true,
          \"targetContentNetwork\": false
        }
      }
    }]
  }"
```

Print: `✓ Campaign "${CAMPAIGN_NAME}" created (status: PAUSED, budget: $XX.XX/day). Enable it with: /ops:marketing google-ads campaigns enable <ID>`

If error, parse `error.message` from response and display.

**Pause campaign** (`campaigns pause <ID>`):

⚠ **Rule 5 — confirm before pausing** via AskUserQuestion: `"Pause campaign <NAME> (ID: <ID>)?"` with options `[Pause, Cancel]`.

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/campaigns:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"update\": {
        \"resourceName\": \"customers/${GADS_CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}\",
        \"status\": \"PAUSED\"
      },
      \"updateMask\": \"status\"
    }]
  }"
```

Print: `✓ Campaign <NAME> paused.`

**Enable campaign** (`campaigns enable <ID>`):

Same as pause but `"status": "ENABLED"`. No confirmation needed (enabling is not destructive).

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/campaigns:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"update\": {
        \"resourceName\": \"customers/${GADS_CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}\",
        \"status\": \"ENABLED\"
      },
      \"updateMask\": \"status\"
    }]
  }"
```

Print: `✓ Campaign <NAME> enabled.`

**Adjust budget** (`campaigns budget <ID> <AMOUNT>`):

First, fetch the campaign's current budget resource name:
```bash
CAMPAIGN_DATA=$(curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{\"query\": \"SELECT campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${CAMPAIGN_ID}\"}")
BUDGET_RESOURCE=$(echo "$CAMPAIGN_DATA" | jq -r '.[0].results[0].campaign.campaignBudget // empty')
CURRENT_BUDGET_MICROS=$(echo "$CAMPAIGN_DATA" | jq -r '.[0].results[0].campaignBudget.amountMicros // "0"')
CURRENT_BUDGET=$(awk "BEGIN { printf \"%.2f\", ${CURRENT_BUDGET_MICROS:-0} / 1000000 }")
```

Confirm via AskUserQuestion: `"Change budget from $<CURRENT> to $<NEW>/day?"` with options `[Confirm, Cancel]`.

Then update:
```bash
NEW_BUDGET_MICROS=$(awk "BEGIN {printf \"%d\", ${NEW_AMOUNT} * 1000000}")
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/campaignBudgets:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"update\": {
        \"resourceName\": \"${BUDGET_RESOURCE}\",
        \"amountMicros\": \"${NEW_BUDGET_MICROS}\"
      },
      \"updateMask\": \"amountMicros\"
    }]
  }"
```

Print: `✓ Budget updated: $<OLD>/day → $<NEW>/day`

### Keyword Planner (`keywords`, `kw`, `keyword-planner`)

```bash
# Collect seed keywords from user via AskUserQuestion (free text)
# "Enter seed keywords (comma-separated):"
# Split into JSON array for the request: KEYWORDS_JSON_ARRAY=$(echo "$SEED_KEYWORDS" | sed 's/,/","/g' | sed 's/^/"/;s/$/"/')

curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}:generateKeywordIdeas" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"language\": \"languageConstants/1000\",
    \"geoTargetConstants\": [\"geoTargetConstants/2840\"],
    \"includeAdultKeywords\": false,
    \"keywordPlanNetwork\": \"GOOGLE_SEARCH\",
    \"keywordSeed\": {
      \"keywords\": [${KEYWORDS_JSON_ARRAY}]
    }
  }"
```

Language `1000` = English, Geo `2840` = United States. These are defaults — if user has locale configured in preferences, use those instead. Other common values: UK=`2826`, Canada=`2124`, Australia=`2036`.

**Output format:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KEYWORD IDEAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seeds: keyword1, keyword2

| Keyword | Avg Monthly Searches | Competition | Low Bid | High Bid |
|---------|---------------------|-------------|---------|----------|
```

- `avgMonthlySearches` displayed as-is (integer)
- `competition` displayed as-is (`LOW`, `MEDIUM`, `HIGH`)
- `lowTopOfPageBidMicros` and `highTopOfPageBidMicros` divided by 1,000,000 and displayed as `$X.XX`
- Sort by `avgMonthlySearches` descending in the output

If no results, print: `No keyword ideas found for these seeds. Try different or broader keywords.`

### Ad Group Management (`ad-groups`, `ag`)

**List ad groups for a campaign** (`ad-groups list <CAMPAIGN_ID>`):

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{\"query\": \"SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${CAMPAIGN_ID} AND ad_group.status != REMOVED ORDER BY ad_group.name\"}"
```

Output:
```
| # | Ad Group ID | Name | Status | CPC Bid |
```

**Create ad group** (`ad-groups create <CAMPAIGN_ID>`):

Collect via AskUserQuestion:
1. Ad group name (free text)
2. Default CPC bid in dollars (free text, convert to micros)

```bash
BID_MICROS=$(awk "BEGIN {printf \"%d\", ${BID_DOLLARS} * 1000000}")
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/adGroups:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"create\": {
        \"name\": \"${AD_GROUP_NAME}\",
        \"campaign\": \"customers/${GADS_CUSTOMER_ID}/campaigns/${CAMPAIGN_ID}\",
        \"status\": \"ENABLED\",
        \"type\": \"SEARCH_STANDARD\",
        \"cpcBidMicros\": \"${BID_MICROS}\"
      }
    }]
  }"
```

Print: `✓ Ad group "${AD_GROUP_NAME}" created in campaign ${CAMPAIGN_ID} (CPC bid: $X.XX)`

**List keywords in ad group** (`ad-groups keywords <AD_GROUP_ID>`):

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{\"query\": \"SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group.id = ${AD_GROUP_ID} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != REMOVED\"}"
```

Output:
```
| # | Keyword | Match Type | CPC Bid | Status |
```

**Add keyword to ad group** (`ad-groups add-keyword <AD_GROUP_ID>`):

Collect via AskUserQuestion:
1. Keyword text (free text)
2. Match type — AskUserQuestion options: `[Broad, Phrase, Exact]`
   Map: `BROAD`, `PHRASE`, `EXACT`
3. CPC bid in dollars (free text, convert to micros) — optional, uses ad group default if not provided

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/adGroupCriteria:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"create\": {
        \"adGroup\": \"customers/${GADS_CUSTOMER_ID}/adGroups/${AD_GROUP_ID}\",
        \"status\": \"ENABLED\",
        \"keyword\": {
          \"text\": \"${KEYWORD_TEXT}\",
          \"matchType\": \"${MATCH_TYPE}\"
        }
        ${BID_MICROS:+,\"cpcBidMicros\": \"${BID_MICROS}\"}
      }
    }]
  }"
```

Print: `✓ Keyword "${KEYWORD_TEXT}" (${MATCH_TYPE}) added to ad group ${AD_GROUP_ID}`

Note: Keywords are immutable after creation. To change match type or text, remove and recreate. To change bid only, use `ad-groups update-bid`.

**Remove keyword** (`ad-groups remove-keyword <AD_GROUP_ID> <CRITERION_ID>`):

⚠ **Rule 5 — confirm before removing** via AskUserQuestion: `"Remove keyword <TEXT> from ad group <NAME>?"` with options `[Remove, Cancel]`.

```bash
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/adGroupCriteria:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"remove\": \"customers/${GADS_CUSTOMER_ID}/adGroupCriteria/${AD_GROUP_ID}~${CRITERION_ID}\"
    }]
  }"
```

Print: `✓ Keyword removed from ad group.`

**Update keyword bid** (`ad-groups update-bid <AD_GROUP_ID> <CRITERION_ID> <BID>`):

```bash
NEW_BID_MICROS=$(awk "BEGIN {printf \"%d\", ${NEW_BID} * 1000000}")
curl -s -X POST \
  "https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${GADS_CUSTOMER_ID}/adGroupCriteria:mutate" \
  "${GADS_HEADERS[@]}" \
  --data-binary "{
    \"operations\": [{
      \"update\": {
        \"resourceName\": \"customers/${GADS_CUSTOMER_ID}/adGroupCriteria/${AD_GROUP_ID}~${CRITERION_ID}\",
        \"cpcBidMicros\": \"${NEW_BID_MICROS}\"
      },
      \"updateMask\": \"cpcBidMicros\"
    }]
  }"
```

Print: `✓ Keyword bid updated to $X.XX`

---

## campaigns

Cross-channel campaign overview — unified view of active campaigns across all configured channels.

Run in parallel:
1. Klaviyo active campaigns (status: draft + scheduled + sending)
2. Meta Ads active campaigns (status: ACTIVE)
3. Show GA4 conversion goals if available

### Output format
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CROSS-CHANNEL CAMPAIGNS — active
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EMAIL (Klaviyo)
 [campaign name]  [status]  [send date or "scheduled for X"]

 PAID (Meta Ads)
 [campaign name]  [status]  $[daily_budget]/day  [objective]

 FLOWS (Always-on automation)
 [flow name]  [trigger type]  [status: live/draft]
```

---

## dashboard (default — no args)

Run ALL sections in parallel, then render unified dashboard.

```bash
# Run the pre-gathered data script
"${CLAUDE_PLUGIN_ROOT}/bin/ops-marketing-dash" 2>/dev/null
```

Parse the JSON output and display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MARKETING DASHBOARD — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Email (Klaviyo)  [N] subs  |  [X]% open rate  |  $[X] attributed
 Paid (Meta)      $[X] spent  |  [X]x ROAS  |  [N] purchases
 Organic (GA4)    [N] sessions  |  [X]% CVR  |  $[X] revenue
 SEO (GSC)        [N] clicks  |  [N] impressions  |  [X] avg pos
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

For any channel with missing credentials, show `[not configured — /ops:marketing setup]`.

---

## setup

**Before asking for anything**, auto-scan ALL sources for existing credentials. Run in a single background batch:

```bash
# Env vars
printenv KLAVIYO_API_KEY KLAVIYO_PRIVATE_KEY META_ACCESS_TOKEN FACEBOOK_ACCESS_TOKEN META_AD_ACCOUNT_ID GA4_PROPERTY_ID GA_MEASUREMENT_ID 2>/dev/null
printenv GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CUSTOMER_ID 2>/dev/null

# Shell profiles
grep -h 'KLAVIYO\|META_\|FACEBOOK\|GA4\|GA_MEASUREMENT\|GOOGLE_ADS' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler — ALL projects, ALL configs
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  for cfg in dev stg prd; do
    doppler secrets --project "$proj" --config "$cfg" --json 2>/dev/null | \
      jq -r --arg proj "$proj" --arg cfg "$cfg" 'to_entries[] | select(.key | test("KLAVIYO|META|FACEBOOK|GA4|GOOGLE|GOOGLE_ADS"; "i")) | "\(.key)=\(.value.computed) (doppler:\($proj)/\($cfg))"'
  done
done

# Dashlane — check for tokens in password entries
dcli password klaviyo --output json 2>/dev/null | jq -r '.[] | select(.password != null and .password != "") | "\(.title): token found"'
dcli password facebook --output json 2>/dev/null | jq -r '.[] | select(.password != null and .password != "") | "\(.title): token found"'
dcli password meta --output json 2>/dev/null | jq -r '.[] | select(.password != null and .password != "") | "\(.title): token found"'
dcli password "google ads" --output json 2>/dev/null | jq -r '.[] | select(.password != null and .password != "") | "\(.title): token found"'

# Keychain
security find-generic-password -s "klaviyo-api-key" -w 2>/dev/null
security find-generic-password -s "meta-ads-token" -w 2>/dev/null
security find-generic-password -s "google-ads-refresh-token" -w 2>/dev/null

# gcloud ADC (for GA4 + Search Console)
gcloud auth application-default print-access-token 2>/dev/null | head -c 10 && echo "...gcloud-ok"

# Chrome history — reveals account identity
sqlite3 ~/Library/Application\ Support/Google/Chrome/Default/History \
  "SELECT DISTINCT url FROM urls WHERE url LIKE '%klaviyo.com%' OR url LIKE '%analytics.google.com%' OR url LIKE '%business.facebook.com%' OR url LIKE '%search.google.com/search-console%' OR url LIKE '%ads.google.com%' ORDER BY last_visit_time DESC LIMIT 15" 2>/dev/null

# Existing prefs + userConfig
jq -r '.marketing // empty' "$PREFS_PATH" 2>/dev/null
```

Present ALL findings before asking for anything. Only prompt for values NOT found in any source. Run all smoke tests with `run_in_background: true`.

**Klaviyo:** If `KLAVIYO_PRIVATE_KEY` or Dashlane entry with `ck_*` key found, use it directly. Note: Klaviyo private keys start with `ck_` (older) or `pk_` (newer). Smoke test: `curl -s -H "Authorization: Klaviyo-API-Key $KEY" -H "revision: 2024-10-15" "https://a.klaviyo.com/api/lists?page[size]=1"`.

**Meta Ads:** If found in Doppler, use directly. Need both `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID`. Smoke test: `graph.facebook.com/v20.0/$AD_ACCOUNT_ID/campaigns?limit=1`.

**GA4:** Only needs Property ID + gcloud ADC. If gcloud ADC not set up, run `gcloud auth application-default login` in background (opens browser). Check Chrome history for GA4 property URLs to auto-detect the property ID.

**Search Console:** Only needs site URL + gcloud ADC. Check Chrome history for `search.google.com/search-console` URLs to auto-detect the site.

**Google Ads:** More complex than other marketing credentials — requires 3 pieces: (1) developer token from Google Ads MCC → Tools & Settings → API Center, (2) OAuth2 client ID + secret from Google Cloud Console (Desktop app type, Google Ads API enabled), (3) refresh token via browser OAuth flow. Setup flow: collect developer token and client credentials first, then open browser auth URL, user pastes authorization code, exchange for refresh token via curl, then list accessible customer accounts and let user select. Smoke test: `curl -s -X GET "https://googleads.googleapis.com/v23/customers:listAccessibleCustomers" -H "Authorization: Bearer $TOKEN" -H "developer-token: $DEV_TOKEN"` — expect JSON with `resourceNames` array.

Save via userConfig (preferred) or Doppler. Report: `[service] ✓ connected` or `[service] ✗ invalid key — [error]`.
