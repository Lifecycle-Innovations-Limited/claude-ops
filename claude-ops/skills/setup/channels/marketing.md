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

Google Ads requires three credential groups. Guide the user through each step sequentially.

**Step A — Developer Token:**
If `GOOGLE_ADS_DEVELOPER_TOKEN` was found in auto-scan, present it and offer `[Keep]` / `[Reconfigure]`.
Otherwise, ask via free text:
> Your Google Ads developer token (found in Google Ads → Tools & Settings → API Center).
> Note: New developer tokens start in "test" mode — they work against test accounts only. For production data, apply for Basic Access at https://ads.google.com/home/tools/manager-accounts/

**Step B — OAuth2 Client Credentials:**
If `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET` were found in auto-scan, present and offer `[Keep]` / `[Reconfigure]`.
Otherwise, ask via free text (two prompts):
1. OAuth2 Client ID (from Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID, type: Desktop app, Google Ads API must be enabled)
2. OAuth2 Client Secret (shown alongside the client ID)

**Step C — Refresh Token (browser OAuth flow):**
If `GOOGLE_ADS_REFRESH_TOKEN` was found in auto-scan, present and offer `[Keep]` / `[Reconfigure]`.
Otherwise, generate the auth URL and run the OAuth flow:

```bash
AUTH_URL="https://accounts.google.com/o/oauth2/auth?client_id=${GADS_CLIENT_ID}&redirect_uri=http://localhost:8080&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent"
open "$AUTH_URL"  # macOS
```

Start a temporary localhost server to catch the redirect:
```bash
# One-liner node HTTP server to capture the auth code
node -e "require('http').createServer((req,res)=>{const code=new URL(req.url,'http://localhost').searchParams.get('code');if(code){res.end('Authorization code received. You can close this tab.');process.stdout.write(code);process.exit(0)}else{res.end('Waiting for auth...')}}).listen(8080)"
```

Run the server via Bash with `run_in_background: true`. Wait up to 120 seconds for the auth code.

If the localhost approach fails, fall back to asking the user to paste the code from the browser URL bar (the `code=` parameter).

Exchange code for refresh token:
```bash
TOKEN_RESP=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data "code=${AUTH_CODE}" \
  --data "client_id=${GADS_CLIENT_ID}" \
  --data "client_secret=${GADS_CLIENT_SECRET}" \
  --data "redirect_uri=http://localhost:8080" \
  --data "grant_type=authorization_code")
GADS_REFRESH_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.refresh_token')
```

If `GADS_REFRESH_TOKEN` is null or empty, print error and offer retry.

Warning: If the user's Google Cloud project is in "testing" publishing status, the refresh token expires in 7 days. Warn: "Your OAuth app is in testing mode — tokens expire in 7 days. To get long-lived tokens, publish the app in Google Cloud Console → OAuth consent screen → Publish App."

**Step D — Customer ID:**
Use the refresh token to get an access token, then list accessible customers:
```bash
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data "client_id=${GADS_CLIENT_ID}&client_secret=${GADS_CLIENT_SECRET}&refresh_token=${GADS_REFRESH_TOKEN}&grant_type=refresh_token" | jq -r '.access_token')

CUSTOMERS=$(curl -s -X GET \
  "https://googleads.googleapis.com/v23/customers:listAccessibleCustomers" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "developer-token: ${GADS_DEV_TOKEN}")
```

If multiple accounts returned, present as `AskUserQuestion` options (max 4 per Rule 1 — paginate if more). If single account, auto-select. Store as `customer_id` (strip "customers/" prefix and dashes).

If any account is a manager (MCC) account, also store `login_customer_id`. Auto-detect by checking if `listAccessibleCustomers` returns both manager and client accounts.

**Step E — Smoke Test:**
```bash
curl -s -X GET "https://googleads.googleapis.com/v23/customers:listAccessibleCustomers" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "developer-token: ${GADS_DEV_TOKEN}"
```
Expect JSON with `resourceNames` array. If error, print the error and offer `[Retry]` / `[Skip]`.

**Step F — Save to preferences:**
```json
{
  "marketing": {
    "google_ads": {
      "developer_token": "<YOUR_DEVELOPER_TOKEN>",
      "client_id": "<YOUR_CLIENT_ID>.apps.googleusercontent.com",
      "client_secret": "GOCSPX-<YOUR_SECRET>",
      "refresh_token": "1//<YOUR_REFRESH_TOKEN>",
      "customer_id": "1234567890",
      "login_customer_id": "9876543210"
    }
  }
}
```

Same Doppler-reference pattern as Step 3i — prefer `doppler:KEY_NAME` over raw tokens when Doppler is configured.

Print: `[Google Ads] ✓ connected — customer ID: XXXXXXXXXX`

#### Google Analytics 4

If `GA4_PROPERTY_ID` or `GA_MEASUREMENT_ID` was found in the auto-scan, present it. Only ask via free text if not found. Ask for the GA4 Property ID (explain: GA4 dashboard → Admin → Property Settings → Property ID, format: numeric, e.g. `123456789`).

No API key needed if `gcloud` is authenticated — the GA4 Data API uses Application Default Credentials. Check:
```bash
gcloud auth application-default print-access-token 2>/dev/null | head -c 10
```
If gcloud ADC is not set up, note that GA4 queries will require manual auth: `gcloud auth application-default login`.

#### Google Search Console

Ask for the site URL (format: `https://example.com/` or `sc-domain:example.com`). No API key needed if gcloud is authed.

Smoke test:
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

Then ask creative regeneration opt-in:

| Option | Header | Description |
| --- | --- | --- |
| Enable regen | regen | On full creative fatigue, auto-generate a fresh creative (Veo3 video / Gemini image) with a mandatory hallucination audit before deploy |
| Recommend only | norgen | Detect fatigue but only write a recommendation — no autonomous creative generation |

Write the block to `$PREFS_PATH` under `marketing.projects.<name>.autopilot` (merge — do not clobber existing `.meta`/`.google_ads` cred-refs):

```json
{
  "marketing": {
    "projects": {
      "<name>": {
        "autopilot": {
          "enabled": true,
          "channels": ["meta"],
          "daily_spend_cap_usd": 50,
          "campaign_ids": { "meta": ["<CAMPAIGN_ID>"], "google_ads": [] },
          "pause_cpl_multiple": 2.0,
          "pause_ctr_floor": 0.005,
          "min_live_creatives": 2,
          "creative_regen": { "enabled": true, "video": "veo3", "image": "gemini-image" },
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
# Enable the daemon service (merges into the user's daemon-services config)
"${CLAUDE_PLUGIN_ROOT}/bin/ops-daemon-manager" enable marketing-autopilot 2>/dev/null \
  || jq '.services["marketing-autopilot"].enabled = true' \
       "$OPS_DATA_DIR/daemon-services.json" > "$OPS_DATA_DIR/daemon-services.json.tmp" \
     && mv "$OPS_DATA_DIR/daemon-services.json.tmp" "$OPS_DATA_DIR/daemon-services.json"

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

