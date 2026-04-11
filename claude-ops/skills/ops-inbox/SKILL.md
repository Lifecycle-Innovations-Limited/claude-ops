---
name: ops-inbox
description: Inbox zero across all channels — WhatsApp (wacli), Email (Gmail MCP), Slack (MCP), Telegram (MCP). Shows unread counts, lets user process messages channel by channel or all at once.
argument-hint: "[channel: whatsapp|email|slack|telegram|all]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__claude_ai_Gmail__gmail_search_messages
  - mcp__claude_ai_Gmail__gmail_read_thread
  - mcp__claude_ai_Gmail__gmail_read_message
  - mcp__claude_ai_Gmail__gmail_create_draft
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ai_Slack__slack_read_channel
  - mcp__claude_ai_Slack__slack_read_thread
  - mcp__claude_ai_Slack__slack_send_message
  - mcp__claude_ops_telegram__send_message
  - mcp__claude_ops_telegram__get_updates
  - mcp__claude_ops_telegram__list_chats
---

# OPS ► INBOX ZERO

## Pre-gathered unread counts

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-unread 2>/dev/null || echo '{}'
```

## Your task

1. **Parse the pre-gathered data** to get unread counts per channel.

2. **Fetch live Slack unreads** in parallel: call `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "is:unread"`. If pre-gathered count is -1, this is the source of truth.

3. **Display the inbox summary:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► INBOX ZERO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 📱 WhatsApp    [N unread from X chats]
 📧 Email       [N unread threads]
 💬 Slack       [N mentions / N DMs]
 ✈️  Telegram   [N unread]

──────────────────────────────────────────────────────
 Process:
 a) All channels (fastest — one pass)
 b) WhatsApp only
 c) Email only
 d) Slack only
 e) Telegram only
 f) Skip — already done

 → Pick a channel or letter
──────────────────────────────────────────────────────
```

Use AskUserQuestion. Then process the selected channel(s).

---

## Processing each channel

### WhatsApp
Run: `wacli chats --unread --json 2>/dev/null` to list unread chats.
For each chat, show:
```
[Contact/Group] — [N messages] — [preview of latest]
  a) Reply
  b) Mark read
  c) Skip
```
Use `wacli send --to "[contact]" --message "[msg]"` to reply.

### Email
Use `mcp__claude_ai_Gmail__gmail_search_messages` with `query: "is:unread"`, `maxResults: 20`.
For each thread, show sender, subject, preview. Options:
```
  a) Read full thread
  b) Reply (draft via gmail_create_draft)
  c) Archive (mark read)
  d) Skip
```

### Slack
Use `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "is:unread"` for mentions.
For each result, show channel, sender, preview. Use `mcp__claude_ai_Slack__slack_read_thread` for context.
Options:
```
  a) Read thread
  b) Reply
  c) Mark read / skip
```

### Telegram
Use `mcp__claude_ops_telegram__get_updates` (limit: 50) to fetch recent messages.
Use `mcp__claude_ops_telegram__list_chats` to see known chats.
For each unread message, show sender, chat, preview:
```
[Contact/Chat] — [preview]
  a) Reply (send_message)
  b) Skip
```
Use `mcp__claude_ops_telegram__send_message` with chat_id and text to reply.
If Telegram MCP is unavailable, fall back to: `telegram-cli --exec "dialog_list" 2>/dev/null || echo "Telegram not configured"`.

---

## Completion

After all selected channels are processed, print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 INBOX ZERO ✓ — [timestamp]
 Processed: [N] messages | Replied: [N] | Archived: [N]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If `$ARGUMENTS` specifies a channel (e.g. `whatsapp`), skip the menu and go directly to that channel.
