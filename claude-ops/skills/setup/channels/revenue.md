### 3l — Revenue (Stripe + RevenueCat)

**Before showing the service selector**, run the Universal Credential Auto-Scan for all revenue vars simultaneously (Rule 4 — background these):

```bash
# Shell env
printenv STRIPE_SECRET_KEY STRIPE_API_KEY REVENUECAT_API_KEY REVENUECAT_SECRET_KEY REVENUECAT_PROJECT_ID 2>/dev/null

# Shell profiles + .envrc files
grep -h 'STRIPE\|REVENUECAT\|RC_API' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler across all projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
    jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("STRIPE|REVENUECAT|RC_API")) | "\(.key)=\(.value.computed) (doppler:\($proj)/prd)"'
done

# 1Password
op item list --categories "API Credential" --format json 2>/dev/null | \
  jq -r '.[] | select(.title | test("stripe|revenuecat"; "i")) | .id' | \
  while read id; do op item get "$id" --format json 2>/dev/null; done

# Dashlane
dcli password stripe --output json 2>/dev/null
dcli password revenuecat --output json 2>/dev/null

# Bitwarden
bw list items --search stripe 2>/dev/null | jq -r '.[] | select(.login.password) | .login.password' | head -1
bw list items --search revenuecat 2>/dev/null | jq -r '.[] | select(.login.password) | .login.password' | head -1

# macOS Keychain
security find-generic-password -s "stripe" -w 2>/dev/null
security find-generic-password -s "revenuecat" -w 2>/dev/null

# OpenClaw
jq -r '.agents.defaults.env | to_entries[] | select(.key | test("STRIPE|REVENUECAT")) | "\(.key)=\(.value)"' ~/.openclaw/openclaw.json 2>/dev/null
```

Cache these results. Also check `$PREFS_PATH` under `revenue.stripe.*` and `revenue.revenuecat.*` — if already set, show `✓ <service> — already configured` and offer `[Keep]` / `[Reconfigure]`.

Ask which revenue integrations to configure via `AskUserQuestion` with `multiSelect: true`:

| Option     | Header     | Description                                          |
| ---------- | ---------- | ---------------------------------------------------- |
| Stripe     | stripe     | SaaS revenue — secret key for MRR, charges, disputes |
| RevenueCat | revenuecat | Mobile subs — API key + project ID for mobile MRR    |

#### Stripe

If `STRIPE_SECRET_KEY` was found in the auto-scan, present it using the Universal Credential Auto-Scan prompt format with `[Use this value]` / `[Paste a different one]` / `[Skip]`.

Per Rule 3 — if nothing was found, offer (≤4 options):

```
No Stripe secret key found. How do you want to provide one?
  [Paste Stripe secret key manually]
  [Deep hunt — spawn agent]
  [Skip — use registry.json values]
```

On `[Deep hunt — spawn agent]`, spawn a background research agent per Rule 3:

```
Agent(
  subagent_type: "general-purpose",
  model: "haiku",
  run_in_background: true,
  prompt: "Grep the filesystem under $HOME (excluding node_modules, .git, Library/Caches) for Stripe secret key patterns: sk_live_[A-Za-z0-9]+ and sk_test_[A-Za-z0-9]+. Also scan ~/.config, ~/.aws, ~/.docker, any .env files, and known secrets directories. Return every hit with file path + line number + 6 chars of redacted prefix (e.g. sk_live_abc***). Do not print full keys."
)
```

While it runs, continue to the RevenueCat block. Return to Stripe when the agent reports results; present findings via `AskUserQuestion` (paginate to ≤4 per Rule 1).

On `[Paste Stripe secret key manually]`:

```
Enter your Stripe Secret Key:
  Format: sk_live_XXX  (production)  or  sk_test_XXX  (test mode)
  Find it: Stripe Dashboard → Developers → API keys → Secret key → Reveal
  Prefer a Doppler reference (e.g. doppler:STRIPE_SECRET_KEY) over the raw value.
```

Smoke test:

```bash
curl -s -u "$STRIPE_SECRET_KEY:" "https://api.stripe.com/v1/balance" | jq '.available | length'
```

Expect a non-zero integer. If `{"error": ...}`, show the message and re-ask.

#### RevenueCat

If `REVENUECAT_API_KEY` and `REVENUECAT_PROJECT_ID` were both found in the auto-scan, present them together with `[Use these values]` / `[Paste different ones]` / `[Skip]`.

Per Rule 3 — if not found, offer:

```
No RevenueCat credentials found. How do you want to provide them?
  [Paste RevenueCat API key manually]
  [Deep hunt — spawn agent]
  [Skip — mobile MRR will be omitted]
```

On `[Deep hunt — spawn agent]`, spawn (background, Rule 4):

```
Agent(
  subagent_type: "general-purpose",
  model: "haiku",
  run_in_background: true,
  prompt: "Grep the filesystem under $HOME (excluding node_modules, .git, Library/Caches) for RevenueCat credential patterns: rcb_[A-Za-z0-9]+ (V2 secret), sk_[A-Za-z0-9]+ near the literal string 'revenuecat', and any env vars matching REVENUECAT_* or RC_API_*. Also look for project IDs (32-char alphanum strings) adjacent to any revenuecat match. Return each hit with file path + line number + 6-char redacted prefix. Do not print full keys."
)
```

On `[Paste RevenueCat API key manually]`:

```
Enter your RevenueCat API Key:
  Find it: app.revenuecat.com → Project settings → API keys → Secret key
  Format: rcb_XXX (V2 secret)  or  sk_XXX (legacy secret key)

Enter your RevenueCat Project ID:
  Find it in the URL: app.revenuecat.com/projects/<project_id>/...
```

Smoke test:

```bash
curl -s -H "Authorization: Bearer $REVENUECAT_API_KEY" \
  "https://api.revenuecat.com/v2/projects/$REVENUECAT_PROJECT_ID/metrics/overview" | jq '.metrics // .object'
```

Expect a numeric `mrr` or an object descriptor. If the response is `{"code": 7243, ...}` (auth error), re-ask.

#### Save to preferences

Write to `$PREFS_PATH` (merge):

```json
{
  "revenue": {
    "stripe": {
      "secret_key": "doppler:STRIPE_SECRET_KEY",
      "configured_at": "<ISO timestamp>"
    },
    "revenuecat": {
      "api_key": "doppler:REVENUECAT_API_KEY",
      "project_id": "<project_id>",
      "configured_at": "<ISO timestamp>"
    }
  }
}
```

Prefer a Doppler reference (`doppler:STRIPE_SECRET_KEY`, `doppler:REVENUECAT_API_KEY`) over raw tokens when Doppler is configured. For either service, if the user picked `[Skip]`, save `{"revenue": {"<service>": "skipped"}}` so the wizard doesn't re-prompt on the next run — but `/ops:revenue` will fall back to `scripts/registry.json` `revenue.mrr` values as documented in the `revenue-tracker` agent.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-revenue/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for revenue integrations (Stripe MRR/ARR queries, RevenueCat subscription metrics, registry fallbacks). The setup agent can load that file directly when it needs more depth than this wizard provides.

---
