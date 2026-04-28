---
name: ops-inbox
description: Full inbox management across all channels — WhatsApp (Baileys bridge via mcp__whatsapp__*), Email (Gmail MCP), Slack (MCP), Telegram (user-auth MCP), Discord (webhook + REST read), Notion (MCP — comments, mentions, assigned tasks). Scans FULL inbox (not just unread), identifies messages needing replies, archives handled conversations.
argument-hint: "[channel: whatsapp|email|slack|telegram|discord|notion|all]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - TeamCreate
  - SendMessage
  - TaskCreate
  - TaskUpdate
  - TaskList
  - CronCreate
  - CronList
  - mcp__gog__gmail_search
  - mcp__gog__gmail_read_thread
  - mcp__gog__gmail_send
  - mcp__gog__gmail_labels
  # Slack: MCP tools added when configured
  # Telegram: user-auth MCP tools added when configured
  # Notion: MCP tools (claude.ai integration or self-hosted)
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-fetch
  - mcp__claude_ai_Notion__notion-get-comments
  - mcp__claude_ai_Notion__notion-create-comment
  - mcp__claude_ai_Notion__notion-update-page
  - mcp__claude_ai_Notion__notion-create-pages
  - mcp__whatsapp__list_chats
  - mcp__whatsapp__list_messages
  - mcp__whatsapp__search_contacts
  - mcp__whatsapp__send_message
  - mcp__whatsapp__get_chat
  - mcp__whatsapp__get_message_context
effort: high
maxTurns: 60
---

# OPS ► INBOX ZERO

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `default_channels` — which channels to scan by default
   - `secrets_manager` / `doppler` — how to resolve channel credentials if not in env

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - Check `whatsapp-bridge` status — verify `com.claude-ops.whatsapp-bridge` is running (`lsof -i :8080` or `launchctl list com.claude-ops.whatsapp-bridge`)
   - If bridge is not running, surface the issue before WhatsApp operations

3. **Ops memories**: Check `${CLAUDE_PLUGIN_DATA_DIR}/memories/` before drafting any reply:
   - `contact_*.md` — load profile for the contact you're about to reply to
   - `preferences.md` — apply user's communication style and language preferences
   - `topics_active.md` — check for active threads or deadlines related to this contact
   - `donts.md` — never violate these restrictions in drafts

## CLI/API Reference

### whatsapp-bridge (WhatsApp — mcp__whatsapp__*)

**Bridge health** — check bridge is running before any WhatsApp operation:
```bash
lsof -i :8080 | grep LISTEN   # bridge listens on :8080
launchctl list com.claude-ops.whatsapp-bridge  # check launchd status
```
If bridge is not running: `launchctl kickstart -k gui/$UID/com.claude-ops.whatsapp-bridge`

**MCP tools** (use these instead of any wacli CLI command):

| Tool | Usage | Output |
|------|-------|--------|
| `mcp__whatsapp__list_chats` | `{sort_by: "last_active"}` | Array of chats with jid, name, last_message_time |
| `mcp__whatsapp__list_messages` | `{chat_jid, limit, query}` | Array of messages with id, sender, content, timestamp, is_from_me |
| `mcp__whatsapp__search_contacts` | `{query}` | Contacts matching name or phone |
| `mcp__whatsapp__send_message` | `{recipient, message}` | Send result |
| `mcp__whatsapp__get_chat` | `{chat_jid}` | Chat metadata |
| `mcp__whatsapp__get_message_context` | `{chat_jid, message_id}` | Message context window |

**Full-text search** — use `mcp__whatsapp__list_messages` with a `query` param (backed by FTS5 after running `scripts/whatsapp-bridge-migrate.sh`):
```bash
# Direct sqlite3 FTS query (fallback when MCP unavailable):
DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
sqlite3 "$DB" "SELECT chat_jid, sender, content, timestamp FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '<query>') ORDER BY timestamp DESC LIMIT 20;"
```

**Contact lookup** — use `mcp__whatsapp__search_contacts` or query contacts table directly:
```bash
sqlite3 "$DB" "SELECT jid, name, phone FROM contacts WHERE name LIKE '%<name>%' COLLATE NOCASE LIMIT 10;"
```

**History backfill** — the Baileys bridge automatically syncs history on connection. No manual backfill command exists; if messages are missing, restart the bridge:
```bash
launchctl kickstart -k gui/$UID/com.claude-ops.whatsapp-bridge
```

### gog CLI (Gmail/Calendar)

| Command | Usage | Output |
|---------|-------|--------|
| `gog gmail search "in:inbox" --max 50 -j --results-only --no-input` | Full inbox scan | JSON array of threads |
| `gog gmail thread get <threadId> -j` | Get full thread with all messages | Full message JSON |
| `gog gmail get <messageId> -j` | Get single message | Message JSON |
| `gog gmail archive <messageId> ... --no-input --force` | Archive messages (remove from inbox) | Archive result |
| `gog gmail archive --query "<gmail-query>" --max N --force` | Archive by query | Archive result |
| `gog gmail send --to "<email>" --subject "<subj>" --body "<body>"` | Send email | Send result |
| `gog gmail send --reply-to-message-id <msgId> --reply-all --body "text"` | Reply all | Send result |
| `gog gmail mark-read <messageId> ... --no-input` | Mark as read | Result |
| `gog gmail labels list -j` | List all labels | Labels JSON |

---


## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when processing "all channels" mode. This enables:
- Channel agents run in parallel but can share context (e.g., WhatsApp agent finds a message referencing an email thread → email agent can prioritize it)
- You can steer agents: "skip WhatsApp for now, focus on email first"
- Agents report completion per-channel so you can process replies as they come in

**Team setup** (only when flag is enabled, "all channels" mode):
```
TeamCreate("inbox-channels")
Agent(team_name="inbox-channels", name="whatsapp-scanner", ...)
Agent(team_name="inbox-channels", name="email-scanner", ...)
Agent(team_name="inbox-channels", name="slack-scanner", ...)
Agent(team_name="inbox-channels", name="telegram-scanner", ...)
Agent(team_name="inbox-channels", name="notion-scanner", ...)
```

Each agent scans its channel and reports back classified results. You then process NEEDS_REPLY items across all channels in priority order.

If the flag is NOT set, process channels sequentially or use fire-and-forget subagents.

## Pre-gathered data

```!
${CLAUDE_PLUGIN_ROOT}/../../bin/ops-unread 2>/dev/null || echo '{}'
```

## Environment variables

All channel credentials come from env vars or CLI auth — no hardcoded secrets.

| Variable            | Default     | Purpose                                              |
| ------------------- | ----------- | ---------------------------------------------------- |
| `GMAIL_ACCOUNT`     | auto-detect | Gmail account for `gog` CLI                          |
| `SLACK_MCP_ENABLED` | `false`     | Set `true` when Slack MCP server is configured       |
| `TELEGRAM_ENABLED`  | `false`     | Set `true` when Telegram user-auth MCP is configured |
| `NOTION_MCP_ENABLED`| `false`     | Set `true` when Notion MCP integration is configured |
| `WHATSAPP_BRIDGE_DB`| `~/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db` | Bridge messages DB path |

## Core principle: FULL INBOX SCAN

Do NOT just check unread. Scan the FULL recent inbox for each channel and classify every conversation:

## Core principle: FULL CONTEXT — NEVER ASSUME

**CRITICAL SAFETY RULE — NEVER SEND WITHOUT UNDERSTANDING:**
Before drafting or sending ANY reply on ANY channel, you MUST have read the FULL conversation history (20+ messages) and PROVEN you understand it by summarizing:
1. What the conversation is about
2. What each party said (distinguish user messages from contact messages)
3. What the contact is actually asking/saying in their last message
4. What a sensible reply would address

**Failure mode this prevents:** An agent reads only the last message "je kan het toch uit Klaviyo halen?" and replies "Welke data heb je nodig?" — completely wrong because the contact was telling the user to pull data themselves (they have 2FA), not asking for data. Without the full thread, the reply was nonsensical and confused the contact.

**Hard rule: if you cannot summarize the conversation arc in 2 sentences, you have not read enough messages. Go back and read more.**

The user does NOT remember every thread. For EVERY message you present, you MUST build full context BEFORE showing it. Never show just a subject line and ask "what do you want to do?" — the user needs to understand what it's about first.

**For every NEEDS REPLY item, gather this context automatically:**

1. **Full thread body** — read the ENTIRE thread (`gog gmail thread get` / `mcp__whatsapp__list_messages {limit: 20}`), not just the last message. Summarize the full conversation arc.
2. **Contact profile** — search across channels to build a card:
   - `gog gmail search "from:<contact_email>" --max 10` — recent email history
   - `mcp__whatsapp__search_contacts {query: "<name>"}` — WhatsApp presence
   - `mcp__whatsapp__list_messages {query: "<name>", limit: 5}` — recent WhatsApp mentions
   - If Linear configured: search for issues assigned to or mentioning this contact
   - Present: who they are, role/company, last N interactions, relationship context
3. **Topic context** — identify the subject matter and search for related threads:
   - `gog gmail search "subject:<keywords>" --max 5` — related email threads
   - `mcp__whatsapp__list_messages {query: "<topic keywords>", limit: 5}` — related WA messages
   - Summarize: what this topic is about, any deadlines, any pending decisions
4. **ops-memories** (if available) — check `~/.claude/plugins/data/ops-ops-marketplace/memories/` for any stored context about this contact or topic

**When presenting a NEEDS REPLY item:**
```
━━━ [Contact Name] — [Subject] ━━━
 Who: [role, company, relationship — from contact search]
 History: [last 3 interactions across channels]
 Thread: [2-3 sentence summary of full conversation arc]
 Last msg: [full body of their last message]
 Context: [related threads/decisions/deadlines found]
 
 Draft reply: "[contextually aware draft based on all above]"
 
 [Send] [Edit] [Read full thread] [Skip]
```

**When drafting replies:**
- Use the full thread history to maintain conversation continuity
- Reference specific points from their message
- Match the contact's communication style (formal/casual, language)
- If ops-memories has preferences for this contact, apply them
- Never generate a generic reply — every draft must show you read the full thread

- **NEEDS REPLY** — other party sent last message, awaiting your response
- **WAITING** — you sent last message, waiting for them (no action needed)
- **HANDLED** — conversation concluded, can be archived
- **FYI** — newsletters, notifications, automated messages (bulk archive)

## Channel availability + fallback

For each channel, detect availability at runtime:

1. **Email**: Try `gog` CLI first. If `gog` unavailable, try `mcp__gog__gmail_*` MCP tools. If neither, report unavailable.
2. **WhatsApp**: Check bridge liveness: `lsof -i :8080 | grep LISTEN`. If not listening, prompt the user: "WhatsApp bridge is not running." Use `AskUserQuestion`: `[Restart bridge]`, `[Skip WhatsApp]`. On restart: `launchctl kickstart -k gui/$(id -u)/com.claude-ops.whatsapp-bridge`, wait 5s, re-check. If bridge is running but MCP tools fail, the bridge may need QR re-pairing — check `~/.local/share/whatsapp-mcp/whatsapp-bridge/logs/bridge.err.log` for auth errors.
3. **Slack**: Only via MCP tools (`mcp__claude_ai_Slack__*`). Check `SLACK_MCP_ENABLED` env var.
4. **Telegram**: Only via user-auth MCP (tdlib/MTProto). Check `TELEGRAM_ENABLED` env var. Never use BotFather bots.
5. **Discord**: Via `${CLAUDE_PLUGIN_ROOT}/bin/ops-discord read <CHANNEL_ID> --limit 20 --json`. Requires `DISCORD_BOT_TOKEN` (v1 is channel-scoped — no DM/gateway support yet). Pre-configured read list lives at `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` under `discord.inbox_channels` (array of channel IDs). If neither a bot token nor a read list is configured, skip Discord with a one-line note ("Discord not configured — run `/ops:setup discord`") rather than prompting — ops-inbox is not a setup flow. Rule 3 still applies to `/ops:setup`.
6. **Notion**: Only via MCP tools (`mcp__claude_ai_Notion__*` or self-hosted Notion MCP). Check `NOTION_MCP_ENABLED` env var. Searches workspace for recent comments, mentions, and assigned tasks.

## Your task

1. **Parse pre-gathered data** for initial counts (unread is just a starting signal).

2. **For each channel, run a FULL scan** (not just unread):
   - **Email**: Search `in:inbox` (not `is:unread`) via `gog gmail search -a $GMAIL_ACCOUNT -j --results-only --no-input --max 30 "in:inbox"`. For each thread, read the last message to determine who sent it last. Check for DRAFT or SENT labels. **Before suggesting to send a draft, verify no reply was already sent in the thread.**
   - **WhatsApp**: Call `mcp__whatsapp__list_chats {sort_by: "last_active"}` to get all chats. Filter to chats with `last_message_time` in the last 7 days. For each, fetch the FULL conversation via `mcp__whatsapp__list_messages {chat_jid, limit: 20}` (20 messages, not 5 — you need the full thread). Parse message array with fields `is_from_me`, `content`, `timestamp`, `sender`. Classify by last message `is_from_me` field.
   - **Slack**: Search via Slack MCP tools. Check who sent last message in each thread.
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
```

Use **batched AskUserQuestion calls** (max 4 options each). Only show channels that are configured and have messages. If <=4 total options, use a single call.

AskUserQuestion call 1:
```
  [All channels (fastest — one pass)]
  [WhatsApp only]
  [Email only]
  [More...]
```

AskUserQuestion call 2 (only if "More..."):
```
  [Slack only]
  [Telegram only]
  [Skip — already done]
```

If only 3 channels are configured, "All channels" + 3 channel options = 4, fits in one call. Then process the selected channel(s).

---

## Processing each channel

### WhatsApp (FULL SCAN + DEEP CONTEXT)

**Phase 1 — Classify:**
1. Get all chats: `mcp__whatsapp__list_chats` with `{sort_by: "last_active"}`
2. Filter to chats with `last_message_time` in the last 7 days
3. For each, fetch the FULL recent conversation: `mcp__whatsapp__list_messages` with `{chat_jid: "<JID>", limit: 20}` — get 20 messages, NOT 5.
4. Parse message array — fields: `is_from_me`, `content`, `timestamp`, `sender`
5. For EVERY chat, understand the conversation:
   - Read ALL messages in order. Know which have `is_from_me: true` (user sent) vs `is_from_me: false` (contact sent)
   - Understand what the conversation is about, what was discussed, what's pending
   - Identify the user's tone and style in their sent messages
6. Classify each chat:
   - **NEEDS REPLY**: Last message has `is_from_me: false` (they sent last)
   - **WAITING**: Last message has `is_from_me: true` (you sent last)
   - **ARCHIVE**: Old conversation, no recent activity, or concluded

**Phase 2 — Build context for NEEDS REPLY chats (run in parallel):**
For each NEEDS REPLY chat:
1. **Full conversation summary** — read all 20 messages, summarize the arc: what was discussed, key decisions, open questions
2. **Contact profile** — search for this person:
   - `mcp__whatsapp__list_messages` with `{query: "<contact_name>", limit: 10}` — mentions across chats
   - `gog gmail search -j --results-only --no-input --max 5 "from:<name> OR to:<name>"` — email history
   - Check `~/.claude/plugins/data/ops-ops-marketplace/memories/contact_*.md` for stored profile
   - Build: who they are, relationship, communication history across channels
3. **Topic context** — extract keywords from the conversation and search:
   - `mcp__whatsapp__list_messages` with `{query: "<topic keywords>", limit: 5}` — related WA messages
   - `gog gmail search -j --results-only --no-input --max 3 "<topic keywords>"` — related emails
4. **User's messaging style** — from the `is_from_me: true` messages in this chat, note: language (NL/EN), formality, emoji usage, typical response length

**Phase 3 — Present with full context:**

```
📱 WHATSAPP — NEEDS REPLY (with context)

━━━ 1. [Contact Name] ━━━
 Who: [role, company, relationship — from contact search]
 History: [last 3 interactions across channels]
 Conversation: [2-3 sentence summary of the full chat thread]
 Their message: [full text of their last message(s)]
 Your last msg: [what you said before they replied]
 Context: [related threads/topics found]
 Language: [NL/EN — match the user's previous messages in this chat]

 Draft reply: "[context-aware draft matching user's style + language]"

 [Send] [Edit] [Read full thread] [More...]

If "More...":
 [Archive] [Skip]

📱 WHATSAPP — WAITING (no action needed)
 N. [Contact] — you said: "[your last message]" — [time ago]
    Thread: [1-line summary of what you're waiting for]
```

Use `AskUserQuestion` for each NEEDS REPLY chat.

**When drafting WhatsApp replies:**
- Match the user's language (if they wrote Dutch to this contact, draft in Dutch)
- Match the user's style (casual/formal, emoji usage, message length)
- Reference specific points from the contact's message
- If ops-memories has preferences for this contact, apply them
- Never generate a generic reply — every draft must show you understood the full conversation

Reply via: `mcp__whatsapp__send_message` with `{recipient: "<JID>", message: "<msg>"}`

**WhatsApp bridge reference:**

| Operation | Tool / Command |
|-----------|---------------|
| List chats | `mcp__whatsapp__list_chats {sort_by: "last_active"}` |
| Read messages | `mcp__whatsapp__list_messages {chat_jid, limit: 20}` |
| Search messages (FTS) | `mcp__whatsapp__list_messages {query: "<text>", limit: 20}` |
| Find contact | `mcp__whatsapp__search_contacts {query: "<name>"}` |
| Send message | `mcp__whatsapp__send_message {recipient, message}` |
| Chat metadata | `mcp__whatsapp__get_chat {chat_jid}` |
| Message context | `mcp__whatsapp__get_message_context {chat_jid, message_id}` |
| Check bridge | `lsof -i :8080 | grep LISTEN` |
| Restart bridge | `launchctl kickstart -k gui/$(id -u)/com.claude-ops.whatsapp-bridge` |

**Bridge troubleshooting:**

- Bridge not running → `launchctl kickstart -k gui/$(id -u)/com.claude-ops.whatsapp-bridge`; wait 5s, re-check
- Auth expired / QR needed → check `~/.local/share/whatsapp-mcp/whatsapp-bridge/logs/bridge.err.log`; bridge prints QR to log on startup if session is invalid
- Missing messages → bridge syncs history on connect; if gap persists, restart bridge
- FTS not available → run `scripts/whatsapp-bridge-migrate.sh` to add FTS5 index to messages.db

### Email (FULL SCAN + DEEP CONTEXT)

**Phase 1 — Classify:**
1. Search `in:inbox` (NOT `is:unread`) via `gog gmail search -a $GMAIL_ACCOUNT -j --results-only --no-input --max 30 "in:inbox"`
2. For each thread, read the FULL thread via `gog gmail thread get -a $GMAIL_ACCOUNT <threadId> -j` — read ALL messages, not just the last one
3. Check the last message's `From` header and `labelIds` (SENT, DRAFT)
4. Classify:
   - **NEEDS REPLY**: Last sender is NOT you AND no unsent draft exists → action needed
   - **WAITING**: Last sender IS you (SENT label) → waiting for response
   - **DRAFT**: Unsent draft exists → verify no reply already sent, then offer to send
   - **FYI**: Newsletters, automated notifications, receipts → bulk archive

**Phase 2 — Build context for NEEDS REPLY items (run in parallel):**
For each NEEDS REPLY thread, gather:
1. **Full thread summary** — read every message in the thread, summarize the conversation arc (who said what, key decisions, open questions)
2. **Contact profile** — for the sender:
   - `gog gmail search -j --results-only --no-input --max 10 "from:<sender_email>"` — their recent emails to you
   - `mcp__whatsapp__search_contacts {query: "<sender_name>"}` — WhatsApp contact
   - `mcp__whatsapp__list_messages {query: "<sender_name>", limit: 5}` — recent WhatsApp mentions
   - Build: name, role/company, relationship history, last N interactions
3. **Topic search** — extract key terms from subject + body, then:
   - `gog gmail search -j --results-only --no-input --max 5 "subject:<keywords>"` — related threads
   - Identify: pending decisions, deadlines, action items from related threads

**Phase 3 — Present with full context:**

```
📧 EMAIL — NEEDS REPLY (with context)

━━━ 1. [Sender] — [Subject] ━━━
 Who: [sender's role, company — from contact search]
 History: [last 3 email exchanges with this person]
 Thread summary: [2-3 sentences covering the full conversation arc]
 Their message: [full body of their last message — NOT truncated]
 Related: [any related threads or pending decisions found]

 Draft reply: "[context-aware draft using full thread + contact history]"

 [Send draft] [Edit draft] [Read full thread] [More...]

If "More...":
 [Archive] [Skip]

📧 EMAIL — DRAFTS (unsent)
 N. [Recipient] — [Subject] (draft ready to send)

📧 EMAIL — FYI / ARCHIVE
 N. [Sender] — [Subject] (newsletter/notification)

  For each NEEDS REPLY:
  a) Read full thread + draft reply
  b) Archive (no reply needed)
  c) Skip

  For FYI section:
  x) Archive all FYI at once
```

Use `AskUserQuestion` for each NEEDS REPLY email with options `[Read + Reply]` / `[Archive]` / `[Skip]`.

When replying, draft the reply and use `AskUserQuestion` to confirm:
```
Reply to [Sender] — [Subject]:
  "[drafted reply]"

  [Send]  [Edit]  [Skip]
```

For FYI bulk archive, use `AskUserQuestion`:
```
Archive N FYI/newsletter emails?
  [list of subjects]

  [Archive all N]  [Review each]  [Skip]
```

Draft replies via `gog gmail send`. Archive via `gog gmail archive <messageId> ... --no-input --force`.

### Slack

Use Slack MCP tools with `query: "in:*"` (NOT `is:unread` — scan full recent activity, not just unread) for mentions.
For each result, show channel, sender, preview. Read thread for context.

```
  a) Read thread
  b) Reply
  c) Mark read / skip
```

### Telegram (FULL SCAN — User Account, NOT Bot)

Telegram integration must authenticate as the user's personal account (user-auth via tdlib/MTProto), NOT a BotFather bot. The goal is to manage real conversations just like WhatsApp via the bridge MCP tools.

Use the Telegram user-auth MCP server if available.

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

### Notion (MCP — comments, mentions, assigned tasks)

Notion serves as a knowledge base and task management channel. Unlike messaging channels, Notion "inbox" items are:
- **Comments on pages you own or are mentioned in**
- **Tasks assigned to you** in tracked databases
- **Recently updated pages** in databases you monitor

**Phase 1 — Discover and scan:**

1. Search for recent activity using `mcp__claude_ai_Notion__notion-search`:
   - Use broad queries like `query: ""` (empty string returns recent pages) or topic-specific terms
   - Use `filter: {"property": "object", "value": "page"}` to limit to pages (not databases)
   - Sort by `last_edited_time` descending to surface recent activity
   - Note: Notion search is full-text over titles/content — it does NOT support mention-based queries or date range filters
2. For each result, fetch full content: `mcp__claude_ai_Notion__notion-fetch` with the page URL/ID
3. Get comments on active pages: `mcp__claude_ai_Notion__notion-get-comments` with the page ID — scan comment authors and timestamps to determine which need replies

**Phase 2 — Classify:**

For each page with comments or mentions:
- **NEEDS REPLY**: Someone commented/mentioned you and you haven't responded
- **WAITING**: You commented last, waiting for others
- **FYI**: Page updated but no direct mention or action needed
- **TASK**: Item assigned to you in a database (check status property)

**Phase 3 — Present with context:**

```
📓 NOTION — NEEDS REPLY

━━━ 1. [Page Title] — [Database Name] ━━━
 Page: [page URL]
 Comment by: [commenter name] — [time ago]
 Comment: "[full comment text]"
 Page context: [2-3 sentence summary of the page content]

 Draft reply: "[context-aware reply to the comment]"

 [Reply] [View page] [Skip] [More...]

If "More...":
 [Mark resolved] [Archive]

📓 NOTION — ASSIGNED TASKS

 N. [Task title] — [database] — Status: [status] — Due: [date]
    Context: [1-line summary]

📓 NOTION — RECENTLY UPDATED (FYI)

 N. [Page title] — updated by [person] — [time ago]
```

Use `AskUserQuestion` for each NEEDS REPLY item.

**When replying to Notion comments:**
- Use `mcp__claude_ai_Notion__notion-create-comment` with the page ID and reply text
- Match the formality of the original comment
- Reference specific page content when relevant

**When updating tasks:**
- Use `mcp__claude_ai_Notion__notion-update-page` to change status, add notes
- Only update properties the user explicitly approves

**API fallback (when MCP is down):**
If Notion MCP tools fail or are unavailable but `NOTION_API_KEY` is set, fall back to direct API:
```bash
curl -s -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X POST https://api.notion.com/v1/search \
  -d '{"sort":{"direction":"descending","timestamp":"last_edited_time"},"page_size":10}'
```

If `NOTION_MCP_ENABLED` is not set or Notion MCP tools are unavailable, report: "Notion not configured — set NOTION_MCP_ENABLED=true and add Notion integration via claude.ai or self-hosted MCP".

### Discord (v1 — REST channel scan)

Discord v1 support is channel-scoped (webhook send + REST read). DM + gateway are deferred to a v2 issue.

1. Resolve the read list: read `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` → `discord.inbox_channels[]`. If empty and `DISCORD_GUILD_ID` is set, fall back to `bin/ops-discord channels --json` (list the guild's text channels and let the user pick via `AskUserQuestion`, ≤4 per Rule 1 — paginate with `[More...]`).
2. For each channel ID:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/bin/ops-discord read "<CHANNEL_ID>" --limit 20 --json
   ```
3. Classify each channel's recent messages:
   - **NEEDS REPLY**: Latest non-bot message mentions the operator (`<@user-id>`) or is a direct question.
   - **FYI**: Bot-posted notifications (CI, alerts) — summarize counts and skip.
4. For replies, reuse the `send` path documented in `skills/ops-comms/SKILL.md` → **Discord send**.

If `bin/ops-discord` exits 1 with `{"error":"no discord credential configured — run /ops:setup discord"}`, print a single-line note and continue to the next channel — do not prompt inside the inbox flow.

```
💬 DISCORD — activity (last 7d)
 #channel-name  [N messages] | [M need reply]
```

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

---

## Native tool usage

### Tasks — inbox progress

Use `TaskCreate` for each channel being processed. Update with `TaskUpdate` as messages are replied/archived/skipped. Gives the user a live inbox-zero progress bar.

### Cron — scheduled inbox checks

After processing, offer to schedule recurring inbox checks via `AskUserQuestion`:
```
  [Schedule inbox check every 2 hours]  [Schedule morning + evening]  [No schedule]
```
Use `CronCreate` if selected. Show existing schedules with `CronList`.
