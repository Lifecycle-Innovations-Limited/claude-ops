# Windsor.ai — live marketing & analytics data for ops commands

[Windsor.ai](https://windsor.ai/) is a marketing data aggregator with 325+
connectors (Meta Ads, Google Ads, GA4, TikTok Ads, LinkedIn, Microsoft Ads,
organic social — Instagram / Facebook / TikTok / YouTube / LinkedIn —, Google
Search Console, Klaviyo, Shopify, Stripe, and many more). It is an optional but
high-leverage data source for the marketing-facing ops commands
(`/ops:marketing`, `/ops:socials`, `/ops:ecom`, `/ops:dash`, `/ops:go`,
`/ops:next`).

This doc is **provider-agnostic and registry-driven**: it describes the wiring
pattern, not any specific account. All account identifiers below are
placeholders — every user supplies their own via the project registry.

## Two access modes

| Mode                                                   | Use for                                                                                  | Auth                                | Cost                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| **MCP** (`mcp__*Windsor*__*`)                          | interactive drill-down inside an ops command — per-campaign / per-day / arbitrary fields | claude.ai OAuth, no key needed      | runs in-session      |
| **REST** (`https://connectors.windsor.ai/<connector>`) | headless / cron pulls — feeding a cache, statusline, or dashboard with no model calls    | `api_key` (one per Windsor account) | free, no model quota |

REST request shape:

```
https://connectors.windsor.ai/<connector>?api_key=<KEY>&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&fields=<comma,separated,field,ids>
```

- Supported field ids per connector: `https://connectors.windsor.ai/<connector>/fields?api_key=<KEY>`
- Omitting a date field aggregates over the whole range, one row per account.
- A response of `{"data":[...]}` means the connector is connected (even if empty);
  `{"error":"No <connector> account ..."}` means it must be connected first in the
  Windsor dashboard.

Store the REST key in the OS secret store (e.g. macOS Keychain service
`windsor_api_key`), never in a repo or in `preferences.json` in plaintext.

## Registry-driven account mapping

Map each project's connector accounts in your **project registry**
(`registry.json` → `.projects[].windsor`) so every command pulls the right
numbers per project. Connector slugs are lowercase (`facebook` = Meta Ads,
`google_ads`, `googleanalytics4` = GA4, `tiktok` = TikTok Ads, `tiktok_organic`,
`instagram`, `facebook_organic`, `youtube`, `searchconsole`, …):

```jsonc
{
  "projects": [
    {
      "alias": "<your-project>",
      "windsor": {
        "facebook": "<meta_ad_account_id>",
        "google_ads": "<google_ads_account_id>",
        "googleanalytics4": "<ga4_property_id>",
        "instagram": "<ig_account_id>",
        "searchconsole": "sc-domain:<your-domain>",
      },
    },
  ],
}
```

Optionally register Windsor.ai in the partner registry so `/ops:credentials`
and `/ops:status` can see it:

```jsonc
// preferences.json → partner_registry.windsor_ai
{
  "category": "marketing-analytics",
  "auth_type": "api-key+mcp",
  "mcp_server": "<windsor-mcp-server-id>",
  "credential_key": "windsor_api_key",
  "rest_base": "https://connectors.windsor.ai",
  "read_tools": ["get_connectors", "get_fields", "get_data", "get_options"],
  "write_tools": ["list_actions", "execute_action"],
}
```

## What the marketing commands should produce

When a command has Windsor data available, return an **analysis**, not a table
dump:

1. **Trend** — today vs 7-day vs 30-day; what moved and by how much.
2. **Per channel** — Meta vs Google (vs TikTok …) ROAS / CAC / CPC / CTR; where
   the return is and where budget leaks.
3. **Anomalies** — spend / CPC / CTR / conversion spikes & drops; campaigns
   spending with no conversions (drill down per campaign via the MCP).
4. **Funnel** — sessions → add-to-cart → checkout → purchase; where it drops.
5. **Organic ↔ paid** — does organic growth contribute to blended CAC.
6. **Concrete actions with numbers** — e.g. "pause campaign X (spend, 0 conv,
   30d)", "shift budget from Meta to Google (ROAS a vs b)". Offer to execute via
   `list_actions` / `execute_action` (Meta + Google Ads support pause / enable /
   budget), **only after the user confirms**.

## Caveats to apply before drawing conclusions

- **Blended over platform-reported ROAS.** When server-side conversion APIs
  (Meta CAPI, GA4 server events, etc.) are partial or off, a platform under-reports
  its own attributed revenue. Prefer **blended ROAS = analytics/store revenue ÷
  total ad spend** as the source of truth, and flag the attribution gap.
- **GA4 lag.** GA4 typically trails several hours, so "today" revenue/orders may
  read 0. For realtime same-day revenue prefer the store source (Shopify, etc.);
  use GA4 for 7d/30d.
- **Connect-before-query.** A connector returns `error: No <connector> account`
  until it is connected in the Windsor dashboard; some require a separate OAuth
  per ads vs organic (e.g. `tiktok` vs `tiktok_organic`).
- **Trial plan limits.** Free/trial Windsor plans cap the number of data sources;
  adding a new connector may require freeing a slot or upgrading.

## Adding the integration

Run `/ops:integrate windsor.ai` (auth type `api-key`, base
`https://connectors.windsor.ai`) to register it in the partner registry, then add
the per-project `windsor` mapping shown above. The marketing commands pick it up
automatically when the mapping is present.
