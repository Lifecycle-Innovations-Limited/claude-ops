# Direct channel wiring — free API fallback for marketing data

The marketing-facing ops commands (`/ops:marketing`, `/ops:socials`,
`/ops:ecom`, `/ops:dash`) can read live channel data through
[Windsor.ai](windsor-ai.md), but Windsor is **optional and paid**. When a
Windsor plan lapses, the connectors keep answering with silent all-zero rows —
which can masquerade as "spend €0, reach 0" for weeks. Every major channel also
exposes a **free first-party API**, and this repo ships direct, registry-driven
libraries for them.

Use the direct libraries as a full alternative when Windsor is not connected,
or as a fallback when Windsor errors or returns the all-zero pattern. Never
present zeros from a dead source as real metrics.

This doc is **provider-agnostic and registry-driven**: all identifiers below
are placeholders — every user supplies their own via
`preferences.json` → `.marketing.projects.<project>.<channel>.*` (values may be
literals, `env:VAR_NAME`, or `doppler:project/config/SECRET` refs, resolved by
`scripts/lib/ga4-resolve.sh`).

## Channel matrix

| Channel                     | Direct library                                                                                             | Function                | Status               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------- |
| Meta Ads (paid)             | [`scripts/lib/ad-spend-aggregator.sh`](../../claude-ops/scripts/lib/ad-spend-aggregator.sh)                 | `ad_spend_meta`         | implemented          |
| Google Ads (paid)           | [`scripts/lib/ad-spend-aggregator.sh`](../../claude-ops/scripts/lib/ad-spend-aggregator.sh)                 | `ad_spend_google`       | implemented          |
| TikTok / LinkedIn / Reddit / Microsoft / Pinterest Ads | [`scripts/lib/ad-spend-aggregator.sh`](../../claude-ops/scripts/lib/ad-spend-aggregator.sh) | `ad_spend_tiktok` etc.  | stub                 |
| GA4 (analytics)             | [`scripts/lib/ga4-data-api.sh`](../../claude-ops/scripts/lib/ga4-data-api.sh)                               | `ga4_run_report`        | implemented          |
| Facebook Page + Instagram Business (organic) | [`scripts/lib/organic-metrics-aggregator.sh`](../../claude-ops/scripts/lib/organic-metrics-aggregator.sh) | `organic_meta`          | implemented          |
| YouTube (organic)           | [`scripts/lib/organic-metrics-aggregator.sh`](../../claude-ops/scripts/lib/organic-metrics-aggregator.sh)   | `organic_youtube`       | implemented          |
| Google Search Console       | [`scripts/lib/organic-metrics-aggregator.sh`](../../claude-ops/scripts/lib/organic-metrics-aggregator.sh)   | `organic_searchconsole` | implemented          |
| Google Merchant Center      | [`scripts/lib/organic-metrics-aggregator.sh`](../../claude-ops/scripts/lib/organic-metrics-aggregator.sh)   | `merchant_status`       | implemented          |
| TikTok (organic)            | [`scripts/lib/organic-metrics-aggregator.sh`](../../claude-ops/scripts/lib/organic-metrics-aggregator.sh)   | `organic_tiktok`        | stub (see below)     |

All aggregator functions share the same contract: `curl -sS --max-time 12`,
errors swallowed, missing creds → `null`, configured-but-stubbed →
`{"status":"configured_but_not_implemented"}`, success → a JSON object with at
least `surface`, `project`, `window_days`. `ad_spend_all` and `organic_all`
fan out across surfaces and aggregate.

## Required keys per channel

Keys live under `preferences.json` → `.marketing.projects.<project>.<channel>`:

| Channel (prefs key)   | Fields                                                                                    | Notes                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `meta` (paid)         | `access_token`, `ad_account_id`, `app_secret` (optional)                                   | Marketing API; `appsecret_proof` sent when `app_secret` is present                             |
| `meta` (organic)      | `access_token`, `page_id`, `instagram_business_id`                                         | Same token can serve both; env fallback `META_ACCESS_TOKEN` / `FACEBOOK_ACCESS_TOKEN`          |
| `google_ads`          | `refresh_token`, `client_id`, `client_secret`, `developer_token`, `customer_id`, `login_customer_id` (optional) | OAuth helpers in `scripts/lib/google-ads-oauth.sh`                       |
| `ga4`                 | `property_id` (+ service-account key file, see `ga4-data-api.sh`)                          | Service-account JWT or gcloud ADC                                                              |
| `youtube`             | `refresh_token`, `client_id`, `client_secret`, `channel_id` (optional)                     | Refresh token must carry `yt-analytics.readonly` (+ `youtube.readonly` for subscriber totals)  |
| `gsc`                 | `site_url` (e.g. `sc-domain:example.com`)                                                  | Auth via gcloud ADC or `$GOOGLE_ACCESS_TOKEN` (same as `ops-cron-seo-blog-gen.sh`)             |
| `merchant_center`     | `merchant_id`, plus OAuth refresh creds (scope `content`) or gcloud ADC / `$GOOGLE_ACCESS_TOKEN` | Content API v2.1 `accountstatuses` — approved/pending/disapproved/expiring counts        |
| `tiktok_organic`      | `access_token`                                                                             | **Stub** — TikTok requires an approved developer app; declared creds emit the sentinel         |

## Usage

```bash
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "${PLUGIN_ROOT}/lib/registry-path.sh"
. "${PLUGIN_ROOT}/scripts/lib/ad-spend-aggregator.sh"
. "${PLUGIN_ROOT}/scripts/lib/organic-metrics-aggregator.sh"

ad_spend_all "<project>"   # {"project":..,"total_spend_7d":..,"surfaces":[...]}
organic_all "<project>"    # {"project":..,"window_days":7,"surfaces":[...]}
```

## Fallback routing (used by the skills)

1. Windsor connected and returning plausible, non-all-zero data → use Windsor
   (cross-channel blending, arbitrary fields).
2. Windsor missing / erroring / all-zero across surfaces that are known to be
   active → use the direct libraries above and label the source accordingly.
3. A surface with no creds in either path → report it as **not wired**, never
   as zero.
