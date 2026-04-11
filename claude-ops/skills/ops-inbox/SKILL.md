---
name: ops-inbox
description: Full inbox management across all channels — WhatsApp (wacli), Email (Gmail MCP), Slack (MCP), Telegram (user-auth MCP). Scans FULL inbox (not just unread), identifies messages needing replies, archives handled conversations.
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
  # Telegram: user-auth MCP tools will be added when available
  # Do NOT use bot-based MCP tools — inbox requires user account access
---

# OPS ► INBOX ZERO

## Pre-gathered data

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-unread 2>/dev/null || echo '{}'
```

## Core principle: FULL INBOX SCAN

Do NOT just check unread. Scan the FULL recent inbox for each channel and classify every conversation:
- **NEEDS REPLY** — other party sent last message, awaiting your response
- **WAITING** — you sent last message, waiting for them (no action needed)
- **HANDLED** — conversation concluded, can be archived
- **FYI** — newsletters, notifications, automated messages (bulk archive)

## Your task

1. **Parse pre-gathered data** for initial counts (unread is just a starting signal).

2. **For each channel, run a FULL scan** (not just unread):

   - **Email**: Search `in:inbox` (not `is:unread`) via Gmail MCP. For each thread, read the last message to determine who sent it last (you or them). Classify as NEEDS REPLY / WAITING / FYI.
   - **WhatsApp**: Run `wacli chats list --json` to get ALL non-archived chats. For each with recent activity (last 7 days), fetch last 3 messages via `wacli messages list --chat <JID> --limit 3 --json`. If last message is NOT from you → NEEDS REPLY. If last message IS from you → WAITING. Archive handled ones.
   - **Slack**: Search `in:inbox` or recent DMs via Slack MCP. Check who sent last message in each thread.
   - **Telegram**: Use user-auth MCP (NOT bot API) to read recent conversations.

3. **Display the full inbox:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► INBOX MANAGER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 📱 WhatsApp    [N need reply] | [N waiting] | [N archive]
 📧 Email       [N need reply] | [N waiting] | [N FYI]
 💬 Slack       [N need reply] | [N waiting]
 ✈️  Telegram   [N need reply] | [N waiting]

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

### WhatsApp (FULL SCAN)

1. Get all non-archived chats: `wacli chats list --json`
2. For each chat with `LastMessageTS` in the last 7 days, fetch recent messages:
   `wacli messages list --chat "<JID>" --limit 5 --json`
3. Parse the response structure: `data.messages[]` with fields `FromMe`, `Text`, `Timestamp`, `ChatName`
4. Classify each chat:
   - **NEEDS REPLY**: Last message has `FromMe: false` (they sent last)
   - **WAITING**: Last message has `FromMe: true` (you sent last)
   - **ARCHIVE**: Old conversation, no recent activity, or concluded

Display NEEDS REPLY chats first:
```
📱 WHATSAPP — NEEDS REPLY
 1. [Contact] — [last msg preview] — [time ago]
 2. [Contact] — [last msg preview] — [time ago]

📱 WHATSAPP — WAITING (no action needed)
 3. [Contact] — you said: "[preview]" — [time ago]

  For each NEEDS REPLY:
  a) Read full thread + reply
  b) Archive (no reply needed)
  c) Skip
```

Reply via: `wacli send --to "<JID>" --message "<msg>"`
Archive/mark handled: note in response, move to WAITING/HANDLED.

### Email (FULL SCAN)

1. Search `in:inbox` (NOT `is:unread`) via `mcp__claude_ai_Gmail__gmail_search_messages` or `gog gmail search -a sam.renders@gmail.com -j --results-only --no-input --max 30 "in:inbox"`
2. For each thread, read the last message to check sender
3. Classify:
   - **NEEDS REPLY**: Last sender is NOT you → action needed
   - **WAITING**: Last sender IS you → waiting for response
   - **FYI**: Newsletters, automated notifications, receipts → bulk archive

Display NEEDS REPLY threads first:
```
📧 EMAIL — NEEDS REPLY
 1. [Sender] — [Subject] — [time ago]
    Preview: [first 100 chars]
 2. ...

📧 EMAIL — FYI / ARCHIVE
 N. [Sender] — [Subject] (newsletter/notification)

  For each NEEDS REPLY:
  a) Read full thread + draft reply
  b) Archive (no reply needed)
  c) Skip

  For FYI section:
  x) Archive all FYI at once
```

Draft replies via `mcp__claude_ai_Gmail__gmail_create_draft` or `gog gmail compose`.

### Slack
Use `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "is:unread"` for mentions.
For each result, show channel, sender, preview. Use `mcp__claude_ai_Slack__slack_read_thread` for context.
Options:
```
  a) Read thread
  b) Reply
  c) Mark read / skip
```

### Telegram (FULL SCAN — User Account, NOT Bot)

Telegram integration must authenticate as Sam's personal account (user-auth via tdlib/MTProto), NOT a BotFather bot. The goal is to manage real conversations just like WhatsApp via wacli.

Use the Telegram user-auth MCP server if available. Fall back to `telegram-cli` or `tg` CLI tools that authenticate as user.

1. List recent dialogs/conversations (last 7 days)
2. For each, check who sent the last message
3. Classify: NEEDS REPLY / WAITING / HANDLED

```
✈️  TELEGRAM — NEEDS REPLY
 1. [Contact] — [preview] — [time ago]

  a) Read thread + reply
  b) Archive
  c) Skip
```

If no Telegram user-auth tool is available, report: "Telegram not configured — needs user-auth MCP server (tdlib/MTProto)".

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
