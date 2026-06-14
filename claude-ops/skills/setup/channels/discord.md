### 3m — Discord (webhook + optional bot)

Discord is a v1 integration — webhook-based send + REST channel reads. DM + gateway support are deferred to a v2 issue. The send-side webhook also supplies the Discord notification sink consumed by `scripts/ops-notify.sh`, so configuring it here covers both `/ops:comms discord send` and ops-fires alerts.

**Before showing the credential prompt**, run the Universal Credential Auto-Scan for Discord (Rule 4 — background every bash call unless the next step depends on it):

```bash
# Shell env
printenv DISCORD_BOT_TOKEN DISCORD_WEBHOOK_URL DISCORD_GUILD_ID 2>/dev/null

# Shell profiles + .envrc
grep -hE 'DISCORD_(BOT_TOKEN|WEBHOOK|GUILD_ID)' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# Doppler across all projects
for proj in $(doppler projects --json 2>/dev/null | jq -r '.[].slug'); do
  doppler secrets --project "$proj" --config prd --json 2>/dev/null | \
    jq -r --arg proj "$proj" 'to_entries[] | select(.key | test("DISCORD")) | "\(.key)=\(.value.computed) (doppler:\($proj)/prd)"'
done

# 1Password
op item list --categories "API Credential" --format json 2>/dev/null | \
  jq -r '.[] | select(.title | test("discord"; "i")) | .id' | \
  while read id; do op item get "$id" --format json 2>/dev/null; done

# Dashlane / Bitwarden
dcli password discord --output json 2>/dev/null
bw list items --search discord 2>/dev/null | jq -r '.[] | select(.login.password) | .login.password' | head -1

# macOS Keychain (Darwin only — the setup wizard already guards this at the OS level)
security find-generic-password -s "discord" -w 2>/dev/null

# Claude-ops credential store (cross-OS)
"${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh" get discord bot-token 2>/dev/null
```

Cache these results. Also check `$PREFS_PATH` under `discord.*` and `discord_webhook_url` (the flat key shared with ops-notify.sh) — if any of `discord.bot_token`, `discord.default_webhook_url`, or `discord_webhook_url` is already present, show `✓ Discord — already configured` and offer `[Keep]` / `[Reconfigure]`.

#### If anything was found

Present via the Universal Credential Auto-Scan prompt format with `[Use this value]` / `[Paste a different one]` / `[Skip]`. If a webhook URL was found but no bot token, note that reads + channel listing will be unavailable (send-only).

#### Per Rule 3 — if nothing was found, ask explicitly (≤4 options per Rule 1)

```
No Discord credentials found. How do you want to configure Discord?
  [Paste bot token]
  [Paste webhook URL only]
  [Deep hunt — spawn agent]
  [Skip — I'll configure later]
```

On `[Deep hunt — spawn agent]`, spawn a background research agent (Rule 4 — `run_in_background: true`):

```
Agent(
  subagent_type: "general-purpose",
  model: "haiku",
  run_in_background: true,
  prompt: "Grep the filesystem under $HOME (excluding node_modules, .git, Library/Caches) for Discord credentials. Patterns: bot tokens look like base64 segments separated by dots (e.g. MTAxXXXX.YYYYYY.ZZZZZZZZZZZZ), webhook URLs start with https://discord.com/api/webhooks/ or https://discordapp.com/api/webhooks/, guild IDs are 17-20 digit snowflakes adjacent to the word 'guild' or 'server'. Also scan ~/.config, ~/.env, any .envrc files, and Doppler/1Password exports. Return every hit with file path + line number + 6-char redacted prefix. Do not print full tokens."
)
```

While the hunt runs, continue with the next setup sub-step; return to Discord when the agent reports back and present findings via `AskUserQuestion` (paginate to ≤4 per Rule 1).

On `[Paste bot token]`:

```
Enter your Discord Bot Token:
  Find it: https://discord.com/developers/applications → your app → Bot → Reset Token
  Format: MTAxXXXX.YYYYYY.ZZZZZZZZZZZZZZ  (base64 dot-separated)
  Prefer a Doppler reference (doppler:DISCORD_BOT_TOKEN) over the raw value.

Enter your Discord Guild ID (optional — needed for `channels` listing):
  Enable Developer Mode in Discord → right-click server → Copy ID.
```

Smoke test (background via Bash per Rule 4):

```bash
curl -sS "https://discord.com/api/v10/users/@me" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "User-Agent: ops-discord (claude-ops, v1)" | jq '.id // .message'
```

Expect a numeric snowflake `id`. If the response is `{"message":"401: Unauthorized", ...}`, re-ask.

On `[Paste webhook URL only]`:

```
Enter a default Discord Webhook URL:
  Find it: Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy URL
  Format: https://discord.com/api/webhooks/<ID>/<TOKEN>
```

Smoke test — do NOT send content to the webhook during setup. Instead, issue a GET to confirm the URL resolves to webhook metadata:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X GET "$DISCORD_WEBHOOK_URL"
```

Expect `200` (webhook metadata returned) or `401` (valid URL, token invalid — user needs to re-copy).

#### Save to preferences

Write to `$PREFS_PATH` (merge):

```json
{
  "discord": {
    "bot_token": "doppler:DISCORD_BOT_TOKEN",
    "guild_id": "<GUILD_ID>",
    "default_webhook_url": "doppler:DISCORD_WEBHOOK_URL",
    "configured_at": "<ISO timestamp>"
  },
  "discord_webhook_url": "doppler:DISCORD_WEBHOOK_URL"
}
```

Mirror the webhook to the flat `discord_webhook_url` key so `scripts/ops-notify.sh` (the existing fires sink) continues to find it. Prefer a Doppler reference over raw tokens when Doppler is configured. Prefer the credential-store (`ops_cred_set discord bot-token <value>`) over plaintext prefs on systems with a native keyring. If the user picked `[Skip]`, save `{"discord": "skipped"}` so the wizard doesn't re-prompt on the next run.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` (Discord send/read sections) and `${CLAUDE_PLUGIN_ROOT}/bin/ops-discord` for full operational instructions and subcommand reference.

---
