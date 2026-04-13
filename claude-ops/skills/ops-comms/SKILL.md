---
name: ops-comms
description: Send and read messages across all channels. Routes based on arguments — whatsapp, email, slack, telegram, or natural language like "send [msg] to [contact]".
argument-hint: "[channel] | send [message] to [contact] | read [channel]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - mcp__claude_ai_Gmail__gmail_search_messages
  - mcp__claude_ai_Gmail__gmail_read_thread
  - mcp__claude_ai_Gmail__gmail_create_draft
  - mcp__claude_ai_Slack__slack_send_message
  - mcp__claude_ai_Slack__slack_read_channel
  - mcp__claude_ai_Slack__slack_search_users
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ops_telegram__send_message
  - mcp__claude_ops_telegram__get_updates
  - mcp__claude_ops_telegram__list_chats
effort: medium
maxTurns: 40
---

# OPS ► COMMS

## Runtime Context

Before executing, load available context:

1. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-health.json`
   - Check `wacli-sync` status before any WhatsApp operation
   - Also check `~/.wacli/.health` — if not `status=connected`, surface auth issue before proceeding

2. **Ops memories**: Before drafting any message, check `${CLAUDE_PLUGIN_DATA_DIR}/memories/`:
   - `contact_*.md` — load profile for the recipient
   - `preferences.md` — match user's communication style, language, and tone
   - `donts.md` — restrictions that must not appear in any draft

3. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` for `default_channels` to determine which channel to prefer when multiple are available for a contact.

## CLI/API Reference

### wacli (WhatsApp)

**Health file** — check `~/.wacli/.health` BEFORE any wacli command:
- `status=connected` → proceed
- `status=needs_auth` or `status=needs_reauth` → prompt user for QR scan, do NOT run wacli commands

| Command | Usage | Output |
|---------|-------|--------|
| `wacli doctor --json` | Check auth/connected/lock/FTS | `{data: {authenticated, connected, lock_held, fts_enabled}}` |
| `wacli chats list --json` | All chats | `{data: [{JID, Name, Kind, LastMessageTS}]}` |
| `wacli messages list --chat "<JID>" --limit N --json` | Messages for chat | `{data: {messages: [{FromMe, Text, Timestamp, SenderName, ChatName}]}}` |
| `wacli messages search --query "<text>" --json` | FTS search | Same as above |
| `wacli contacts --search "<name>" --json` | Contact lookup | Contact objects |
| `wacli send --to "<JID>" --message "<msg>"` | Send text | Success/error |

### gog CLI (Gmail/Calendar)

| Command | Usage | Output |
|---------|-------|--------|
| `gog gmail search -j --results-only --no-input --max 30 "in:inbox"` | Search inbox | JSON array of threads |
| `gog gmail read -j --no-input "<thread_id>"` | Read thread | Full message JSON |
| `gog gmail send -j --to "<email>" --subject "<subj>" --body "<body>"` | Send email | Send result |
| `gog gmail labels modify --remove INBOX <thread_ids>` | Archive | Label change |

---

Parse `$ARGUMENTS` and route immediately:

## Routing table

| Pattern       | Action                                                  |
| ------------- | ------------------------------------------------------- |
| `whatsapp`    | Show WhatsApp recent chats — offer to read or send      |
| `email`       | Show recent email threads via Gmail MCP                 |
| `slack`       | Show recent Slack activity                              |
| `telegram`    | Show Telegram recent chats                              |
| `send * to *` | Parse message and contact, determine best channel, send |
| `read *`      | Read the specified channel or contact's messages        |
| (empty)       | Show channel picker menu                                |

---

## Send flow: `send [message] to [contact]`

1. Parse contact name and message from `$ARGUMENTS`.
2. Determine channel by contact lookup:
   - Check WhatsApp: `wacli contacts --search "[contact]" --json 2>/dev/null`
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
1. Read the full conversation: `wacli messages list --chat "<JID>" --limit 20 --json`
2. Understand which messages are from the user (`FromMe: true`) vs the contact
3. Summarize what the conversation is about and what the contact is asking
4. Only THEN draft a reply that addresses what the contact actually said

**Never send a reply based on a single message.** A message like "can you pull it from Klaviyo?" means nothing without knowing what "it" refers to from prior messages.

**Pre-flight:** Before any wacli command, check `~/.wacli/.health`. If `status=needs_auth` or `status=needs_reauth`, prompt the user: "WhatsApp needs re-authentication. Run `wacli auth` in a separate terminal and scan the QR code, then type 'done'." Use `AskUserQuestion`: `[Done — re-paired]`, `[Skip WhatsApp]`. On Done, restart daemon: `launchctl kickstart -k gui/$(id -u)/com.claude-ops.wacli-keepalive`, wait 5s.

```bash
wacli send --to "[contact]" --message "[message]"
```

### Slack send

Use `mcp__claude_ai_Slack__slack_send_message` with resolved channel/user ID.

### Email send (draft)

Use `mcp__claude_ai_Gmail__gmail_create_draft` — always create draft first. Then use `AskUserQuestion`:
```
Draft created for [recipient]:
  Subject: [subject]
  Body: [preview]

  [Send now]  [Keep as draft]  [Edit]
```

---

## Read flow: `read [channel]`

**WhatsApp:**

```bash
wacli chats --limit 10 --json 2>/dev/null
```

Show last 10 chats with sender, preview, timestamp.

**Email:**
Use `mcp__claude_ai_Gmail__gmail_search_messages` with `query: "is:unread"`, show thread list.

**Slack:**
Use `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "is:unread"`.

**Telegram:**
Use `mcp__claude_ops_telegram__get_updates` (limit: 20) and `mcp__claude_ops_telegram__list_chats`.
Fall back to: `telegram-cli --exec "dialog_list" 2>/dev/null || echo "Telegram MCP not configured"`

### Telegram send

Use `mcp__claude_ops_telegram__send_message` with `chat_id` (from list_chats) and `text`.

---

## Empty arguments — channel picker

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► COMMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 a) Read WhatsApp
 b) Read Email
 c) Read Slack
 d) Read Telegram
 e) Send a message

 Or type: send [message] to [contact]
──────────────────────────────────────────────────────
```

Use AskUserQuestion, then execute.
