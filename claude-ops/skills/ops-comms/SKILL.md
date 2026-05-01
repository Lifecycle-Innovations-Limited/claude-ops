---
name: ops-comms
description: Send and read messages across all channels. Routes based on arguments — whatsapp, email, slack, telegram, discord, notion, or natural language like "send [msg] to [contact]". WhatsApp via mcp__whatsapp__* (Baileys bridge).
argument-hint: "[channel] | send [message] to [contact] | read [channel] | notion [search query]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - mcp__claude_ai_Gmail__search_threads
  - mcp__claude_ai_Gmail__get_thread
  - mcp__claude_ai_Gmail__create_draft
  - mcp__claude_ai_Slack__slack_send_message
  - mcp__claude_ai_Slack__slack_read_channel
  - mcp__claude_ai_Slack__slack_search_users
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ops_telegram__send_message
  - mcp__claude_ops_telegram__get_updates
  - mcp__claude_ops_telegram__list_chats
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-fetch
  - mcp__claude_ai_Notion__notion-get-comments
  - mcp__claude_ai_Notion__notion-create-comment
  - mcp__claude_ai_Notion__notion-update-page
  - mcp__claude_ai_Notion__notion-create-pages
effort: medium
maxTurns: 40
---

# OPS ► COMMS

## Runtime Context

Before executing, load available context:

1. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-health.json`
   - Check bridge liveness before any WhatsApp operation: `lsof -i :8080 | grep LISTEN`
   - If bridge not running, prompt user to restart: `launchctl kickstart -k gui/$UID/com.samrenders.whatsapp-bridge`

2. **Ops memories**: Before drafting any message, check `${CLAUDE_PLUGIN_DATA_DIR}/memories/`:
   - `contact_*.md` — load profile for the recipient
   - `preferences.md` — match user's communication style, language, and tone
   - `donts.md` — restrictions that must not appear in any draft

3. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` for `default_channels` to determine which channel to prefer when multiple are available for a contact.

## CLI/API Reference

### whatsapp-bridge (WhatsApp — mcp__whatsapp__*)

**Bridge health** — check bridge is running before any WhatsApp operation:
```bash
lsof -i :8080 | grep LISTEN
launchctl list com.samrenders.whatsapp-bridge
```
If not running: `launchctl kickstart -k gui/$(id -u)/com.samrenders.whatsapp-bridge`

| Tool | Params | Output |
|------|--------|--------|
| `mcp__whatsapp__list_chats` | `{sort_by: "last_active"}` | Array of chats with jid, name, last_message_time |
| `mcp__whatsapp__list_messages` | `{chat_jid, limit, query}` | Array of messages with is_from_me, content, timestamp, sender |
| `mcp__whatsapp__search_contacts` | `{query}` | Contacts matching name or phone |
| `mcp__whatsapp__send_message` | `{recipient, message}` | Send result |
| `mcp__whatsapp__get_chat` | `{chat_jid}` | Chat metadata |
| `mcp__whatsapp__get_message_context` | `{chat_jid, message_id}` | Message context window |

### gog CLI (Gmail/Calendar)

| Command | Usage | Output |
|---------|-------|--------|
| `gog gmail search "in:inbox" --max 50 -j --results-only --no-input` | Search inbox | JSON array of threads |
| `gog gmail thread get <threadId> -j` | Get full thread with all messages | Full message JSON |
| `gog gmail send --to "user@example.com" --subject "subj" --body "text"` | Send new email | Send result |
| `gog gmail send --reply-to-message-id <msgId> --reply-all --body "text"` | Reply all | Send result |
| `gog gmail send --to "a@b.com" --subject "subj" --body "text" --attach /path/file` | With attachment | Send result |
| `gog gmail archive <messageId> ... --no-input --force` | Archive messages | Archive result |

---

Parse `$ARGUMENTS` and route immediately:

## Routing table

| Pattern       | Action                                                  |
| ------------- | ------------------------------------------------------- |
| `whatsapp`    | Show WhatsApp recent chats — offer to read or send      |
| `email`       | Show recent email threads via Gmail MCP                 |
| `slack`       | Show recent Slack activity                              |
| `telegram`    | Show Telegram recent chats                              |
| `discord`     | Show recent Discord channel activity (via bin/ops-discord) |
| `notion`      | Search Notion workspace — pages, comments, tasks          |
| `send * to *` | Parse message and contact, determine best channel, send |
| `read *`      | Read the specified channel or contact's messages        |
| (empty)       | Show channel picker menu                                |

Natural-language parsing: phrases like `send "deploy done" to #general on discord` or `to #ops-alerts on Discord` should resolve to the `discord` branch below. Extract the channel token (the word after `#`, case-insensitive) and pass it as the first arg to `bin/ops-discord send`.

---

## Send flow: `send [message] to [contact]`

1. Parse contact name and message from `$ARGUMENTS`.
2. Determine channel by contact lookup:
   - Check WhatsApp: `mcp__whatsapp__search_contacts {query: "[contact]"}` 2>/dev/null
   - Check Slack: `mcp__claude_ai_Slack__slack_search_users` with `query: "[contact]"`
   - Check email: known from context or ask
3. If multiple channels found, use `AskUserQuestion`: `[WhatsApp]` / `[Slack]` / `[Email]`
4. **Always preview before sending.** Use `AskUserQuestion` to confirm:

```
Ready to send via [channel]:
  To: [contact name] ([identifier])
  Message: "[full message text]"

  [Send now]  [Edit message]  [Cancel]
```

If user picks "Edit message", use `AskUserQuestion` with free-text to get the revised message, then re-preview.

5. Send via the chosen channel. Confirm with: `Sent to [contact] via [channel] ✓`

### WhatsApp send

**CRITICAL — READ BEFORE SENDING:** Before drafting ANY WhatsApp reply, you MUST:
1. Read the full conversation: `mcp__whatsapp__list_messages {chat_jid: "<JID>", limit: 20}`
2. Understand which messages have `is_from_me: true` (user sent) vs `is_from_me: false` (contact sent)
3. Summarize what the conversation is about and what the contact is asking
4. Only THEN draft a reply that addresses what the contact actually said

**Never send a reply based on a single message.** A message like "can you pull it from Klaviyo?" means nothing without knowing what "it" refers to from prior messages.

**Pre-flight:** Check bridge is running: `lsof -i :8080 | grep LISTEN`. If not running, restart: `launchctl kickstart -k gui/$(id -u)/com.samrenders.whatsapp-bridge` and wait 5s.

```
mcp__whatsapp__send_message {recipient: "[contact_jid]", message: "[message]"}
```

### Slack send

Use `mcp__claude_ai_Slack__slack_send_message` with resolved channel/user ID.

### Email send (draft)

Use `mcp__claude_ai_Gmail__create_draft` — always create draft first. Then use `AskUserQuestion`:
```
Draft created for [recipient]:
  Subject: [subject]
  Body: [preview]

  [Send now]  [Keep as draft]  [Edit]
```

---

## Read flow: `read [channel]`

**WhatsApp:**

```
mcp__whatsapp__list_chats {sort_by: "last_active"}
```

Show last 10 chats with sender, preview, timestamp. Use `mcp__whatsapp__list_messages {chat_jid, limit: 5}` to preview each chat.

**Email:**
Use `mcp__claude_ai_Gmail__search_threads` with `query: "in:inbox"` (NOT `is:unread` — scan full inbox including read messages), show thread list.

**Slack (multi-workspace):**

Read `preferences.json` → `slack_workspaces[]`. Iterate all entries:
- For each `available: true` entry, use `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "in:channel"` (NOT `is:unread`) if the MCP token matches, or direct curl for non-bound workspaces.
- Label results with the workspace name: `Slack/lifecycle`, `Slack/stagery`, etc.
- **0 workspaces / legacy mode**: fall back to `mcp__claude_ai_Slack__slack_search_public_and_private` if `SLACK_MCP_ENABLED=true`, otherwise report "Slack not configured".

**Telegram:**
Use `mcp__claude_ops_telegram__get_updates` (limit: 20) and `mcp__claude_ops_telegram__list_chats`.
Fall back to: `telegram-cli --exec "dialog_list" 2>/dev/null || echo "Telegram MCP not configured"`

**Discord:**
`${CLAUDE_PLUGIN_ROOT}/bin/ops-discord read "<CHANNEL_ID>" --limit 20 --json` — requires `DISCORD_BOT_TOKEN` (or credential-store `discord/bot-token`). Fall back to `bin/ops-discord channels --json` if the user doesn't know the channel ID and `DISCORD_GUILD_ID` is set.

**Notion:**
Use `mcp__claude_ai_Notion__notion-search` with the user's query (or `query: ""` sorted by `last_edited_time` for general browsing). For each result:
- Fetch full page content with `mcp__claude_ai_Notion__notion-fetch` using the page URL/ID from search results
- Get comments with `mcp__claude_ai_Notion__notion-get-comments`
- Show page title, database name, last editor, and recent comments

**Notion API fallback:** If MCP tools fail and `NOTION_API_KEY` is set, use `curl -s -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2022-06-28" -X POST https://api.notion.com/v1/search -d '{"query":"<QUERY>","page_size":10}'`

### Notion comment/reply

Use `mcp__claude_ai_Notion__notion-create-comment` with the page ID to reply to a comment thread. For creating new pages in a database, use `mcp__claude_ai_Notion__notion-create-pages`.

Always preview before commenting:
```
Ready to comment on Notion page:
  Page: [page title]
  Comment: "[comment text]"

  [Post comment]  [Edit]  [Cancel]
```

### Telegram send

Use `mcp__claude_ops_telegram__send_message` with `chat_id` (from list_chats) and `text`.

### Discord send

Shell out to `bin/ops-discord send`. Three invocation shapes:

```bash
# By channel alias (resolves DISCORD_WEBHOOK_<UPPER> or DISCORD_WEBHOOK_URL)
${CLAUDE_PLUGIN_ROOT}/bin/ops-discord send "<channel-alias>" "<message>" --json

# By channel snowflake (17-20 digit ID, routed through bot token)
${CLAUDE_PLUGIN_ROOT}/bin/ops-discord send "<CHANNEL_ID>" "<message>" --json

# By full webhook URL (useful when the URL is stored per-project)
${CLAUDE_PLUGIN_ROOT}/bin/ops-discord send "https://discord.com/api/webhooks/<ID>/<TOKEN>" "<message>" --json
```

If the script exits 1 with `{"error":"no discord credential configured — run /ops:setup discord"}`, prompt the user via `AskUserQuestion` (≤4 options per Rule 1): `[Run /ops:setup discord]` / `[Paste webhook URL now]` / `[Skip]`. Do NOT silently skip — that violates Rule 3.

Note: `DISCORD_WEBHOOK_URL` is shared with the ops-fires notification sink (`scripts/ops-notify.sh`). When pre-existing, prefer it as the default for `/ops:comms discord send` rather than asking the user to set a separate value.

---

## Empty arguments — channel picker

Display the header, then use **batched AskUserQuestion calls** (max 4 options each):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► COMMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Before presenting options**, read `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` and check which channels are configured. Only show configured channels. If <=4 total options (configured channels + "Send a message"), present in a single call. If >4, batch:

AskUserQuestion call 1 — Read channels:
```
  [Read WhatsApp]
  [Read Email]
  [Read Slack]
  [More...]
```

AskUserQuestion call 2 (only if "More..."):
```
  [Read Telegram]
  [Send a message]
```

If all channels are configured, that's 5 options — always batch. If only 3 channels are configured, "Read X" + "Read Y" + "Read Z" + "Send a message" = 4, fits in one call.

Execute the selected action.
