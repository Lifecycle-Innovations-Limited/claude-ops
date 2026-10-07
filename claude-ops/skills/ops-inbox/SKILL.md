---
name: ops-inbox
description: "OPS on-demand: This skill should be used when the user asks to \"check inbox\", \"inbox zero\"…"
argument-hint: '[channel: whatsapp|imessage|email|slack|telegram|discord|notion|all]'
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
  - CronList
  - mcp__gog__gmail_search
  - mcp__gog__gmail_read_thread
  - mcp__gog__gmail_labels
  # Slack — multi-workspace inbox scan uses these MCP tools when a workspace's
  # token is bound to the Slack MCP in ~/.claude.json. Workspaces whose
  # token_env is NOT bound to the MCP are scanned via direct curl from Bash
  # (no MCP entry needed for those).
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ai_Slack__slack_read_channel
  - mcp__claude_ai_Slack__slack_list_channels
  - mcp__claude_ai_Slack__channels_list
  # Telegram: user-auth MCP tools added when configured
  # Notion: MCP tools (claude.ai integration or self-hosted)
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-fetch
  - mcp__claude_ai_Notion__notion-query-data-sources
  - mcp__claude_ai_Notion__notion-get-comments
  - mcp__claude_ai_Notion__notion-create-comment
  - mcp__claude_ai_Notion__notion-update-page
  - mcp__claude_ai_Notion__notion-create-pages
  # WhatsApp — these are the SINGLE-ACCOUNT server names (see CLAUDE.md Rule 8).
  # allowed-tools entries are exact strings, so if you run one bridge per account
  # (`whatsapp-personal`, `whatsapp-work`, ...) these will NOT grant access to yours.
  # Add your own per-account entries alongside these, e.g. mcp__whatsapp-work__list_chats.
  - mcp__whatsapp__list_chats
  - mcp__whatsapp__list_messages
  - mcp__whatsapp__search_contacts
  - mcp__whatsapp__get_chat
  - mcp__whatsapp__get_message_context
  - mcp__whatsapp__archive_chat
  - mcp__whatsapp__resync_app_state
  # iMessage — official `imessage` plugin. chat_messages reads ~/Library/Messages/chat.db
  # (allowlist-scoped). Outbound uses the supported approved gate, not a direct reply.
  - mcp__plugin_imessage_imessage__chat_messages
effort: high
maxTurns: 60
---

# OPS ► INBOX

Load `ops-rules` before acting. Public repo: no personal data. Run in the parent
session: readers return evidence; the parent owns draft presentation and sends.

## AUTO-START DRAFTING: validate per reply

Always report to the main agent by default. Never set `context: fork` for this
skill: the parent owns the visible queue. Do not wait for "continue drafting".
The invocation starts the selected channels (default: all configured channels).
No continuation menu, channel picker, or second "start drafting" prompt.

1. Check existing ownership and reusable evidence before launching readers.
   Enumerate accounts/workspaces once; record each source's actual read status.
2. Use an existing fresh report or the authorized read-only scan path. The bundled
   scanner is a candidate pre-filter, not proof that a request is unanswered.
   Do not run a second overlapping whole-inbox sweep. See `references/runtime.md`.
3. Run independent read-only source/thread readers in parallel, within the
   executing machine's concurrency limit. Keep the quickest useful candidate
   in the parent; do not leave the parent waiting for an aggregate report.
4. Validate full person/topic context **per candidate**, including sent history
   on every configured account. See `references/details.md`. A KEEP row alone
   is not a ready draft. Missing load-bearing context stays unknown.
5. Surface the **first validated draft immediately**. Do not wait for unrelated
   sources or the rest of the inbox. Recheck its live thread before showing it.
   Every later ready candidate joins the parent's queue as evidence arrives.
6. One draft → one explicit approval → one send. Use the installed approved
   outbound gate; for email, WhatsApp and Slack this is only samimizer `message`.
   Populate its real session/thread/recipient metadata on the first call.
   Go is not approval. No self-created approval proof or alternate send route.
7. After sent=false, show the gate-returned full draft and end that presentation
   turn. Only the next native user event can advance its decision and the next
   draft. A transport hold may retain separately approved records for later
   gate-only drain; never show another draft in the same wait turn. Different
   threads/intents stay separate; unsupported queue states are not ready.
8. In the interactive authorized phase, complete answered/resolved items by
   verifying then archiving Gmail and every owned WhatsApp JID on its account.
   No extra menu for the expressly authorized completed set; protect open tasks,
   labels and unknown media. Mark-read is separate. Cron scans remain read-only.

Readers never send, archive, mark-read, modify integrations, or ask the owner
questions. They send evidence packets to the parent as soon as ready; an idle
worker without a report is not completion. See `references/fan-out.md`.

## Coverage is not unread state

- **Email:** every mailbox, including sent history, All Mail and discovered
  action/follow-up labels. Inbox, read/unread, archived, categories and drafts
  are not evidence that an ask was handled.
- **WhatsApp:** every connected WhatsApp account, labelled separately. Connected
  but agent-disabled accounts stay explicit not-checked gaps; do not enable or
  access them. Derive coverage from complete discovery, not a fixed count. Prove
  phone/JID/LID identity before merging aliases; reconcile incoming **and**
  outgoing across authorized accounts. A generic MCP name does not prove coverage.
- **Slack:** every Slack workspace, scoped human DMs/group DMs (`im,mpim`),
  allowed `public_channel` and `private_channel` history, mentions and replies.
  Read-state is not the filter; inspect thread replies, not just channel tails.
- **Other configured sources:** allowlisted iMessage/SMS, user-auth Telegram,
  scoped Discord, Notion comments/tasks, contact memory and open commitments.
- **Dates/availability:** every configured calendar plus the show/travel source
  of truth for the candidate's relevant dates. Never infer timezone from a number.

Paginate and disclose the lookback and retention limits. Record not checked,
partial, failed, or not configured explicitly; unknown is never a clean zero.
Older known open asks stay in the queue even outside the scan window.

## What the owner sees

One compact context block: who, the two-sentence thread arc, the actual latest
ask, why this answer helps, and any source gap. Then the gate shows the exact
recipient/account/thread, reply-all recipients, subject, full body and attachments.
The gate's latest delivered full-draft proof binds approval to those bytes.

After a native, proven yes to that shown draft, send when the gate permits without
a second approval menu. A typed yes followed by a refused/cancelled physical gate
is not approval. On failure keep the intent and exact diagnostic owned. Continue
independent read-only research, but advance another presentation only after the
next native user event. Never claim "sent" from a preview or pending-proof record.

## Finish honestly

Recheck source changes since each reader's cutoff before claiming complete.
Account for queued, shown, approved, sent, skipped, unresolved and unknown items.
Inbox zero is always the goal: all configured sources have completed dispositions,
no unhandled obligations, and authorized resolved items are verified archived.
Unknown coverage, pending proof or archive failure means NOT zero, regardless of
unread count. A real approval wait is not completion; preserve the queue for the
next user event. Status heartbeats follow
the host's cadence, contain actual results, and stop at a final result or real wait.

## References (load only the relevant one)

- `references/details.md` — per-candidate context, preflight, approval and verification
- `references/runtime.md` — ownership, account discovery, freshness and source gaps
- `references/fan-out.md` — progressive read-only workers and evidence packet
- `references/cli.md` — supported read paths and authorized archive verification
- `vip`, `relations` — priority, verified contact identity and open commitments
