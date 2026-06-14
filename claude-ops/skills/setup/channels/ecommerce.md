### 3i — Ecommerce (Shopify + dynamic partners)

#### Step 3i.1 — Auto-scan for existing Shopify credentials

**Before asking for anything**, run the Universal Credential Auto-Scan for all Shopify-related vars simultaneously:

```bash
# --- Token scan (API credentials) ---

# Scan shell env
printenv SHOPIFY_ACCESS_TOKEN SHOPIFY_ADMIN_TOKEN SHOPIFY_STORE_URL SHOPIFY_ADMIN_API_ACCESS_TOKEN 2>/dev/null

# Scan shell profiles
grep -h 'SHOPIFY\|myshopify' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Scan Doppler across all projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
    jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("SHOPIFY|STORE")) | "\(.key)=\(.value.computed) (doppler:\($proj)/prd)"'
done

# Scan Dashlane for API tokens
dcli password shopify --output json 2>/dev/null | jq -r '.[] | select(.password != null and .password != "") | "\(.title): \(.url) → token found"'

# Scan macOS Keychain
security find-generic-password -s "shopify-admin-token" -w 2>/dev/null
security find-generic-password -s "shopify-access-token" -w 2>/dev/null

# Scan OpenClaw
jq -r '.agents.defaults.env | to_entries[] | select(.key | test("SHOPIFY")) | "\(.key)=\(.value)"' ~/.openclaw/openclaw.json 2>/dev/null

# Check existing prefs
jq -r '.ecom.shopify // empty' "$PREFS_PATH" 2>/dev/null

# --- Store URL discovery (even if no tokens found) ---
# Scan Chrome history for myshopify.com admin URLs
sqlite3 ~/Library/Application\ Support/Google/Chrome/Default/History \
  "SELECT DISTINCT replace(replace(url, 'https://', ''), 'http://', '') FROM urls WHERE url LIKE '%myshopify.com/admin%' OR url LIKE '%admin.shopify.com/store/%' ORDER BY last_visit_time DESC LIMIT 10" 2>/dev/null | \
  grep -oE '[a-z0-9-]+\.myshopify\.com|admin\.shopify\.com/store/[a-z0-9-]+' | sort -u

# Scan Dashlane URLs for myshopify.com store references
dcli password shopify --output json 2>/dev/null | jq -r '.[].url // empty' | grep -oE '[a-z0-9-]+\.myshopify\.com' | sort -u

# Scan project .env files for store URLs
grep -rhE 'myshopify\.com|SHOPIFY_STORE' ~/Projects/*/.env* 2>/dev/null | grep -v '^#' | head -5
```

**Important**: Do NOT report "No Shopify credentials found" until ALL scan sources have been checked. If tokens are missing but store URLs are found (e.g. from Chrome history or Dashlane), report: `"Found Shopify store(s): <stores>. No API token found — you'll need to create one."` and skip straight to Step 3i.3 (token) with the store URL pre-filled.

If both `store_url` and `admin_token` are already found, show:

```
✓ Shopify — already configured (<store_url>)
  [Keep existing]  [Reconfigure]
```

If the user keeps existing, skip to Step 3i.4. If reconfiguring or no values found, continue.

#### Step 3i.2 — Shopify store URL

If `SHOPIFY_STORE_URL` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format. Only ask via free text if no value was found:

```
Enter your Shopify store URL:
  Format: yourstore.myshopify.com
  (Do not include https://)
```

Validate the input: strip `https://`, strip trailing slash, check that the result ends with `.myshopify.com`. If invalid, ask again with a correction note.

#### Step 3i.3 — Shopify Admin API token

If `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_ADMIN_TOKEN`, or `SHOPIFY_ADMIN_API_ACCESS_TOKEN` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format with truncated display (`shpat_508b...682e`). Only ask via free text if no value was found.

**Multi-store handling**: When multiple stores are discovered, process each one independently. For stores without tokens, try automated approaches first:

1. **Check Doppler across all projects** for store-specific Shopify tokens:
   ```bash
   for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
     doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
       jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("SHOPIFY.*TOKEN|SHOPIFY.*ACCESS"; "i")) | "\(.key)=\(.value.computed | .[0:12])... (doppler:\($proj)/prd)"'
   done
   ```
2. **Try Shopify CLI** if installed (`command -v shopify`):
   ```bash
   shopify auth logout 2>/dev/null  # Clear stale session
   shopify auth login --store <store>.myshopify.com 2>&1  # Opens browser OAuth
   ```
   After successful auth, generate a custom app token via the CLI. This avoids manual admin navigation.
3. **Browser automation** — if Kapture/Playwright MCP is available, navigate to `https://admin.shopify.com/store/<slug>/settings/apps/development` and automate the "Create an app" → "Configure scopes" → "Install" → "Reveal token" flow. Use scopes: `read_orders,read_products,read_customers,read_inventory,read_fulfillments,read_analytics`.
4. **Manual fallback** — only if all automated approaches fail:
   ```
   No automated path available for <store>.myshopify.com.
   To generate a token manually:
     1. Go to https://admin.shopify.com/store/<slug>/settings/apps/development
     2. Create an app → Configure → grant scopes → Install → copy token
     Token starts with "shpat_"
   ```

**Do NOT skip a store** just because no token was found — always attempt automation first. The user expects the wizard to handle credential generation, not just credential lookup.

Save to `$PREFS_PATH` under `ecom.shopify`. Apply the Doppler-reference pattern — if Doppler is configured, run:

```bash
doppler secrets set SHOPIFY_ADMIN_TOKEN="<token>" --project <project> --config <config>
```

and store `"admin_token": "doppler:SHOPIFY_ADMIN_TOKEN"` in preferences instead of the raw token.

Smoke test:

```bash
STORE=$(jq -r '.ecom.shopify.store_url' "$PREFS_PATH")
TOKEN=$(jq -r '.ecom.shopify.admin_token' "$PREFS_PATH")
if [[ "$TOKEN" == doppler:* ]]; then
  KEY="${TOKEN#doppler:}"
  TOKEN=$(doppler secrets get "$KEY" --plain 2>/dev/null)
fi
curl -s -H "X-Shopify-Access-Token: $TOKEN" \
  "https://$STORE/admin/api/2024-10/shop.json" | jq '.shop.name'
```

Expect a shop name string. If the response contains `errors` or `{"shop":null}`, show the error and ask the user to check the token scopes. Print `✓ Shopify — connected (<shop name>)`.

#### Step 3i.4 — Dynamic ecommerce partners

After Shopify is configured, ask via `AskUserQuestion` (free text):

```
Do you use any other ecommerce tools you'd like to connect?
  Examples: ShipBob (fulfillment), Recharge (subscriptions), Yotpo (reviews),
            Shippo (shipping rates), Gorgias (support), Attentive (SMS), Loop (returns)
  Type the names separated by commas, or leave blank to skip.
```

If the user provides partner names, process each one in a loop:

**For each partner:**

1. **Research credentials** — web search: `"<partner name> API authentication developer docs 2025"`. Determine:
   - What credentials are needed (API key, OAuth token, webhook secret, base URL, account ID, etc.)
   - The API base URL
   - A suitable health/auth endpoint to smoke test (e.g. `/me`, `/account`, `/v1/ping`, list endpoint with limit=1)
   - The auth header pattern (`Authorization: Bearer`, `X-Api-Key`, custom header, etc.)

2. **Ask for each credential** via `AskUserQuestion` (one question per credential field), citing where to find it based on what the docs say. Example for ShipBob:
   Run the Universal Credential Auto-Scan for `SHIPBOB_ACCESS_TOKEN`, `SHIPBOB_API_TOKEN` before asking. If found, present with source attribution. Only prompt manually if not found:

   ```
   Enter your ShipBob Personal Access Token:
     To generate: ShipBob dashboard → Integrations → API → Personal Access Tokens → Create Token
   ```

3. **Smoke test** using the auth endpoint discovered in step 1:

   ```bash
   curl -s -H "<auth_header>: $TOKEN" "<base_url>/<health_endpoint>" | jq '.<identity_field>'
   ```

   Show the result. If it fails, show the raw response and offer `[Re-enter credentials]` / `[Skip this partner]`.

4. **Save to preferences** under `ecom.partners.<partner_slug>` where `partner_slug` is the lowercased, hyphenated partner name:

   ```json
   {
     "ecom": {
       "partners": {
         "shipbob": {
           "api_base_url": "https://api.shipbob.com/v1",
           "auth_pattern": "Authorization: Bearer <token>",
           "credentials": { "api_token": "doppler:SHIPBOB_API_TOKEN" },
           "health_endpoint": "/user",
           "configured_at": "<ISO timestamp>"
         }
       }
     }
   }
   ```

   Store actual secrets via Doppler (key: `<PARTNER_SLUG_UPPER>_API_TOKEN`) when Doppler is configured, else store inline. The `auth_pattern` and `api_base_url` fields are the memory that future `/ops:ecom` calls use to reach the partner — always populate them from the researched docs.

5. **Print confirmation**:

   ```
   ✓ <Partner Name> — connected
   ```

6. **Loop**: After each partner, ask `AskUserQuestion`: "Any other ecommerce tools to connect?" → `[Yes — add another]` / `[Done]`. This lets users add partners one at a time if they prefer over the initial comma-separated list.

**Partners with known credential patterns** (use these directly without searching, but still verify with a smoke test):

| Partner   | Auth header                          | Base URL                             | Health endpoint        |
| --------- | ------------------------------------ | ------------------------------------ | ---------------------- |
| ShipBob   | `Authorization: Bearer <token>`      | `https://api.shipbob.com/v1`         | `/user`                |
| Recharge  | `X-Recharge-Access-Token: <token>`   | `https://api.rechargeapps.com/v1`    | `/shop`                |
| Yotpo     | `X-Api-Key: <app_key>`               | `https://api.yotpo.com`              | `/core/v3/stores/<id>` |
| Shippo    | `Authorization: ShippoToken <token>` | `https://api.goshippo.com`           | `/carrier_accounts`    |
| Gorgias   | `Authorization: Basic <base64>`      | `https://<domain>.gorgias.com/api`   | `/account`             |
| Loop      | `X-Authorization: <secret>`          | `https://api.loopreturns.com/api/v1` | `/warehouse`           |
| Attentive | `Authorization: Bearer <token>`      | `https://api.attentivemobile.com/v1` | `/me`                  |

For any partner not in this table, always web search for current auth docs before asking for credentials.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-ecom/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for the ecommerce integration (multi-store Shopify, partner dispatching, store-health daemon). The setup agent can load that file directly when it needs more depth than this wizard provides.

---
