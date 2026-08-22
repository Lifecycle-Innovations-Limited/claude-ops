---
name: ops-marketing
description: "This skill should be used when the user asks to \"klaviyo\", \"ads spend\", or \"/ops:ops-marketing\". Marketing command center. Email campaigns (Klaviyo), paid ads (Meta/Google), analytics (GA4), SEO, and social media metrics. One dashboard for all marketing channels."
argument-hint: '<project> [email|ads|analytics|seo|social|campaigns|setup|autopilot ...]'
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
context: fork
---

# OPS ► MARKETING COMMAND CENTER

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

## DNS provisioning

`bin/ops-dns-provision` is the canonical DNS surface for any marketing project — it covers every record an end-to-end SaaS launch typically needs, all routed through `scripts/lib/cloudflare-dns.sh` for GET-first idempotency. Re-running is safe; `OPS_DRY_RUN=1` prints planned API calls without firing.

| Subcommand                                   | What it does                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gsc <project> <domain>`                     | Google Search Console site verification — fetches token via `siteVerification/v1/token`, upserts TXT at apex, calls `webResource?verificationMethod=DNS_TXT` to verify.                                         |
| `meta-aem <project> <domain>`                | Meta Aggregated Event Measurement — reads `verification_string` from `/me/owned_domains`, upserts `facebook-domain-verification=<token>` TXT at apex.                                                           |
| `apple-pay <project> <domain>`               | Two modes via `apple_pay.mode`: `static-file` (default — surfaces the `.well-known/apple-developer-merchantid-domain-association` deploy-hook path) or `stripe-dns` (Stripe `POST /v1/payment_method_domains`). |
| `spf <project> <domain>`                     | Builds `v=spf1 include:... <policy>` from `.esp.spf_includes`, upserts merge-safely at apex (refuses to overwrite a foreign TXT lacking the `v=spf1` marker).                                                   |
| `dkim <project> <domain>`                    | ESP-keyed off `.esp.provider`. Resend implemented (parses `records[]` from `POST /domains`, CNAME upserts). Postmark/SES stubbed.                                                                               |
| `dmarc <project> <domain>`                   | `_dmarc.<apex>` TXT with `v=DMARC1; p=<policy>; rua=<rua>`. Defaults: `policy=quarantine`, `rua=mailto:dmarc@<apex>`.                                                                                           |
| `mx <project> <domain>`                      | Provider template keyed off `.inbound.provider`: `google-workspace` (smtp.google.com pri 1) / `resend-inbound` / `ses` (region from `.inbound.region`).                                                         |
| `klaviyo-sending <project> <domain>`         | Klaviyo dedicated sending domain — `POST /api/dedicated-sending-domains/`, CNAME upserts.                                                                                                                       |
| `audit <project> [--json]`                   | Read-only — for each row, queries CF and reports `present` / `absent` / `conflicting`.                                                                                                                          |
| `provision-all <project> [--skip <row,row>]` | Idempotent full sweep.                                                                                                                                                                                          |

**Auth**: `CLOUDFLARE_API_TOKEN` (Bearer, preferred) or `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` (Global key, fallback). Zone lookup: `GET /zones?name=<apex>` finds the zone ID. Record writes: GET-first by `name+type`, then PUT existing ID or POST new — never duplicate.

**Apex resolver** (`cf_apex_for`) handles co.uk-style 2nd-level TLDs (foo.co.uk → foo.co.uk) and strips proto/path/port.

### Preferences schema additions

The new bin reads project-level config from `$PREFS_PATH` under `marketing.projects.<key>`:

```jsonc
{
  "marketing": {
    "projects": {
      "myapp": {
        "domain": "example.com",

        // Outbound email service provider (DKIM + SPF includes)
        "esp": {
          "provider": "resend", // "resend" | "postmark" | "ses"
          "credentials": "doppler:prd:RESEND_API_KEY", // cred-ref: "env:VAR" | "doppler:CFG:KEY"
          "spf_includes": ["_spf.resend.com", "_spf.klaviyo.com"], // optional; sensible defaults applied
          "spf_policy": "-all", // "-all" (strict) | "~all" (soft-fail)
        },

        // Inbound mail (MX)
        "inbound": {
          "provider": "google-workspace", // "google-workspace" | "resend-inbound" | "ses"
          "region": "us-east-1", // only used by resend-inbound / ses
        },

        // DMARC policy
        "dmarc": {
          "policy": "quarantine", // "none" | "quarantine" | "reject"
          "rua": "mailto:dmarc@example.com", // defaults to mailto:dmarc@<apex>
        },

        // Optional Cloudflare account override (for accounts that own multiple zones)
        "dns": {
          "cloudflare_account_id": "<your-cf-account-id>",
        },

        // Apple Pay domain registration
        "apple_pay": {
          "enabled": true,
          "mode": "static-file", // default; "stripe-dns" registers via Stripe
        },

        // Cred-refs for individual rows
        "stripe": {
          "secret_key": "env:STRIPE_SECRET_KEY", // legacy DNS provisioner key
          "api_key": "env:STRIPE_API_KEY", // P3: used by ops-marketing-autopilot stripe ROAS gate
          "account_id": "acct_<id>", // optional, only when calling on behalf of a connected acct
        },
        "meta": { "access_token": "env:META_ACCESS_TOKEN" },
        "klaviyo": {
          "private_key": "doppler:prd:KLAVIYO_API_KEY", // legacy DNS row
          "api_key": "doppler:prd:KLAVIYO_API_KEY", // P3: used by gather_klaviyo_metrics
          "account_id": "<klaviyo-account-id>", // P3: optional
          "sending_subdomain": "em.example.com",
        },
      },
    },
  },
}
```

Defaults are applied bash-side via `${var:-default}`, so all values are optional except `domain` (required by `audit` and `provision-all`).

### P3 — perf-data wiring (autopilot)

`bin/ops-marketing-autopilot` reads four perf-data sources per pass and persists them to `${OPS_DATA_DIR}/state/autopilot/<project>-{ga4-conversions,gsc-signal,klaviyo,stripe}.json`:

| Source          | Prefs path                                                    | Helper                   | Purpose                                                                                                                 |
| --------------- | ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| GA4 conversions | `marketing.projects.<key>.ga4.{property_id, sa_key_file_ref}` | `gather_ga4_conversions` | source/medium/campaign rows for the blended bandit reward                                                               |
| GSC search      | `marketing.projects.<key>.gsc.site_url`                       | `gather_gsc_signal`      | rescue + ad-copy-hook candidate buckets                                                                                 |
| Klaviyo         | `marketing.projects.<key>.klaviyo.{api_key, account_id}`      | `gather_klaviyo_metrics` | Placed Order revenue + flow inventory                                                                                   |
| Stripe          | `marketing.projects.<key>.stripe.{api_key, account_id}`       | `gather_stripe_revenue`  | UTM-attributed revenue per `source/medium/campaign` and per `ad_id` — ground-truth ROAS denominator + pause-rescue gate |

Env knobs:

| Env                              | Default   | Effect                                                                                                                |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPS_BANDIT_SOURCE`              | `blended` | `meta` → meta-only reward (legacy), `ga4` → GA4 attribution only, `blended` → `(meta + ga4)/2`                        |
| `OPS_PAUSE_ROAS_FLOOR`           | `1.0`     | An ad with `stripe_revenue ≥ floor × meta_spend` is kept despite Meta CPL/CTR pause criteria                          |
| `OPS_KLAVIYO_REVENUE_RATIO_FLAG` | `0.5`     | When `klaviyo_revenue / paid_spend > flag`, surface "email channel underweighted" in the daily report (no auto-shift) |

UTM enforcement: every `create_object campaign …` call runs `utm_validate` (from `scripts/lib/utm-validate.sh`) on the derived `(utm_source, utm_medium, utm_campaign)` triple before any API mutation. Non-conforming names escalate + stage-only.

### Quick examples

```bash
# Dry-run every row for a project
OPS_DRY_RUN=1 ops-dns-provision provision-all myapp

# Single row, ad-hoc domain (no prefs needed)
ops-dns-provision dmarc myapp example.com

# JSON audit for CI healthcheck
ops-dns-provision audit myapp --json
# → {"project":"myapp","domain":"example.com","zone":"...","rows":{"gsc":"present","spf":"present","dmarc":"present","mx":"present","meta_aem":"absent","dkim":"unknown"}}

# Skip rows that need provider-specific manual setup first
ops-dns-provision provision-all myapp --skip dkim,klaviyo-sending
```

## Quick start — autonomous mode

Run `/ops:marketing <project>` to point-and-go:

1. `ops-marketing-provision status --project <project>` — what's missing
2. For each missing channel, run `ops-marketing-provision provision-<channel> --project <project>` (interactive only if OAuth/keys missing; otherwise idempotent)
3. Verify with `ops-marketing-dash --project <project>`
4. If autopilot not yet enabled, enable: `ops-marketing-autopilot --project <project> --first-run-dry`

Provision a brand-new project end-to-end:

```bash
# One-shot: GA4 + GSC + Instagram + Google Ads — sequential, idempotent
ops-marketing-provision provision-all --project <project>

# Iterate every project in prefs
ops-marketing-provision provision-all --all-projects

# Or individually:
ops-marketing-provision provision-ga4         --project <project> \
  --domain <domain> --account-id <YOUR_GA4_ACCOUNT_ID>
ops-marketing-provision provision-gsc         --project <project> --site https://<domain>/
ops-marketing-provision provision-instagram   --project <project>   # auto-resolves via Meta token
ops-marketing-provision provision-google-ads  --project <project>   # 4-step OAuth flow

# Check results
ops-marketing-provision status --project <project> --json
ops-marketing-dash --project <project>
```

`provision-instagram` requires `marketing.projects.<key>.meta.access_token` (and optional `meta.app_secret` for `appsecret_proof` signing — required when the app's "Require App Secret" setting is on, which is the default for all system-user tokens). The verb is fully idempotent: smoke-tests an existing `instagram.account_id` before making any API calls; pass `--force` to re-resolve.

`provision-google-ads` is a 4-step flow (each step is a no-op if the credential already exists):

1. **Developer token** — scans env + Doppler. If missing, writes a pending-state JSON at `${OPS_DATA_DIR}/state/marketing-provision/<project>-google-ads-pending.json` and exits 1. Apply at <https://ads.google.com/aw/apicenter> (24–48h approval) then re-run.
2. **OAuth client** — scans env + Doppler. If missing, prints Cloud Console URL for creating a Desktop OAuth client.
3. **Refresh token** — launches a localhost HTTP server on `:8080` (120s timeout), opens the Google consent URL, captures the auth code, exchanges for `refresh_token`, writes to Doppler as `GOOGLE_ADS_<PROJECT_UPPER>_REFRESH_TOKEN`.
4. **Customer ID** — calls `v24/customers:listAccessibleCustomers`, auto-detects MCC manager accounts (sets `login_customer_id`), writes `customer_id` to prefs.

Pass `--skip-if-pending` to skip when a dev-token application is in-flight (used by `provision-all` to keep the chain unblocked).

Set `OPS_MARKETING_DRY_RUN=1` to print planned API calls without executing.

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps correctly
   - `klaviyo_private_key`, `meta_ads_token`, `meta_ad_account_id`, `ga4_property_id`, `google_search_console_site` — check userConfig keys before env vars
   - `google_ads_developer_token`, `google_ads_client_id`, `google_ads_client_secret`, `google_ads_refresh_token`, `google_ads_customer_id`, `google_ads_login_customer_id` — Google Ads credentials

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before running any channel queries

3. **Secrets**: Resolve API keys via userConfig → env vars → Doppler MCP (`mcp__doppler__*`) → Doppler CLI fallback (see Credential Resolution section below)

## Additional resources

Channel, CLI, and edge-case detail lives in `references/` next to this skill. Read those files before acting on a matching channel or sub-command. Do not skip them.
