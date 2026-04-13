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
---

# OPS ► COMMS

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
