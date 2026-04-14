<!-- generated-by: gsd-doc-writer -->
# Configuration

claude-ops has four distinct layers of configuration: plugin `userConfig` fields set inside Claude Code, a project registry file, a daemon services file, and a runtime preferences file written by the setup wizard. This document covers all four.

---

## Plugin Settings (`userConfig`)

These fields are set through the Claude Code plugin UI (`/plugin` → `ops` → Settings) or via `/ops:setup`. They map directly to the `userConfig` schema in `.claude-plugin/plugin.json`. Sensitive values are stored encrypted by Claude Code and are never written to disk in plaintext.

| Field | Required | Default | Description |
|---|---|---|---|
| `telegram_api_id` | Optional | `""` | Numeric API ID from [my.telegram.org/apps](https://my.telegram.org/apps). Run `/ops:setup telegram` to auto-configure. |
| `telegram_api_hash` | Optional | `""` | API hash from [my.telegram.org/apps](https://my.telegram.org/apps). Run `/ops:setup telegram` to auto-configure. |
| `telegram_phone` | Optional | `""` | Your Telegram phone number in E.164 format (e.g. `+14155550100`). |
| `telegram_session` | Optional | `""` | gram.js `StringSession` token. Generated automatically by `/ops:setup telegram`. |
| `sentry_org` | Optional | `""` | Sentry organization slug (e.g. `my-org`). Used by `/ops:triage` and `/ops:fires`. |
| `linear_team` | Optional | `""` | Default Linear team key (e.g. `HEA`). Used by `/ops:linear`. |
| `aws_region` | Optional | `us-east-1` | Default AWS region for infra checks. Used by `/ops:deploy`, `/ops:fires`, `/ops:revenue`. |
| `klaviyo_private_key` | Optional | `""` | Private API key from Klaviyo Settings → API Keys (starts with `pk_` or `ck_`). Used by `/ops:marketing`. |
| `meta_ads_token` | Optional | `""` | Meta Marketing API access token from Facebook Business. Used by `/ops:marketing`. |
| `meta_ad_account_id` | Optional | `""` | Meta ad account ID in `act_XXXXXXXXX` format. Used by `/ops:marketing`. |
| `ga4_property_id` | Optional | `""` | GA4 property ID (numeric, from Admin → Property Settings). Used by `/ops:marketing`. |
| `google_search_console_site` | Optional | `""` | Site URL as registered in Google Search Console (e.g. `https://example.com`). |
| `shopify_store_url` | Optional | `""` | Shopify store URL (e.g. `mystore.myshopify.com`). Used by `/ops:ecom`. |
| `shopify_admin_token` | Optional | `""` | Shopify Admin API access token from Shopify Partners or a custom app. Used by `/ops:ecom`. |
| `shipbob_access_token` | Optional | `""` | ShipBob Personal Access Token for fulfillment tracking. Used by `/ops:ecom`. |
| `bland_ai_api_key` | Optional | `""` | API key from [app.bland.ai](https://app.bland.ai). Used by `/ops:voice` for outbound calls. |
| `elevenlabs_api_key` | Optional | `""` | API key from [elevenlabs.io](https://elevenlabs.io). Used by `/ops:voice` for TTS. |
| `groq_api_key` | Optional | `""` | API key from [console.groq.com](https://console.groq.com). Used by `/ops:voice` for Whisper transcription. |
| `stripe_secret_key` | Optional | `""` | Stripe secret key (`sk_live_...` or `sk_test_...`). Prefer a Doppler reference. Used by `/ops:revenue`. |
| `revenuecat_api_key` | Optional | `""` | RevenueCat V1 API key for mobile subscription revenue tracking. Used by `/ops:revenue`. |
| `revenuecat_project_id` | Optional | `""` | RevenueCat project ID (visible in the app.revenuecat.com URL). Used by `/ops:revenue`. |

**Sensitive fields** (`telegram_api_id`, `telegram_api_hash`, `telegram_phone`, `telegram_session`, `klaviyo_private_key`, `meta_ads_token`, `shopify_admin_token`, `shipbob_access_token`, `bland_ai_api_key`, `elevenlabs_api_key`, `groq_api_key`, `stripe_secret_key`, `revenuecat_api_key`) are marked `"sensitive": true` in the schema and are encrypted at rest by Claude Code.

---

## Telegram MCP Server (`.mcp.json`)

The bundled Telegram MCP server is wired in `.mcp.json` at the plugin root. It reads all four Telegram credentials directly from `userConfig` at runtime — no manual file editing is required.

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/telegram-server/index.js"],
      "env": {
        "TELEGRAM_API_ID": "${user_config.telegram_api_id}",
        "TELEGRAM_API_HASH": "${user_config.telegram_api_hash}",
        "TELEGRAM_PHONE": "${user_config.telegram_phone}",
        "TELEGRAM_SESSION": "${user_config.telegram_session}"
      }
    }
  }
}
```

`CLAUDE_PLUGIN_ROOT` is resolved at runtime to the plugin's installed cache directory. It is also exported into your shell profile by `/ops:setup` so shell scripts can reference it.

---

## Project Registry (`scripts/registry.json`)

The registry tells every skill which projects you own, where they live on disk, and how they are deployed. It is **gitignored** — copy `scripts/registry.example.json` to `scripts/registry.json` and fill in your values.

```json
{
  "version": "1.0",
  "owner": "Your Name",
  "projects": [
    {
      "alias": "my-app",
      "paths": ["~/Projects/my-app"],
      "repos": ["your-org/my-app"],
      "org": "your-org",
      "type": "monorepo",
      "infra": {
        "platform": "vercel"
      },
      "revenue": { "model": "saas", "stage": "pre-launch" },
      "gsd": true,
      "priority": 1
    },
    {
      "alias": "my-api",
      "paths": ["~/Projects/my-api"],
      "repos": ["your-org/my-api"],
      "org": "your-org",
      "type": "monorepo",
      "infra": {
        "ecs_clusters": ["my-api-production", "my-api-staging"],
        "platform": "aws"
      },
      "revenue": { "model": "saas", "stage": "growth" },
      "gsd": true,
      "priority": 2
    }
  ]
}
```

### Registry fields

| Field | Required | Description |
|---|---|---|
| `version` | Required | Schema version. Always `"1.0"`. |
| `owner` | Required | Your display name, used in briefing headings. |
| `projects[].alias` | Required | Short name used in skill commands (e.g. `/ops:fires my-api`). |
| `projects[].paths` | Required | Array of local directory paths for this project. Multi-repo projects list multiple paths. |
| `projects[].repos` | Required | Array of `org/repo` slugs on GitHub. |
| `projects[].org` | Required | GitHub org or username. |
| `projects[].type` | Required | `"monorepo"` or `"multi-repo"`. |
| `projects[].infra.platform` | Optional | `"aws"` or `"vercel"`. Determines which deploy checks run. |
| `projects[].infra.ecs_clusters` | Optional | Array of ECS cluster names (AWS only). Used by `/ops:deploy` and `/ops:fires`. |
| `projects[].revenue.model` | Optional | `"saas"`, `"subscription"`, `"ecom"`, etc. |
| `projects[].revenue.stage` | Optional | `"pre-launch"`, `"growth"`, etc. Shown in `/ops:revenue`. |
| `projects[].revenue.mrr` | Optional | Current MRR in USD. Used in revenue dashboard. |
| `projects[].gsd` | Optional | `true` if the project uses GSD planning. Enables GSD phase display in `/ops:projects`. |
| `projects[].priority` | Optional | Integer. Skills process projects in ascending priority order. |

The interactive wizard (`/ops:setup registry`) builds this file project-by-project via structured prompts.

---

## Daemon Services (`scripts/daemon-services.example.json`)

The ops-daemon is managed by launchd and runs shell services on cron schedules or as persistent processes. To customize which services run, copy `scripts/daemon-services.example.json` to `~/.claude/plugins/data/ops-ops-marketplace/daemon-services.json`.

**All optional services are disabled by default in the example file.** The `wacli-sync` service is enabled; `memory-extractor` is **disabled** and must be explicitly enabled.

### Available services

| Service | Default | Type | Schedule | Notes |
|---|---|---|---|---|
| `wacli-sync` | **enabled** | persistent | — | Keeps WhatsApp connected. Restarts up to 10 times with a 60 s delay. Requires `wacli` installed. |
| `memory-extractor` | **disabled** | cron + persistent | every 30 min | Extracts contact profiles and conversation context via a background Haiku agent. |
| `inbox-digest` | disabled | cron | every 4 hours | Sends an inbox summary to Telegram. Requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `gog` for email. |
| `store-health` | disabled | cron | daily at 09:00 | Sends Shopify store health report to Telegram. Requires `SHOPIFY_STOREFRONT_TOKEN`, `SHOPIFY_STORE_DOMAIN`, `TELEGRAM_BOT_TOKEN`. |
| `competitor-intel` | disabled | cron | Mondays at 10:00 | Weekly competitor research delivered to Telegram. Requires `TELEGRAM_BOT_TOKEN`. Optional: `TAVILY_API_KEY`. |
| `message-listener` | disabled | persistent | — | Listens for incoming messages and triggers responses. Requires `wacli`. Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`. Restarts up to 20 times with a 30 s delay. |

### Service schema

```json
{
  "services": {
    "memory-extractor": {
      "enabled": false,
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-memory-extractor.sh",
      "health_file": "~/.claude/plugins/data/ops-ops-marketplace/memories/.health",
      "restart_delay": 3600,
      "cron": "*/30 * * * *"
    }
  }
}
```

| Field | Description |
|---|---|
| `enabled` | `true` to activate the service. `false` to disable (daemon ignores it). |
| `command` | Shell command to run. Use `${CLAUDE_PLUGIN_ROOT}` for portability. |
| `cron` | Cron expression for scheduled services. Omit for persistent services. |
| `health_file` | Path the service writes to signal it is healthy. Read by the daemon for restart decisions. |
| `restart_delay` | Seconds to wait before restarting a crashed service. |
| `max_restarts` | Maximum restart attempts before the daemon gives up. |

The default daemon configuration (before any user customization) is in `scripts/daemon-services.default.json`. It enables `briefing-pre-warm`, `wacli-sync`, and `memory-extractor` — but the **user-facing example disables `memory-extractor`** so it is opt-in.

The `_variables` block in the example documents two runtime substitution variables:

- `CLAUDE_PLUGIN_ROOT` — resolved at runtime to the plugin install directory.
- `OPS_DATA_DIR` — overrides the default data directory (`~/.claude/plugins/data/ops-ops-marketplace`).

---

## Runtime Preferences (`preferences.json`)

The `/ops:setup` wizard writes a `preferences.json` file to `~/.claude/plugins/data/ops-ops-marketplace/preferences.json`. This file is **outside the plugin source tree** and survives plugin reinstalls and version bumps. It stores your display name, timezone, briefing verbosity, default channels, and channel-specific tokens that are not managed through plugin `userConfig`.

<!-- VERIFY: Full schema of preferences.json — fields written by /ops:setup are not documented in the repository source files accessible here. -->

---

## Hooks (`hooks/hooks.json`)

Three Claude Code lifecycle hooks are registered automatically when the plugin is installed.

| Hook | Trigger | Command |
|---|---|---|
| `SessionStart` | Every new Claude Code session | `ops-welcome` — shows a startup dashboard; `setup.sh` — prints any unresolved config issues (first 3 lines). |
| `PreToolUse` (Bash matcher) | Before every `Bash` tool call | `ops-pretool-wacli-health` — checks WhatsApp connection health before any shell command runs. |
| `Stop` | Session end | `ops-post-session-cleanup` — runs cleanup tasks after the session closes. |

Hooks are wired via `hooks/hooks.json` and reference scripts via `${CLAUDE_PLUGIN_ROOT}`. No user configuration is required.

---

## Environment Variables (daemon cron services)

These environment variables are read by optional cron service shell scripts. They are not managed by plugin `userConfig` and must be available in the daemon's shell environment (e.g. via Doppler, your shell profile, or a secrets manager).

| Variable | Required by | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `inbox-digest`, `store-health`, `competitor-intel`, `message-listener` | Telegram Bot API token for sending notifications. |
| `TELEGRAM_CHAT_ID` | `inbox-digest` | Telegram chat ID to send the inbox digest to. |
| `TELEGRAM_OWNER_ID` | `message-listener` | Optional. Telegram user ID of the owner for message routing. |
| `SHOPIFY_STOREFRONT_TOKEN` | `store-health` | Shopify Storefront API token. |
| `SHOPIFY_STORE_DOMAIN` | `store-health` | Shopify store domain (e.g. `mystore.myshopify.com`). |
| `TAVILY_API_KEY` | `competitor-intel` | Optional. Improves web search quality for competitor research. |
| `CLAUDE_PLUGIN_ROOT` | All daemon scripts | Path to the plugin install directory. Exported by `/ops:setup`. |

---

## Per-Environment Overrides

claude-ops does not use `.env` files. All secrets resolve through the following chain in priority order:

1. **Doppler** — if `doppler` CLI is installed and configured, `/ops:setup` will link it. Skills read secrets via `doppler run --` or environment injection.
2. **Password manager** — 1Password (`op`), Dashlane (`dcli`), or Bitwarden (`bw`) vaults are scanned by `/ops:setup` during credential collection.
3. **macOS Keychain** — the Telegram wizard stores `api_id`, `api_hash`, `phone`, and `session` in the system keychain automatically.
4. **Plugin `userConfig`** — values set in Claude Code plugin settings (see Plugin Settings section above).
5. **Shell environment** — variables exported in your shell profile (e.g. `~/.zshrc`).

For production deployments, Doppler is the recommended secrets source. Skills degrade gracefully when optional credentials are absent — features that require a missing credential are skipped rather than erroring.
