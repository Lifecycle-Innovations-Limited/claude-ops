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
---

# OPS ► INBOX ZERO

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
| `WACLI_STORE`       | `~/.wacli`  | wacli store directory                                |

## Core principle: FULL INBOX SCAN

Do NOT just check unread. Scan the FULL recent inbox for each channel and classify every conversation:

- **NEEDS REPLY** — other party sent last message, awaiting your response
- **WAITING** — you sent last message, waiting for them (no action needed)
- **HANDLED** — conversation concluded, can be archived
- **FYI** — newsletters, notifications, automated messages (bulk archive)

## Channel availability + fallback

For each channel, detect availability at runtime:

1. **Email**: Try `gog` CLI first. If `gog` unavailable, try `mcp__gog__gmail_*` MCP tools. If neither, report unavailable.
2. **WhatsApp**: Try `wacli` CLI. Check `wacli doctor` for auth/connection status. If outdated (405 error), advise `brew reinstall --HEAD steipete/tap/wacli` or build from source.
3. **Slack**: Only via MCP tools (`mcp__claude_ai_Slack__*`). Check `SLACK_MCP_ENABLED` env var.
4. **Telegram**: Only via user-auth MCP (tdlib/MTProto). Check `TELEGRAM_ENABLED` env var. Never use BotFather bots.

## Your task

1. **Parse pre-gathered data** for initial counts (unread is just a starting signal).

2. **For each channel, run a FULL scan** (not just unread):
   - **Email**: Search `in:inbox` (not `is:unread`) via `gog gmail search -a $GMAIL_ACCOUNT -j --results-only --no-input --max 30 "in:inbox"`. For each thread, read the last message to determine who sent it last. Check for DRAFT or SENT labels. **Before suggesting to send a draft, verify no reply was already sent in the thread.**
   - **WhatsApp**: Run `wacli chats list --json` to get all chats. Filter to non-archived chats with `LastMessageTS` in the last 7 days. For each, fetch last 3-5 messages via `wacli messages list --chat <JID> --limit 5 --json`. Parse `data.messages[]` with fields `FromMe`, `Text`, `Timestamp`, `ChatName`. Classify by last message `FromMe` field.
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

1. Get all chats: `wacli chats list --json`
2. Filter to chats with `LastMessageTS` in the last 7 days
3. For each, fetch recent messages: `wacli messages list --chat "<JID>" --limit 5 --json`
4. Parse `data.messages[]` — fields: `FromMe`, `Text`, `Timestamp`, `ChatName`, `SenderName`
5. Classify each chat:
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

Use `AskUserQuestion` for each NEEDS REPLY chat with options `[Read + Reply]` / `[Archive]` / `[Skip]`.

When replying, draft the message and use `AskUserQuestion` to confirm before sending:
```
Reply to [Contact] via WhatsApp:
  "[drafted reply]"

  [Send]  [Edit]  [Skip]
```

Reply via: `wacli send --to "<JID>" --message "<msg>"`

**wacli troubleshooting:**

- `@lid` JIDs (linked device format) may return empty messages — run `wacli sync` to backfill
- "Client outdated (405)" → rebuild from source: `cd /tmp && git clone https://github.com/steipete/wacli.git && cd wacli && go build -o wacli ./cmd/wacli/ && cp wacli /usr/local/bin/`
- "store is locked" → kill stale process: `kill $(pgrep wacli)`
- After version upgrade, re-authenticate: `wacli auth logout && wacli auth`

### Email (FULL SCAN)

1. Search `in:inbox` (NOT `is:unread`) via `gog gmail search -a $GMAIL_ACCOUNT -j --results-only --no-input --max 30 "in:inbox"`
2. For each thread, read via `gog gmail read -a $GMAIL_ACCOUNT -j --no-input "<thread_id>"`
3. Check the last message's `From` header and `labelIds` (SENT, DRAFT)
4. Classify:
   - **NEEDS REPLY**: Last sender is NOT you AND no unsent draft exists → action needed
   - **WAITING**: Last sender IS you (SENT label) → waiting for response
   - **DRAFT**: Unsent draft exists → verify no reply already sent, then offer to send
   - **FYI**: Newsletters, automated notifications, receipts → bulk archive

Display NEEDS REPLY threads first:

```
📧 EMAIL — NEEDS REPLY
 1. [Sender] — [Subject] — [time ago]
    Preview: [first 100 chars]

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

Draft replies via `gog gmail send`. Archive via `gog gmail labels modify --remove INBOX <thread_ids>`.

### Slack

Use Slack MCP tools with `query: "is:unread"` for mentions.
For each result, show channel, sender, preview. Read thread for context.

```
  a) Read thread
  b) Reply
  c) Mark read / skip
```

### Telegram (FULL SCAN — User Account, NOT Bot)

Telegram integration must authenticate as the user's personal account (user-auth via tdlib/MTProto), NOT a BotFather bot. The goal is to manage real conversations just like WhatsApp via wacli.

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
