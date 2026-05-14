# OPS ► SETUP — Shared Step-3 Helpers

This file is loaded once when any Step-3 channel block runs. It contains:

1. **Host OS detection** — pick the right package manager before suggesting installs.
2. **OAuth preference** — when to lead with OAuth vs. manual token entry.
3. **Universal Credential Auto-Scan** — the canonical 10-source scan every credential prompt must run before asking the user.
4. **Per-channel credential auto-scan** — short bridge for Telegram/Slack token scans.

Load this file before any `channels/*.md` block. All channel sub-flows reference "the Universal Credential Auto-Scan" by name and expect this content to be in scope.

---

#### Shared: detect the host OS before suggesting installs

The claude-ops wizard runs on macOS, Linux (all major distros + WSL), and Windows (native + WSL). Before printing any install command, the skill MUST detect the host OS and pick the OS-appropriate variant. Never print a `brew install …` command to a Windows user, and never print `winget install …` to a macOS user.

Minimal detection snippet (bash — works on macOS, Linux, WSL, MSYS/Cygwin):

```bash
case "$(uname -s)" in
  Darwin*) OS=macos ;;
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl
    elif [ -f /etc/os-release ]; then
      . /etc/os-release
      case "$ID" in
        arch|manjaro) OS=arch ;;
        fedora|rhel|centos|rocky|almalinux) OS=fedora ;;
        debian|ubuntu|pop|linuxmint) OS=debian ;;
        alpine) OS=alpine ;;
        opensuse*|sles) OS=suse ;;
        *) OS=linux ;;
      esac
    else OS=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) OS=unknown ;;
esac
```

Cascade for the package manager (pick the first one available):
1. `brew` (macOS + Linuxbrew) — preferred on macOS.
2. Native OS manager — `apt-get` (debian/ubuntu), `dnf` (fedora/rhel), `pacman` (arch), `zypper` (suse), `apk` (alpine).
3. `winget` (Windows 10 1809+) → `scoop` → `choco` → build-from-source as last resort on Windows.

When the preferred manager isn't installed, fall forward to the next available option rather than aborting the flow. Every `AskUserQuestion` "[Install now — …]" prompt below uses an OS-aware command table — print only the row(s) that match the detected OS.

For the authoritative cross-OS detection logic, reuse `bin/ops-setup-detect` (which emits `os`, `pkg_mgr`, `arch`, `keyring_backend`, `shell`, `browser_profiles_found` in its JSON output).

---

#### Shared: prefer OAuth over manual tokens

Whenever a channel has a **browser-based OAuth flow** available, offer that first and put manual-token entry behind it as a fallback. OAuth is safer (scoped, revocable, no secrets in dotfiles), and usually faster for the user.

| Channel        | OAuth path                                                 | Manual fallback                        |
| -------------- | ---------------------------------------------------------- | -------------------------------------- |
| Email (gog)    | `gog auth add <email> --services gmail,calendar,drive,contacts,docs,sheets` (browser) | n/a — gog is OAuth-only |
| Calendar (gog) | same `gog auth add` with calendar in `--services`          | n/a                                    |
| Slack          | `claude mcp add slack` (handles OAuth through Claude Code) | bot token via auto-scan + manual paste |
| Linear         | `claude mcp add linear`                                    | API key                                |
| Sentry         | `claude mcp add sentry`                                    | DSN / auth token                       |
| Vercel         | `claude mcp add vercel`                                    | personal access token                  |
| Telegram       | ❌ no OAuth (Bot API is token-only by design)              | auto-scan + manual paste (only option) |
| WhatsApp       | QR pairing via `whatsapp-bridge auth` (similar UX to OAuth)          | n/a — paired sessions only             |

When a channel supports OAuth, the default `AskUserQuestion` should lead with it:

```
[Connect via OAuth (recommended)]  [Enter a token manually]  [Skip]
```

Only go into the credential auto-scan flow below when the user picks "manually" or when the channel (Telegram, local tools) has no OAuth path.

---

---

## Universal Credential Auto-Scan

**BEFORE asking the user for ANY credential**, run this scan sequence. This applies to ALL steps — channels, ecommerce, marketing, voice, and MCPs. The user should never be asked to find a key that's already on their system.

**CRITICAL — exhaust ALL sources before reporting.** Run every scan source (1-10 below) in a single batch, THEN analyze the combined results. Do NOT report "no credentials found" after checking only env vars and Dashlane — Chrome history, .env files, Doppler, and keychain may have the answer. If API tokens are missing but the store/service identity was found (e.g. store URL in Chrome history, login entry in Dashlane), report what you found and skip to the token step with the identity pre-filled. The user saying "find it" or "check all available sources" means you did not search thoroughly enough — never ask the user to look for something you can find programmatically.

For each variable name (e.g. `TELEGRAM_BOT_TOKEN`, `SHOPIFY_ACCESS_TOKEN`, `KLAVIYO_API_KEY`):

1. **Current shell environment** — `printenv <VAR>`. Running shell inherits exports, Doppler injections, dotenv-loaded files. Most likely to be correct.
2. **Shell profile files** — grep `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.config/fish/config.fish`, `~/.envrc` (direnv) for `<VAR>=` or `export <VAR>=`. Show the file path next to the value so the user knows where it's from.
3. **Doppler (all projects)** — if `command -v doppler` succeeds:
   ```bash
   for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
     doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
       jq -r --arg var "$VAR" --arg proj "$proj" \
       'to_entries[] | select(.key == $var) | "\(.value.computed) (doppler:\($proj)/prd)"'
   done
   ```
   Also try the default project config (dev/staging) if prd fails. Show source attribution `(project: <slug>, config: <config>)`.
4. **Dashlane CLI** — if `command -v dcli` succeeds:
   ```bash
   dcli password "$SERVICE_KEYWORD" --output json 2>/dev/null
   ```
   Map service keywords: `shopify` → SHOPIFY vars, `klaviyo` → KLAVIYO vars, `bland` / `bland-ai` → BLAND vars, etc.
5. **macOS Keychain** — for specific services:
   ```bash
   security find-generic-password -s "$SERVICE" -w 2>/dev/null
   ```
   Use service names matching common patterns (e.g. `shopify-admin-token`, `klaviyo-api-key`, `bland-ai-api-key`).
6. **OpenClaw config** — if `~/.openclaw/openclaw.json` exists:
   ```bash
   jq -r --arg var "$VAR" '.agents.defaults.env[$var] // empty' ~/.openclaw/openclaw.json 2>/dev/null
   ```
7. **Installed MCP configs** — read each `.mcp.json` the detector found. For each server entry, look at `.env` and `.args` for the variable name or for literal values that look like the target. Show the MCP server name as the source.
8. **Plugin preferences** — check existing `$PREFS_PATH` for the key under the relevant section (e.g. `.ecom.shopify.admin_token`, `.marketing.klaviyo.api_key`). If found and not a `doppler:` reference, show it as a source.
9. **Chrome history** — for services with web admin UIs (Shopify, Klaviyo, etc.), query Chrome's History SQLite DB for admin URLs that reveal the account/store identity:
   ```bash
   sqlite3 ~/Library/Application\ Support/Google/Chrome/Default/History \
     "SELECT DISTINCT url FROM urls WHERE url LIKE '%<service_domain>%' ORDER BY last_visit_time DESC LIMIT 10" 2>/dev/null
   ```
   Extract identifiers (e.g. `*.myshopify.com` store slugs, account IDs) from the URLs.
10. **Project .env files** — scan `~/Projects/*/.env*` for the variable name or service domain patterns. These often contain credentials from other projects that can be reused.
11. **Plugin user-config.json** — read `${CLAUDE_PLUGIN_DATA_DIR:-~/.claude/plugins/data/ops-ops-marketplace}/user-config.json`. This file is written by the setup flow when keychain persistence is unavailable or when the SSE router stores credentials. Keys use underscores: `telegram_api_id`, `telegram_api_hash`, `telegram_phone`, `telegram_session`. For Slack and Telegram specifically, **always check this file** — preferences.json only stores metadata (status/source), while the actual credentials may live here.
    ```bash
    USER_CONFIG="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/user-config.json"
    [ -f "$USER_CONFIG" ] && jq -r --arg key "$VAR_UNDERSCORE" '.[$key] // empty' "$USER_CONFIG" 2>/dev/null
    ```
12. **SSE-router detection** — for any MCP server, check `~/.claude.json mcpServers.<name>.type`. If `"sse"`, the router holds auth server-side and no local credential is needed. Probe the URL:
    ```bash
    CLAUDE_JSON="$HOME/.claude.json"
    srv_type=$(jq -r --arg s "<service>" '.mcpServers[$s].type // ""' "$CLAUDE_JSON" 2>/dev/null)
    if [ "$srv_type" = "sse" ]; then
      srv_url=$(jq -r --arg s "<service>" '.mcpServers[$s].url // ""' "$CLAUDE_JSON" 2>/dev/null)
      http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$srv_url" 2>/dev/null || echo "000")
      # 200 = router is live, service is configured — do NOT prompt for credentials
    fi
    ```
    If the SSE router returns 200, report the service as `configured (source: sse_router)` and skip the credential prompt entirely.

**Env var → service keyword mapping for auto-scan:**

| Variable names | Service keyword (Dashlane/Keychain) |
| --- | --- |
| `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_STORE_URL` | `shopify` |
| `KLAVIYO_API_KEY`, `KLAVIYO_PRIVATE_KEY` | `klaviyo` |
| `META_ACCESS_TOKEN`, `FACEBOOK_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` | `meta`, `facebook` |
| `GA4_PROPERTY_ID`, `GA_MEASUREMENT_ID` | `google-analytics`, `ga4` |
| `BLAND_AI_API_KEY`, `BLAND_API_KEY` | `bland-ai`, `bland` |
| `ELEVENLABS_API_KEY` | `elevenlabs` |
| `GROQ_API_KEY` | `groq` |
| `SHIPBOB_ACCESS_TOKEN` | `shipbob` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | `telegram` |
| `SLACK_BOT_TOKEN`, `SLACK_MCP_XOXC_TOKEN` | `slack` |

**Present the findings** with `AskUserQuestion` (**max 4 options per call**):

```
Found credential for SHOPIFY_ACCESS_TOKEN:
  [A] shell env + ~/.zshrc + Dashlane — shpat_508b...682e  (matched across 3 sources)
  [B] Doppler (project: mystore, config: prd) — shpat_9f2c...a17b  (different!)
  [C] Enter a different one
```

Rules for the prompt:

- Show the **first 8 and last 4 characters** of any token, never the full value.
- **Always collapse matching sources** into one option with `(matched in env + ~/.zshrc + Dashlane)` appended. This is critical to stay within the 4-option limit.
- If sources **disagree**, show each distinct value as a separate option. If there are more than 3 distinct values (rare), batch into multiple calls with `[More sources...]`.
- Placeholder values like `${user_config.*}`, `<your-token>`, `CHANGE_ME`, or empty strings count as NOT FOUND.
- Always include an `[Enter a different one]` option as the last option.
- If NO source has a value, present the user with options via `AskUserQuestion`:

```
<SERVICE_NAME> — no credential found after scanning all sources.

  [I have it — let me paste it]
  [Deep hunt — spawn an agent to find it]
  [Skip this service]
```

  - **"I have it"** → show instructions for where to find the credential in the service's dashboard, then accept free-text input.
  - **"Deep hunt"** → spawn a Haiku subagent in the background with this mandate:

    ```
    Find the <CREDENTIAL_NAME> for <SERVICE_NAME>. Search exhaustively:
    1. All Doppler projects and configs (dev/stg/prd/ci)
    2. All .env* files across ~/Projects/ recursively
    3. macOS Keychain (security find-generic-password with various service name patterns)
    4. Dashlane CLI (dcli password <service> + related keywords)
    5. Chrome browser — navigate to <service_admin_url> via Kapture/Playwright MCP, log in if needed, and extract the credential from the settings page
    6. All shell profile files (~/.zshrc, ~/.bashrc, ~/.zprofile, ~/.envrc, ~/.config/fish/*)
    7. 1Password CLI (op item list --tags <service>) if available
    8. AWS Secrets Manager / SSM Parameter Store if aws cli authenticated

    Return the credential value if found, or a detailed report of everywhere you checked and what you found (partial matches, expired tokens, wrong-format values).
    ```

    Use `Agent(subagent_type: "general-purpose", model: "haiku")` with `run_in_background: true`. Continue to the next service while the hunt runs. When the agent returns, present findings to the user for confirmation.

  - **"Skip"** → record as skipped in `$PREFS_PATH`, move on.

**On selection**, use the chosen value as the source of truth and — with the user's consent — optionally propagate it back to the other sources (e.g. "Also update ~/.zshrc and Doppler to match?"). Default to NO for propagation unless the user opts in.

---

#### Shared: credential auto-scan

**This section applies specifically to channel tokens (Telegram, Slack).** For all other steps, see the [Universal Credential Auto-Scan](#universal-credential-auto-scan) section above — the same pattern applies everywhere.

**Before prompting the user to paste any token**, scan for it using the Universal Credential Auto-Scan sequence above. Show the user what was found and ask them to confirm or override. Never silently use a token without confirmation.

---
