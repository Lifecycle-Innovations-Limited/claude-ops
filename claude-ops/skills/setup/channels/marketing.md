### 3j — Marketing (Klaviyo, Meta Ads, GA4, Search Console)

**Before showing the service selector**, run the Universal Credential Auto-Scan for all marketing vars simultaneously:

```bash
# Shell env
printenv KLAVIYO_API_KEY KLAVIYO_PRIVATE_KEY META_ACCESS_TOKEN FACEBOOK_ACCESS_TOKEN META_AD_ACCOUNT_ID GA4_PROPERTY_ID GA_MEASUREMENT_ID 2>/dev/null
printenv GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_CUSTOMER_ID 2>/dev/null

# Shell profiles
grep -h 'KLAVIYO\|META_\|FACEBOOK\|GA4\|GA_MEASUREMENT\|GOOGLE_ADS' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler across all projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
    jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("KLAVIYO|META|FACEBOOK|GA4|GOOGLE|GOOGLE_ADS")) | "\(.key)=\(.value.computed) (doppler:\($proj)/prd)"'
done

# Dashlane
dcli password klaviyo --output json 2>/dev/null
dcli password facebook --output json 2>/dev/null
dcli password meta --output json 2>/dev/null

# OpenClaw
jq -r '.agents.defaults.env | to_entries[] | select(.key | test("KLAVIYO|META_|FACEBOOK|GA4")) | "\(.key)=\(.value)"' ~/.openclaw/openclaw.json 2>/dev/null
```

Cache these results — use them to pre-fill answers for each sub-step below. For each service below, check if already configured (check `$PREFS_PATH` under `marketing.*`, then the auto-scan results above) before prompting. If already set, show `✓ <service> — already configured` and offer `[Keep]` / `[Reconfigure]`.

Ask which marketing integrations to configure via two sequential `AskUserQuestion` calls with `multiSelect: true` (max 4 per Rule 1):

**First call** (primary integrations):

| Option                  | Header        | Description                                   |
| ----------------------- | ------------- | --------------------------------------------- |
| Klaviyo                 | klaviyo       | Email/SMS marketing — private API key         |
| Meta Ads                | meta          | Facebook/Instagram ads — access token + ad account ID |
| Google Ads              | google-ads    | Paid search ads — OAuth2 + developer token    |
| More...                 | more          | Google Analytics 4, Search Console            |

If user selects `[More...]`, present **second call**:

| Option                      | Header   | Description                                            |
| --------------------------- | -------- | ------------------------------------------------------ |
| Google Analytics 4          | ga4      | Web analytics — GA4 property ID                        |
| Google Search Console       | gsc      | SEO data — site URL (uses gcloud auth)                 |
| WhatsApp Business API       | waba     | Template messaging at scale — Business token + IDs     |
| Skip                        | skip     | Done with marketing setup                              |

Run the selected sub-step(s) below in the order selected.

#### Klaviyo

If `KLAVIYO_API_KEY` or `KLAVIYO_PRIVATE_KEY` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format. Only ask via free text if not found:
```
Enter your Klaviyo Private API Key:
  To generate one: Klaviyo dashboard → Settings → API Keys → Create Private Key
  Key starts with "pk_"
```

Smoke test:
```bash
curl -s -H "Authorization: Klaviyo-API-Key $KEY" \
  -H "revision: 2024-10-15" \
  "https://a.klaviyo.com/api/lists" | jq '.data | length'
```
Expect a number ≥ 0. If the response contains `"detail"` with an auth error, show it and re-ask.

#### Meta Ads

If `META_ACCESS_TOKEN` or `FACEBOOK_ACCESS_TOKEN` was found in the auto-scan, present it. If `META_AD_ACCOUNT_ID` was found, present that too. Only ask via free text for values not found.

Ask for:
1. Access token (explain: Meta Business Suite → Settings → System Users or your personal account → Generate token with `ads_read` permission)
2. Ad account ID (format: `act_XXXXXXXXXX` — found in Business Manager → Ad Accounts)

Smoke test:
```bash
curl -s "https://graph.facebook.com/v20.0/$AD_ACCOUNT_ID/campaigns?access_token=$TOKEN&limit=1" | jq '.data | length'
```

#### Google Ads

**Primary path — delegate to the provision binary:**

```bash
ops-marketing-provision provision-google-ads --project <project>
```

This is now a callable 4-step flow (each step is a no-op if already configured):

- **Step A — Developer token.** Scans env + Doppler. If missing, writes a pending-state file at `${OPS_DATA_DIR}/state/marketing-provision/<project>-google-ads-pending.json` with the application URL <https://ads.google.com/aw/apicenter>, then exits 1. Approval takes 24–48h.
- **Step B — OAuth2 client.** Scans env + Doppler for `GOOGLE_ADS_CLIENT_ID` + `GOOGLE_ADS_CLIENT_SECRET`. If missing, prints the Cloud Console URL for creating a Desktop OAuth client.
- **Step C — Refresh token.** Starts a Node HTTP server on `:8080` (120s timeout), opens the consent URL, captures the `code` query param, POSTs to `https://oauth2.googleapis.com/token` to exchange for `refresh_token`, writes to Doppler as `GOOGLE_ADS_<PROJECT_UPPER>_REFRESH_TOKEN`.
- **Step D — Customer ID.** Calls `v24/customers:listAccessibleCustomers`. Auto-detects MCC manager accounts via the `customer.manager` field (sets `login_customer_id`). Writes everything to `marketing.projects.<project>.google_ads` as Doppler cred-refs.

**Test-mode caveat:** if the Google Cloud OAuth app is in "Testing" publishing status, refresh tokens expire in 7 days. Surface this to the user; recommend "Publish App" in Cloud Console → OAuth consent screen.

**Manual fallback path** (when the binary errors and the user wants to step through manually):

The endpoints (validated 2026-05-20 against Google's OIDC discovery doc):
- Auth: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- Scope: `https://www.googleapis.com/auth/adwords`
- API: `https://googleads.googleapis.com/v24` (v24 became GA October 2025)

Auth URL pattern:
```bash
AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=${GADS_CLIENT_ID}&redirect_uri=http://localhost:8080&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent"
```

Code → refresh-token exchange:
```bash
TOKEN_RESP=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "code=${AUTH_CODE}" \
  --data-urlencode "client_id=${GADS_CLIENT_ID}" \
  --data-urlencode "client_secret=${GADS_CLIENT_SECRET}" \
  --data-urlencode "redirect_uri=http://localhost:8080" \
  --data-urlencode "grant_type=authorization_code")
GADS_REFRESH_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.refresh_token')
```

List accessible customers (for picking `customer_id` + auto-detecting MCC):
```bash
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=${GADS_CLIENT_ID}&client_secret=${GADS_CLIENT_SECRET}&refresh_token=${GADS_REFRESH_TOKEN}&grant_type=refresh_token" | jq -r '.access_token')

curl -s -X GET "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "developer-token: ${GADS_DEV_TOKEN}"
```

Detect manager accounts (set `login_customer_id` to the manager when calling sub-accounts):
```bash
curl -s -X POST "https://googleads.googleapis.com/v24/customers/${CID}/googleAds:search" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "developer-token: ${GADS_DEV_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary '{"query":"SELECT customer.manager FROM customer LIMIT 1"}'
```

**Save to preferences (Doppler cred-refs preferred):**
```json
{
  "marketing": {
    "projects": {
      "<project>": {
        "google_ads": {
          "developer_token":   "doppler:claude-ops/prd/GOOGLE_ADS_DEVELOPER_TOKEN",
          "client_id":         "doppler:claude-ops/prd/GOOGLE_ADS_CLIENT_ID",
          "client_secret":     "doppler:claude-ops/prd/GOOGLE_ADS_CLIENT_SECRET",
          "refresh_token":     "doppler:claude-ops/prd/GOOGLE_ADS_<PROJECT_UPPER>_REFRESH_TOKEN",
          "customer_id":       "1234567890",
          "login_customer_id": "9876543210"
        }
      }
    }
  }
}
```

Print: `[Google Ads] ✓ connected — customer ID: XXXXXXXXXX`

#### Instagram

**Primary path — delegate to the provision binary:**

```bash
ops-marketing-provision provision-instagram --project <project>
```

Auto-resolves `instagram.account_id` from the Meta access token by reading `instagram_business_account.id` off the configured Facebook Page (or `/me/accounts` fallback). When `marketing.projects.<project>.meta.app_secret` is configured, the verb computes `appsecret_proof = HMAC-SHA256(access_token, app_secret)` and appends it to every Graph API call — required when the Meta app's "Require App Secret" setting is on (default for all system-user tokens).

Idempotent: re-runs smoke-test the existing `account_id` before re-resolving. Pass `--force` to bypass.

Requires `marketing.projects.<project>.meta.access_token` to be configured first (via setup or manual prefs edit). Exits 2 if the Meta token is missing — does not fabricate.

#### Google Analytics 4

**Branch A — property already exists:** If `GA4_PROPERTY_ID` or `GA_MEASUREMENT_ID` was found in the auto-scan (or already set under the project's GA4 config in prefs — `marketing.projects[<key>].ga4` with a `property_id` field), present it and offer `[Keep]` / `[Reconfigure]`. On Keep, write the property ID directly to prefs and continue.

**Branch B — no property yet:** Ask via `AskUserQuestion`:

| Option | Description |
|--------|-------------|
| Provision new | Run `ops-marketing-provision provision-ga4` — creates property, stream, MP secret, pushes to Doppler (requires `gcloud` ADC + GA4 account ID) |
| Paste existing | Enter a numeric property ID manually (GA4 dashboard → Admin → Property Settings) |

For Branch B / Provision new, run:
```bash
ops-marketing-provision provision-ga4 \
  --project <key> \
  --domain <domain> \
  --account-id <GA4_ACCOUNT_ID>
```
Capture the printed `property_id`, `measurement_id`, `stream_id` — they are written to prefs automatically.

No API key needed if `gcloud` is authenticated — the GA4 Data API uses Application Default Credentials. Check:
```bash
gcloud auth application-default print-access-token 2>/dev/null | head -c 10
```
If gcloud ADC is not set up, prompt: run `gcloud auth application-default login --scopes=...analytics.edit,...webmasters` (full scope list in `ops-marketing-provision --help`).

#### Google Search Console

Ask for the site URL (format: `https://example.com/` or `sc-domain:example.com`), or auto-derive from `marketing.projects.<key>.domain`.

To self-provision (adds the site and auto-upserts DNS TXT via Cloudflare if `CLOUDFLARE_API_TOKEN` is set):
```bash
ops-marketing-provision provision-gsc --project <key> --site https://<domain>/
```

Smoke test (verify gcloud ADC is working):
```bash
ACCESS_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://searchconsole.googleapis.com/webmasters/v3/sites" | jq '.siteEntry | length'
```

#### WhatsApp Business API

**Separate from wacli personal WhatsApp.** Used for Business-to-customer template messaging at scale.

Auto-scan for:
```bash
printenv WHATSAPP_BUSINESS_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_BUSINESS_ACCOUNT_ID 2>/dev/null
claude plugin config get whatsapp_business_token 2>/dev/null && echo "waba_token: already configured"
claude plugin config get whatsapp_phone_number_id 2>/dev/null && echo "waba_phone_id: already configured"
claude plugin config get whatsapp_business_account_id 2>/dev/null && echo "waba_account_id: already configured"
```

Where to find credentials:
- `WHATSAPP_BUSINESS_TOKEN`: Meta Developer Portal → Your App → WhatsApp → API Setup → Temporary or System User token
- `WHATSAPP_PHONE_NUMBER_ID`: Same page → "From" phone number → Phone Number ID
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: Meta Business Manager → Business Settings → WhatsApp Accounts → ID

Collect each via AskUserQuestion (free text) if not found. Save:
```bash
claude plugin config set whatsapp_business_token "$WABA_TOKEN"
claude plugin config set whatsapp_phone_number_id "$WABA_PHONE_ID"
claude plugin config set whatsapp_business_account_id "$WABA_ACCOUNT_ID"
```

Smoke test:
```bash
curl -s "https://graph.facebook.com/v20.0/${WABA_PHONE_ID}" \
  -H "Authorization: Bearer ${WABA_TOKEN}" | jq '.display_phone_number // empty'
```

If returns phone number: `WhatsApp Business ✓ connected — Phone: <number>`. Else show error.

#### Save to preferences

Write to `$PREFS_PATH` (merge):
```json
{
  "marketing": {
    "klaviyo": { "api_key": "<pk_...>" },
    "meta": { "access_token": "<token>", "ad_account_id": "act_XXXXXXXXXX" },
    "ga4": { "property_id": "123456789" },
    "gsc": { "site_url": "https://example.com/" },
    "whatsapp_business": { "phone_number_id": "<ID>", "business_account_id": "<WABA_ID>" }
  }
}
```

Same Doppler-reference pattern as Step 3i — prefer `doppler:KEY_NAME` over raw tokens when Doppler is configured.

#### Autopilot — autonomous daily ad management

**Only offer this if Meta Ads and/or Google Ads were configured for this project.** Autopilot runs an unattended daily pass that pauses underperformers, rotates/regenerates creatives, and writes a report — bounded by a mandatory per-project spend cap. It never raises budgets or creates campaigns.

Ask via `AskUserQuestion` whether to enable it:

| Option | Header | Description |
| --- | --- | --- |
| Enable autopilot | autopilot | Daily autonomous optimization within a hard spend cap |
| Skip | skip | Configure ad creds only, no autonomous management |

If enabled, ask the spend cap (Rule 1 — max 4 options):

| Option | Header | Description |
| --- | --- | --- |
| $25/day | cap25 | Conservative — small test budget |
| $50/day | cap50 | Standard |
| $100/day | cap100 | Aggressive |
| Custom | custom | Free-text a different USD/day cap |

Then ask channels (`multiSelect: true`, only show channels configured for this project): `[Meta]`, `[Google Ads]`.

Then ask the **autonomy level** (one `AskUserQuestion`, Rule 1 — max 4 options; recommended option first):

| Option | Header | Description |
| --- | --- | --- |
| Create-once (Recommended) | create_once | Safe default — creation actions are staged under "Requires human action" until a one-time approval token is dropped; daily optimize/regen loop is autonomous within the cap |
| Sandbox (bounded auto-create) | sandbox | Auto-create campaigns/audiences ONLY if every envelope assertion passes (objective/geo allowlists, budget ≤ caps, max campaigns/audiences) |
| Unrestricted (cap-only) | unrestricted | Auto-create bounded only by the daily spend cap — explicitly overrides the default creation guardrail |
| More... | more | Envelope sub-fields (allowlists, max campaigns/audiences, kill_switch) are configurable later via `/ops:settings` → Autopilot Studio |

Write the selection to `autopilot.autonomy_level`. Then ask the **source URL** (`AskUserQuestion` free text):

```
Website/landing page Autopilot Studio should market (cold-start onboarding).
Leave blank to manage existing campaigns only.
```

Write it to `autopilot.source.url` (omit `source` if blank).

Then ask **creative generation** opt-in (Rule 1 — max 4 options):

| Option | Header | Description |
| --- | --- | --- |
| Enable gen | gen | On full creative fatigue, auto-generate a fresh creative (Veo3 video + Gemini image) through the Tier 0–3 pre-analysis brain with a mandatory hallucination/compliance audit before deploy |
| Recommend only | norgen | Detect fatigue but only write a recommendation — no autonomous creative generation |

If "Enable gen", ask a follow-up (`AskUserQuestion` free text) for `creative_gen.daily_gen_spend_cap_usd` (default `5`, must be ≤ `daily_spend_cap_usd`). Note to the operator: this is a **separate metered-Gemini ceiling**, distinct from the ad spend cap.

Then ask the **Neurons external signal** (one `AskUserQuestion`; recommended option first):

| Option | Header | Description |
| --- | --- | --- |
| Off (Recommended) | neurons_off | Default — no external attention/engagement signal in the creative brain |
| Enable | neurons_on | Fold a Neurons ensemble signal into Tier 3; configure `marketing.partners.neurons` via the Dynamic marketing partners loop below |

Write the choice to `creative_gen.neurons.enabled` (and run the Dynamic marketing partners loop for `neurons` if enabled).

Write the block to `$PREFS_PATH` under `marketing.projects.<name>.autopilot` (merge — do not clobber existing `.meta`/`.google_ads` cred-refs):

```json
{
  "marketing": {
    "projects": {
      "<name>": {
        "autopilot": {
          "enabled": true,
          "autonomy_level": "create_once",
          "envelope": {
            "max_campaigns": 3, "max_new_audiences": 2,
            "objective_allowlist": ["OUTCOME_LEADS", "OUTCOME_SALES"],
            "geo_allowlist": ["NL", "US"],
            "max_daily_budget_usd": 50,
            "kill_switch": false
          },
          "source": { "url": "https://example.com" },
          "channels": ["meta"],
          "daily_spend_cap_usd": 50,
          "campaign_ids": { "meta": [], "google_ads": [] },
          "pause_cpl_multiple": 2.0, "pause_ctr_floor": 0.005, "min_live_creatives": 2,
          "creative_gen": {
            "enabled": true,
            "video": "veo-3.1-fast-generate-preview",
            "image": "gemini-3.1-flash-image-preview",
            "analysis": { "multimodal": "gemini-3.1-pro-preview", "judge": "claude-opus-4-7" },
            "daily_gen_spend_cap_usd": 5,
            "neurons": { "enabled": false }
          },
          "weekly_synthesis": true,
          "notify_sink": null
        }
      }
    }
  }
}
```

Ask for the campaign ID(s) to manage per selected channel (free text, comma-separated) and populate `campaign_ids`. Then enable the daemon service and run one forced-dry pass so the operator can review the first report:

```bash
# Enable the daemon services (merges into the user's daemon-services config).
# Enabling autopilot enables BOTH the daily pass and the weekly self-learning calibrator
# (same enable mechanism).
for svc in marketing-autopilot marketing-autopilot-calibrate; do
  "${CLAUDE_PLUGIN_ROOT}/bin/ops-daemon-manager" enable "$svc" 2>/dev/null \
    || { jq --arg s "$svc" '.services[$s].enabled = true' \
           "$OPS_DATA_DIR/daemon-services.json" > "$OPS_DATA_DIR/daemon-services.json.tmp" \
         && mv "$OPS_DATA_DIR/daemon-services.json.tmp" "$OPS_DATA_DIR/daemon-services.json"; }
done

# First run is forced dry by the binary regardless of this flag — review the report
"${CLAUDE_PLUGIN_ROOT}/bin/ops-marketing-autopilot" --dry-run --project "<name>"
```

Print the report path (`$OPS_DATA_DIR/reports/marketing-autopilot/<name>-latest.md`) and tell the operator the next scheduled (live) run is the daemon's `0 8 * * *` UTC tick.

#### Dynamic marketing partners

After the known services, ask via `AskUserQuestion` (free text):
```
Any other marketing tools you'd like to connect?
  Examples: Postscript (SMS), Privy (popups), Triple Whale (attribution), Northbeam,
            Hotjar, Heap, Segment, Mixpanel, Mailchimp, ActiveCampaign, HubSpot
  Type names separated by commas, or leave blank to skip.
```

If the user provides partner names, apply the same dynamic partner loop as Step 3i.4 — for each partner:

1. **Research credentials** via web search: `"<partner name> API authentication developer docs 2025"`
2. **Ask for credentials** via `AskUserQuestion` with instructions sourced from the docs
3. **Smoke test** against the auth/health endpoint
4. **Save to preferences** under `marketing.partners.<partner_slug>`:
   ```json
   {
     "marketing": {
       "partners": {
         "triple-whale": {
           "api_base_url": "https://api.triplewhale.com/api/v2",
           "auth_pattern": "Authorization: Bearer <token>",
           "credentials": { "api_key": "doppler:TRIPLE_WHALE_API_KEY" },
           "health_endpoint": "/attribution/get-attribution-data",
           "configured_at": "<ISO timestamp>"
         }
       }
     }
   }
   ```
5. **Loop** — offer `[Add another]` / `[Done]` after each partner.

**Partners with known credential patterns** (use directly, still smoke test):

| Partner       | Auth header                            | Base URL                                       | Health endpoint     |
| ------------- | -------------------------------------- | ---------------------------------------------- | ------------------- |
| HubSpot       | `Authorization: Bearer <token>`        | `https://api.hubapi.com`                       | `/crm/v3/objects/contacts?limit=1` |
| Mailchimp     | `Authorization: Bearer <api_key>`      | `https://<dc>.api.mailchimp.com/3.0`           | `/ping`             |
| Segment       | `Authorization: Basic <base64_key:>`   | `https://api.segment.io/v1`                    | n/a — use write key |
| Mixpanel      | `Authorization: Basic <base64_secret:>` | `https://data.mixpanel.com/api/2.0`           | `/engage?limit=1`   |
| Postscript    | `Authorization: ApiKey <key>`          | `https://api.postscript.io/api/v2`             | `/shops`            |
| Triple Whale  | `Authorization: Bearer <token>`        | `https://api.triplewhale.com/api/v2`           | `/attribution/get-attribution-data` |

For any partner not in this table, always web search for current auth docs before asking for credentials.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-marketing/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for marketing integrations (Klaviyo flows, Meta Ads, GA4, Search Console). The setup agent can load that file directly when it needs more depth than this wizard provides.

---

