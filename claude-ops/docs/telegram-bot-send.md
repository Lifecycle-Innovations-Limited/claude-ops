# Telegram bot-token push (operator self-notifications)

`bin/ops-telegram-bot-send` pushes a message to **your own** Telegram chat using a
Bot API token. It is the lightweight companion to the user-account MCP server
(`telegram-server/index.js`):

| | User-account MCP (`mcp__…telegram…`) | Bot token (`ops-telegram-bot-send`) |
|---|---|---|
| Auth | phone + 2 login codes + optional 2FA → gram.js session | one token from @BotFather |
| Reads your DMs | yes (powers `/ops-inbox telegram`) | no |
| Pushes to you | yes | yes |
| Setup cost | high (interactive login, rate-limited) | low (paste token + chat id) |
| Best for | inbox triage | one-way notifications, bidirectional round-trip with the polling listener |

If all you want is for ops skills (briefings, fire alerts, rotation results) to
**reach your phone** — and to reply via the bot back into your session through
`ops-message-listener.sh` — the bot token is the simpler path.

## Setup

1. **Create a bot** — message [@BotFather](https://t.me/BotFather), `/newbot`, copy
   the token (`123456789:AA...`).
2. **/start your bot** from your own Telegram account (a bot cannot message a user
   who has not started it).
3. **Find your numeric chat id** — message [@userinfobot](https://t.me/userinfobot);
   it replies with your `Id`.
4. **Provide the credentials** — either env vars (preferred for daemons) or
   `preferences.json`:

   ```bash
   export TELEGRAM_BOT_TOKEN="123456789:AA..."   # from @BotFather
   export TELEGRAM_OWNER_ID="123456789"          # your numeric chat id
   ```

   or in `~/.claude/plugins/data/ops-ops-marketplace/preferences.json`:

   ```json
   { "channels": { "telegram": { "bot_token": "123456789:AA...", "owner_id": "123456789" } } }
   ```

5. **Send a test:**

   ```bash
   ops-telegram-bot-send "✅ bot push works"
   # or
   echo "from stdin" | ops-telegram-bot-send
   ```

## Outbound-comms gate (Rule 6) — required self-channel exception

This script calls the Telegram Bot API, which the reference
`block-outbound-comms.py` PreToolUse hook blocks by default (the `Telegram bot`
pattern). That is correct: sending to *other people* over Telegram is
human-to-human comms and must stay gated behind per-message approval.

Sending to **your own** chat (`TELEGRAM_OWNER_ID`) is an operational
self-notification, not human-to-human comms — the same category as the existing
email / WhatsApp / iMessage self-channel exceptions. To let those through
without the one-shot approval token while keeping third-party Telegram gated,
add a self-channel exception to your personal hook
(`~/.claude/scripts/hooks/block-outbound-comms.py`):

```python
# --- with the other SELF_* loaders ---
def _load_self_telegram_ids() -> set:
    """Operator's own Telegram chat id(s). Sends here are self-notifications,
    not human-to-human comms. Sourced from env or preferences.json — never
    hardcoded (Rule 0)."""
    out = set()
    v = (os.environ.get("TELEGRAM_OWNER_ID") or "").strip()
    if v:
        out.add(v)
    try:
        with open(os.path.join(_HOME, ".claude/plugins/data/ops-ops-marketplace/preferences.json")) as f:
            oid = ((json.load(f).get("channels") or {}).get("telegram") or {}).get("owner_id")
        if oid:
            out.add(str(oid).strip())
    except (OSError, json.JSONDecodeError):
        pass
    return out

SELF_TELEGRAM_IDS = _load_self_telegram_ids()

def _telegram_curl_is_self(cmd: str) -> bool:
    """True iff every chat_id targeted by a Telegram Bot API call is the
    operator's own chat. Mixed/third-party recipients stay gated."""
    if not SELF_TELEGRAM_IDS:
        return False
    ids = re.findall(r'chat_id["\s=:&]+(-?\d+)', cmd)
    return bool(ids) and all(i in SELF_TELEGRAM_IDS for i in ids)
```

Then, in `main()`, right after `reason = detect_outbound_bash(cmd)`:

```python
        # Self-channel exception: Telegram Bot API sends to the operator's own
        # chat are operational notifications, not human-to-human comms.
        if reason == 'Telegram bot' and _telegram_curl_is_self(cmd):
            reason = None
```

With that in place, `ops-telegram-bot-send` (default recipient = owner) flows
freely; any `--to <other-chat>` or third-party bot send still trips the gate and
requires the approval token. This mirrors `_bash_recipient_is_self` (email),
`SELF_JIDS` (WhatsApp), and `_imessage_chat_id_is_self` (iMessage).

## Bidirectional round-trip

Pair this with `ops-message-listener.sh` (polls `getUpdates` with the same bot
token) for a full loop: you DM the bot → the listener enqueues → your session
resumes with the message → replies go back out via `ops-telegram-bot-send`. No
user-account session required.
