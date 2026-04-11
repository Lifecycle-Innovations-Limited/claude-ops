# claude-ops Telegram MCP Server

User-auth Telegram MCP server for the `/ops:ops-inbox` skill. Authenticates as a **personal Telegram account** via MTProto (gram.js), not as a BotFather bot, so it can read and reply to real DM conversations.

## Why user-auth, not bot?

Bots cannot read messages sent in private chats between two users — only messages sent directly to the bot. For the `/ops:ops-inbox` use case (managing Sam's personal inbox), we must authenticate as the user's account.

## Setup

### 1. Get API credentials

Go to https://my.telegram.org/apps and create a **personal** application (not a bot). You'll get:
- `api_id` (integer)
- `api_hash` (32-char string)

### 2. Install dependencies

```bash
cd claude-ops/telegram-server
npm install
```

### 3. First-run authentication (interactive)

```bash
TELEGRAM_API_ID=12345 \
TELEGRAM_API_HASH=abcdef... \
TELEGRAM_PHONE=+15551234567 \
node index.js --auth
```

The script will prompt for an SMS code and (if enabled) your 2FA password. On success it prints a `TELEGRAM_SESSION` string — save this securely (it's your session token).

### 4. Configure MCP server in Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/claude-ops/telegram-server/index.js"],
      "env": {
        "TELEGRAM_API_ID": "${TELEGRAM_API_ID}",
        "TELEGRAM_API_HASH": "${TELEGRAM_API_HASH}",
        "TELEGRAM_SESSION": "${TELEGRAM_SESSION}",
        "TELEGRAM_PHONE": "${TELEGRAM_PHONE}"
      }
    }
  }
}
```

Export the env vars from a secret manager (Doppler, 1Password, direnv — **never commit**):

```bash
export TELEGRAM_API_ID="..."
export TELEGRAM_API_HASH="..."
export TELEGRAM_SESSION="..."   # from step 3
export TELEGRAM_PHONE="+1..."
export TELEGRAM_ENABLED=true    # enables in ops-unread detection
```

Restart Claude Code to load the MCP server.

## Tools

| Tool | Description |
|---|---|
| `list_dialogs` | List recent conversations (DMs, groups, channels) with unread counts |
| `get_messages` | Fetch messages from a specific chat |
| `send_message` | Send a message to a chat or user |
| `search_messages` | Full-text search across all conversations |

## Security

- **Never commit `TELEGRAM_SESSION`** — it's equivalent to your password
- Session tokens are device-bound; if stolen, log out via Telegram app → Settings → Devices
- All credentials come from environment variables; nothing is hardcoded in this repo
- The server runs over stdio (local only); no network exposure beyond Telegram's official API

## Troubleshooting

**"Session is no longer valid"**: Re-run `node index.js --auth` to generate a fresh session.

**"TELEGRAM_API_ID is required"**: The env vars aren't being passed to the MCP server. Check your `~/.claude/settings.json` env block.

**Rate limiting**: Telegram enforces per-account limits. If you hit one, wait 15-30 minutes before retrying.
