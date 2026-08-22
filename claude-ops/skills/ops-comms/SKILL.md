---
name: ops-comms
description: "This skill should be used when the user asks to \"send a message\", \"whatsapp/email/slack\", or \"/ops:ops-comms\". Send and read messages across all channels. Routes based on arguments — whatsapp, email, slack, telegram, discord, notion, or natural language like \"send [msg] to [contact]\". WhatsApp via mcp__whatsapp__* (Baileys bridge)."
argument-hint: '[channel] | send [message] to [contact] | read [channel] | notion [search query]'
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
context: fork
---

# OPS ► COMMS

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

## Runtime Context

Before executing, load available context:

1. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-health.json`
   - Check bridge liveness before any WhatsApp operation: `lsof -i :8080 | grep LISTEN`
   - If bridge not running, prompt user to restart: `launchctl kickstart -k gui/$UID/com.${USER}.whatsapp-bridge`

2. **Ops memories**: Before drafting any message, check `${CLAUDE_PLUGIN_DATA_DIR}/memories/`:
   - `contact_*.md` — load profile for the recipient
   - `preferences.md` — match user's communication style, language, and tone
   - `donts.md` — restrictions that must not appear in any draft

3. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` for `default_channels` to determine which channel to prefer when multiple are available for a contact.

## Routing table

| Pattern       | Action                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp`    | Show WhatsApp recent chats — offer to read or send                                                                                                             |
| `email`       | Show recent email threads via Gmail MCP                                                                                                                        |
| `slack`       | Show recent Slack activity                                                                                                                                     |
| `telegram`    | Show Telegram recent chats                                                                                                                                     |
| `discord`     | Show recent Discord channel activity (via bin/ops-discord)                                                                                                     |
| `notion`      | Search Notion workspace — pages, comments, tasks                                                                                                               |
| `voice`       | Voice / phone / video — routes to `/ops:ops-voice` (bin/ops-voice)                                                                                             |
| `call * `     | Native Phone.app call via `bin/ops-voice phone`                                                                                                                |
| `facetime *`  | FaceTime audio/video via `bin/ops-voice facetime`                                                                                                              |
| `zoom`        | Start an instant Zoom meeting via `bin/ops-voice zoom start`                                                                                                   |
| `send * to *` | Parse message and contact, determine best channel, send                                                                                                        |
| `read *`      | Read the specified channel or contact's messages                                                                                                               |
| `home alarm`  | Pipe a Homey alarm event as a WhatsApp/Telegram alert — delegates to `/ops:ops-home alarm --notify` (only if `home_automation` is configured in `$PREFS_PATH`) |
| (empty)       | Show channel picker menu                                                                                                                                       |

Natural-language parsing:

- `send "deploy done" to #general on discord` → `bin/ops-discord send general "deploy done"`.
- `call <contact>` / `dial <contact>` / `phone <contact>` → resolve number, then `bin/ops-voice phone <E.164>`.
- `facetime <contact>` (with optional `audio`) → `bin/ops-voice facetime <handle> [--audio]`.
- `start a zoom` / `new zoom meeting` → `bin/ops-voice zoom start`.
- `join zoom <ID>` → `bin/ops-voice zoom join <ID>`.
- `text <contact> "<body>"` / `sms <contact> "<body>"` → `bin/ops-voice twilio-sms <to> $TWILIO_FROM_NUMBER "<body>"` (guarded by per-message approval).

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

**Pre-flight:** Check bridge is running: `lsof -i :8080 | grep LISTEN`. If not running, restart: `launchctl kickstart -k gui/$(id -u)/com.${USER}.whatsapp-bridge` and wait 5s.

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

## Outbound judgment: verify before you assert

Rule 6 governs *whether* a message may go out. This section governs *whether the
message is right*. Every item below is a failure mode seen on a real run, where
the approval gate held and the content was still wrong.

### Research every load-bearing claim

Never state a fact in someone else's inbox from memory. A price, a date, an
availability, a "who currently holds X" all get a cheap check first: a search, the
actual thread, the calendar, the invoice.

**Claims about the recipient's own access get probed, not inferred.** Telling a
colleague their access is broken is a claim about a system you can inspect. A
wrong diagnosis sends a competent person chasing a non-problem, and they will
believe you because you appear to hold the admin view. Sort each access item into
fixed, never broken, or theirs, and say which. Telling someone "that already
works" stops them building a workaround for a permission they already have.

### Verify the join, not just the endpoints

The hardest fabrications are not invented facts, they are invented *relationships*
between two real things that share a name, an entity, or a keyword. Each half is
true, the sentence joining them is not, and it reads as diligence rather than a
guess.

"X should be coordinated with Y" is itself a factual claim and needs its own
evidence. A company or person appearing in two matters is weak evidence they are
the same workstream and often strong evidence of a naming coincidence. Be
especially suspicious of an advisory clause nobody asked for: the recipient asked
a yes or no question, and a "let's just align with..." rider is exactly where
invented linkage hides. When challenged on such a clause, probe and delete it
rather than rewording it into something defensible.

### Do not absorb the other party's job

An inbound message that mentions a task is not automatically a task for the user.
When the sender owns the workstream, a heads-up about their own work in progress
is not an instruction transferring that work.

Before staging any reply containing a first-person commitment ("I'll pick that
up", "I'll clean that up"), check whose function it is, who has the access, and
whether the commitment is even wanted. A message that only needs acknowledging
gets acknowledgement. Volunteering labour reads as helpful and creates real
obligations nobody tracks. When the work does need doing and the counterparty
owns it, name it and hand it back rather than quietly taking it on.

### Do not route a decision the counterparty already made

A narrow A/B to the user is right for a real trade-off and wrong when the
counterparty already supplied the answer inside the message being triaged.
An identifier a person gives for their **own** account (login, email, phone,
handle, bank account) is authoritative. A conflict with the admin view means the
estate is misconfigured, not that they misremembered their own account. Use the
probing to shape the message, not to defer. Escalate only when the action is
irreversible and expensive; two systems disagreeing is neither.

The tell that this rule was broken is a closing question to the user whose answer
is already quoted verbatim in the inbound message.

### A staged draft goes stale

A queue of drafts is researched at one moment and sent over hours. Any draft
referencing a pending external process (a bank instruction, a signature, a
shipment, a filing) must have that process re-checked immediately before the
send, not just at research time. A draft that correctly said "still waiting, no
news" became wrong when the counterparty's reply landed mid-queue.

Two consequences are easy to miss: the draft's central claim can flip outright,
and new inbound often creates a *second* outbound that also needs drafting.
Search results encountered mid-queue get triaged, not skimmed past.

**A parallel session may have already sent it.** Multiple agents can work the
same inbox and send under the same identity. Treat any outbound from the user's
own identity that this session did not write as another agent's work: verify its
claims at the source, report the item closed with that evidence, and move on. Do
not re-send, and do not assume it was correct just because it exists.

### A counterparty's restatement of your position is not authoritative

When someone replies "which of these did you mean?" or summarises your position
back before proceeding, do not pick the more plausible reading. Open what the
user actually sent and read their own words. A partner who guesses wrong and
proceeds on that guess can commit the user, in writing, to a different deal than
the one they proposed. Their politeness is not evidence; a soft hedge from a
competent counterparty is exactly where an unnoticed inversion lives.

### When the user contradicts your draft, check before defending it

Low-confidence pushback ("check, I think we already signed", "I might have
credentials too") is a hard stop and a research instruction, not a hedge to be
reassured about. Re-probe the primary source and come back with what it says,
including "partly, the mechanism is X not Y". Never defend a draft against the
user's own recollection without checking first.

### Do not trust an audit's verdict over primary evidence

A subagent audit is a research artifact, not a finding. Before acting on a
cancel-or-delete verdict, open one paid invoice and read the SKU, quantity,
billing address, and payment history. "No API key in the environment" does not
mean "unused": no-code SaaS runs entirely in a web UI. A "paused" or free-tier
notice may belong to an entirely different account than the paid plan.

### Reply to their message, not your parallel checklist

When the user says "just reply", answer only the inbound ask. Do not bolt on
extra forms, address updates, or multi-item checklists they did not ask for in
that draft. Extra tracks get a separate message after the send if still needed.
When the user corrects a draft to be shorter or more spoken, rewrite against
*their* wording, not a re-packaged version of your own.

### A work handover must match the tracker exactly

When a message tells someone what to work on, do not paraphrase the tracker.
Re-run the query and enumerate every open item in board order with identifier,
priority, and state. Vagueness is how items get silently dropped and how the
recipient invents their own ordering. If something is deliberately excluded, say
so and why rather than omitting it silently.

### Sequencing irreversible actions: preserve, verify, then destroy

When an action destroys an asset (a contact list, a mailbox, a dataset), order
the work export, then verify the export is real, then destroy. "Verify" means row
count and headers inspected against an expectation stated up front, so the check
is falsifiable. An export returning a few hundred rows from a plan holding tens
of thousands is a failed export that looks like a successful one. Split it across
two approvals: the export can run autonomously, the destroy waits for the user.

### Verify the send actually landed

Do not treat a send tool returning without an error as delivery. Confirm on the
channel: the outbound row appears in the thread, or the message carries the
`SENT` label. A `DRAFT` is not a delivery, and a broken sender alias can bounce
seconds later. If verification fails, do not archive; an unverified send is an
unanswered thread.

### Post-reply disposition, in the same step as the send

Every thread you reply to gets a disposition immediately. There is no "leave it
and see".

- **Ball in their court** — archive once the send is verified.
- **User still owes something** — snooze with a dated reminder naming the owed
  action and the thread, then archive. An unfulfilled commitment must never stay
  visible as a substitute for tracking it.
- **Unactionable or already answered** — archive.

Only threads genuinely waiting on the user's own next action stay in the inbox.

### Auto-resume the next staged outbound

After one item is approved, sent, verified, and dispositioned, stage the next
queue item automatically without waiting for "go" or "next". Stop only for the
per-draft approval itself, a real decision that is the user's to make, or a
blocker only a human can clear.

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

Read the **derived** `channels.slack.workspaces[]` object from the pre-gathered `bin/ops-unread` output (NOT the raw `preferences.json` → `slack_workspaces[]`, which has no `available` field — it only persists workspace metadata). The `bin/ops-unread` step resolves each workspace's `token_env` and emits `available: true|false` per entry. Iterate that array:

- For each `available: true` entry, use `mcp__claude_ai_Slack__slack_search_public_and_private` with `query: "in:channel"` (NOT `is:unread`) if the MCP token matches, or direct curl for non-bound workspaces. To resolve the token for direct curl, the entry's `token_env` field is the **name** of the env var; validate it matches `^[A-Za-z_][A-Za-z0-9_]*$` before indirect expansion (`${!token_env}`) to avoid bash aborting on invalid identifiers.
- Label results with the workspace name: `Slack/<workspace_a>`, `Slack/<workspace_b>`, etc.
- **`channels.slack.multi_workspace == false` / legacy mode**: fall back to `mcp__claude_ai_Slack__slack_search_public_and_private` if `channels.slack.available == true`, otherwise report "Slack not configured".

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

### Voice / phone / video

All voice traffic flows through `bin/ops-voice` (full surface documented in the `ops-voice` skill). Native channels (Phone.app, FaceTime, Zoom start|join) need no credentials; programmatic channels (Twilio voice/SMS, Bland AI, Zoom schedule) follow the standard credential-resolution order.

```bash
# Native — no creds
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice phone    "+1234567890" --json
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice facetime user@example.com --audio --json
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice zoom     start
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice zoom     join 1234567890 --pwd <password>

# Programmatic — gated by Rule 6 (per-message approval)
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice twilio-call "+1234567890" "$TWILIO_FROM_NUMBER" --twiml "<URL>" --json
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice twilio-sms  "+1234567890" "$TWILIO_FROM_NUMBER" "<body>" --json
${CLAUDE_PLUGIN_ROOT}/bin/ops-voice bland-call  "+1234567890" "<task prompt>" --json
```

**Send-flow integration:** when `$ARGUMENTS` looks like `call <contact>`, `facetime <contact>`, `text <contact> "<body>"`, or `have an AI call <contact> and ...`:

1. Resolve the contact's number/handle (`mcp__whatsapp__search_contacts` or `preferences.json` → `contacts`).
2. For native calls (`phone`, `facetime`, `zoom`): preview `[Place call via <channel> to <contact>] [Cancel]` then invoke.
3. For Twilio voice/SMS and Bland AI: stage the full draft (recipient, channel, body or task-prompt) and gate behind one `AskUserQuestion` per message (Rule 6). Never batch.

**How the approval is actually enforced** — see `scripts/outbound-guard/README.md`. One
store, `/tmp/.claude-outbound-guard.json`, shared by every CLI. The owner arms it from
their own shell with `! ok` (1 message), `! ok 3`, or `! ok all` (10, capped). A message
is identified by recipient plus content, so the same message crossing the PreToolUse
hook and the MCP proxy costs one unit rather than two. A counter does not replace Rule 6:
you still stage each draft and wait for a yes.

Three traps that have each caused a real bypass:

- **Never let a helper script do the sending.** The Bash guard matches on the text of
  the command, so a send hidden inside a script is invisible to it. Print the command
  from a helper if you like, then run the real one inline.
- **A `SENT` label is not delivery.** A send-as alias with bad SMTP credentials is
  stamped `SENT` and bounced by `mailer-daemon` seconds later in the same thread. Check
  for the bounce before reporting a message as delivered.
- **Match tool names by pattern.** Multi-account installs expose
  `mcp__whatsapp-<label>__send_message`; an exact-string allowlist silently stops
  covering them while still appearing to run (Rule 8).
4. If no credential resolves for a programmatic channel, prompt via `AskUserQuestion` with `[Run /ops:ops-voice setup]` / `[Paste credential now]` / `[Try native instead]` / `[Skip]` (Rule 3 — never silently skip).

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
  [Make a call (voice)]
  [Send a message]
```

If all channels are configured, that's 6+ options — always batch. If only 3 channels are configured, "Read X" + "Read Y" + "Read Z" + "Send a message" = 4, fits in one call. The `voice` channel is configured iff `preferences.json` → `channels.voice` is present OR `default_channels` contains `"voice"`.

Execute the selected action.

---

## Ledger Integration

**CLAIM_KEY by channel and message unit:**

- Slack thread: `slack:thread:<channel>:<ts>`
- WhatsApp message: `slack:thread:wa:<jid>:<ts>` (reuse slack: namespace for threads)
- Outbound draft (no inbound thread): `comms:draft:<channel>:<YYYY-MM-DDTHH-MM>`

### Pre-flight skip-check

```bash
CLAIM_KEY="slack:thread:<channel>:<ts>"   # adjust per channel
ledger query --claim-key "$CLAIM_KEY" --since=-PT24H
```

Skip any message/thread where a `done` or `in_progress` entry exists. Surface
`awaiting_sam` entries as "draft already staged — resend or edit?"

### Claim + resolve

```bash
# Claim before drafting
ledger write \
  --claim-key "$CLAIM_KEY" \
  --kind "draft" \
  --status "in_progress" \
  --title "Comms: <channel> — <brief description>" \
  --ttl-sec 3600

# After user approves + send fires
ledger write \
  --claim-key "$CLAIM_KEY" \
  --kind "send" \
  --status "done" \
  --title "Comms: <channel> — <brief description>" \
  --context "sent via <channel>"
```

## Additional resources

CLI detail: `references/cli.md`.
