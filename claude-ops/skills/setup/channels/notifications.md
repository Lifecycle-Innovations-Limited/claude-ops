### 3n — Notifications (fires-watcher sinks)

Sets up push notifications for CRITICAL/HIGH fires so the user stops having to poll `/ops:fires` manually. Gated behind the `fires-watcher` daemon service (disabled by default).

**Before prompting**, run the sink auto-scan **in background** (Rule 4 — all parallel):

```bash
# Already-configured sinks (env + $PREFS_PATH)
printenv TELEGRAM_BOT_TOKEN TELEGRAM_NOTIFY_CHAT_ID TELEGRAM_OWNER_ID \
         DISCORD_WEBHOOK_URL NTFY_TOPIC PUSHOVER_USER PUSHOVER_TOKEN 2>/dev/null

jq -r 'to_entries
       | map(select(.key | test("telegram_bot_token|telegram_notify_chat_id|discord_webhook_url|ntfy_topic|pushover_user_key|pushover_app_token")))
       | .[] | "\(.key)=\(.value | if type == "string" and length > 6 then .[0:6] + "***" else . end)"' \
       "$PREFS_PATH" 2>/dev/null

# Macro: is the Telegram bot already configured via /ops:setup telegram?
jq -r '.telegram.bot_token // empty, .telegram.owner_id // empty' "$PREFS_PATH" 2>/dev/null
```

Cache the results. Then **filter the option list to what isn't already configured** (Rule 1 — max 4).

Present via `AskUserQuestion` (≤4 options). Typical first batch:

| Option                              | Header   | Description                                                                    |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Use Telegram (recommended)          | telegram | Reuse the bot you already configured in 3a. Zero extra setup.                  |
| Configure ntfy.sh                   | ntfy     | Free, no account. Pick a random topic, install the app on your phone.          |
| Configure Pushover                  | pushover | ~$5 one-time. Highest-reliability mobile delivery with priority bypass for P0. |
| Skip — poll with /ops:fires instead | skip     | Leaves `fires-watcher` disabled. You'll keep asking for fires manually.        |

If Telegram's bot token + owner ID aren't already in `$PREFS_PATH`, swap `[Use Telegram]` for `[Configure Telegram bot — jump to 3a]` and re-enter 3a before returning here. Per Rule 3, don't silently skip — always offer an explicit `[Skip]`.

For anyone who wants Discord on top (many users want both team + personal delivery), run a second `AskUserQuestion`:

| Option                      | Header  | Description                                       |
| --------------------------- | ------- | ------------------------------------------------- |
| Also add Discord webhook    | discord | Fan out to a #incidents channel in addition to X. |
| No — just the sink I picked | done    | Single-sink setup.                                |

#### Per-sink capture

**Telegram** — if `$TELEGRAM_NOTIFY_CHAT_ID` is empty, default it to `$TELEGRAM_OWNER_ID` (the bot will DM the owner) and save `{"telegram_notify_chat_id": "<owner_id>"}` to `$PREFS_PATH`. Smoke-test in background (Rule 4):

```bash
scripts/ops-notify.sh LOW "setup test" "fires-watcher Telegram sink is live" &
```

**ntfy.sh** — generate a random topic if the user has none:

```bash
TOPIC="claude-ops-fires-$(openssl rand -hex 6 2>/dev/null || head -c 12 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 12)"
echo "$TOPIC"
```

Show the topic and install instructions (`open https://ntfy.sh/<topic>` in a browser, or scan the QR in the ntfy mobile app). Save to `$PREFS_PATH` under `ntfy_topic`.

**Pushover** — per Rule 3 offer: `[Paste user key + app token]` / `[Deep hunt — spawn agent]` / `[Skip]`. On paste, validate with a smoke-test in background (Rule 4):

```bash
curl -s -X POST https://api.pushover.net/1/messages.json \
  --data-urlencode "token=$PUSHOVER_TOKEN" \
  --data-urlencode "user=$PUSHOVER_USER" \
  --data-urlencode "title=claude-ops setup test" \
  --data-urlencode "message=fires-watcher Pushover sink is live" &
```

Expect `{"status":1,...}` within 5 s.

**Discord** — if the user already set `discord_default_webhook_url` via a prior run (or issue #20's work), reuse it; otherwise Rule-3-prompt for a webhook URL (`https://discord.com/api/webhooks/...`).

#### Save + enable daemon service

Write to `$PREFS_PATH` (merge, never overwrite unrelated keys):

```json
{
  "notifications": {
    "configured_sinks": ["telegram", "ntfy"],
    "configured_at": "<ISO timestamp>"
  },
  "telegram_notify_chat_id": "<chat_id>",
  "ntfy_topic": "<topic>"
}
```

Then **enable the daemon service** in background (Rule 4):

```bash
jq '.services["fires-watcher"].enabled = true' \
   ~/.claude/plugins/data/ops-ops-marketplace/daemon-services.json \
  > /tmp/daemon-services.json.new && \
  mv /tmp/daemon-services.json.new ~/.claude/plugins/data/ops-ops-marketplace/daemon-services.json && \
  scripts/ops-daemon.sh restart &
```

Confirm the watcher is alive after restart:

```bash
cat ~/.claude/plugins/data/ops-ops-marketplace/fires-watcher.health 2>/dev/null
```

Expect `{"status": "ok", ...}` within 60 seconds.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/docs/notifications.md`, `${CLAUDE_PLUGIN_ROOT}/scripts/ops-fires-watcher.sh`, and `${CLAUDE_PLUGIN_ROOT}/scripts/ops-notify.sh` for sink priority rationale, debounce rules, and a troubleshooting walk-through.
