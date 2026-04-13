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
  - AskUserQuestion
  - WebFetch
  - WebSearch
---

# OPS ► MARKETING COMMAND CENTER

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

---

## Sub-command Routing

Route `$ARGUMENTS` to the correct section below:

| Input | Action |
|---|---|
| (empty), dashboard | Run full marketing dashboard |
| email, klaviyo | Klaviyo email metrics |
| ads, meta | Meta Ads performance |
| google-ads | Google Ads (if configured) |
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

Guide user through configuring each marketing service:

```
MARKETING SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Which service do you want to configure?
  1. Klaviyo (email)
  2. Meta Ads (paid social)
  3. Google Analytics 4
  4. Google Search Console
  5. All of the above
```

For each selected service, prompt for required credentials and save via `claude plugin config set <key> <value>`.

**Klaviyo:** Ask for Private API Key (from Klaviyo → Settings → API Keys). Save as `klaviyo_private_key`.

**Meta Ads:** Ask for Access Token (from Meta Business → System Users → Generate Token with `ads_read` + `ads_management`). Ask for Ad Account ID (format: `act_XXXXXXXXX`). Save as `meta_ads_token` and `meta_ad_account_id`.

**GA4:** Prompt user to run `gcloud auth application-default login` and provide their GA4 Property ID (numeric, from Admin → Property Settings). Save as `ga4_property_id`.

**Search Console:** Prompt for site URL as registered (e.g. `https://example.com`). Save as `google_search_console_site`. Uses same gcloud ADC as GA4.

After saving, validate each credential with a test API call and report: `[service] ✓ connected` or `[service] ✗ invalid key`.
