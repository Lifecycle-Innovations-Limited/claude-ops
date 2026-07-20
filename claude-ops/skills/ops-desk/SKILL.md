---
name: ops-desk
description: Desk sweep — turn the owner's backlog of open decisions, staged drafts, payments, sign-offs and chases into a ranked, ready-to-approve action queue. Fans out READ-ONLY context agents (one per item, batched) via the Workflow tool, each returning a structured action package (status + recommendation + full draft in the owner's voice), then walks the queue rapid-fire in the main session under the outbound-approval gate. Complements /ops:ops-inbox (comms triage) — ops-desk handles everything that is NOT a fresh inbound message; decisions, blocked issues, owner-action items.
argument-hint: '[scope: all|<board/company>|explicit item list]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - Workflow
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskList
  - CronCreate
  - mcp__gog__gmail_search
  - mcp__gog__gmail_read_thread
  - mcp__whatsapp__list_messages
  - mcp__whatsapp__send_message
  - mcp__whatsapp__archive_chat
  - mcp__linear__list_issues
  - mcp__linear__get_issue
  - mcp__linear__update_issue
---

# OPS ► DESK SWEEP

Goal: everything sitting on the owner's desk — pending decisions, staged drafts awaiting
approval, unpaid invoices to chase, documents to sign, blocked issues needing an owner
action — becomes a **ranked queue of ready-to-approve action packages**, then gets worked
down one item at a time. The success metric is the same spirit as inbox-zero: **an empty
desk**, with every remaining item either executed, decided, or parked with an explicit
reason and a reminder.

## When to use ops-desk vs ops-inbox

- `/ops:ops-inbox` — fresh inbound comms (who wrote me, what needs a reply).
- `/ops:ops-desk` — the standing backlog (what am I blocking, what decision is waiting on
  me, what draft is staged, what must I sign/pay/approve). Run it after an inbox pass, or
  whenever the owner says "what's left / get this off my desk".

## Step 1 — Build the item list (unless passed explicitly in ``)

1. **Task tracker (SSOT).** Whichever the box uses, in order of preference:
   - **Paperclip** — `paperclip issue list -C <company-id>` for each company in
     `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json → paperclip.companies[]`, falling back to
     `paperclip company list`. Keep `status=blocked|todo|in_progress` issues whose
     title/description implies an OWNER action — matcher: `decision`, `owner decision`,
     `approve`, `sign`, `pay`, `chase`, `staged`, `awaiting owner`, `Rule-6`.
   - **Linear** — `mcp__linear__list_issues` filtered to the owner as assignee, when
     Paperclip is absent.
   - **GitHub** — `gh issue list --assignee @me` as last resort.
2. **Inbox residue.** Genuine NEEDS_REPLY plus todo/action-labeled emails surviving the
   most recent `/ops:ops-inbox` pass (run `bin/ops-inbox-scan` with `OIS_NO_REFRESH=1` if
   one already ran this session).
3. **Dedupe** against items already handled this session, and collapse duplicate issues
   tracking the same underlying ask (mirror boards, Linear↔Paperclip twins).
4. Shape each item as `{key, refs: [issue identifiers], hint}` where `hint` states the
   concrete question to answer AND what must be verified (never trust the issue title
   alone).

## Step 2 — Run the gather workflow (READ-ONLY, batched)

Invoke the **`Workflow`** tool with the script below and `args = [items]`. Hard rules the
script encodes:

- **Agents are READ-ONLY.** No sends, archives, payments, signatures, mark-reads, or
  tracker mutations from inside the workflow — they read, verify, and prepare only. All
  execution happens later in the main session under the outbound-approval gate.
- **Batched fan-out (3 at a time).** A wide parallel burst can rate-limit (429) the
  model-account pool — relay/CRS setups especially. Batches of 3 finish nearly as fast
  and never starve the rest of the fleet.
- **Verification over trust.** Every load-bearing claim in a package must come from an
  actual read (issue body, thread, sqlite row) with dates/ids cited in `status_summary`.
  An item that turns out already handled comes back as `action_type=already_done` with
  evidence.
- **Partial failure → resume.** If some agents die (rate limits, transient errors), fix
  nothing and relaunch with `resumeFromRunId` — completed agents replay from cache.

```js
export const meta = {
  name: 'desk-sweep',
  description: 'Fan out read-only context agents over open decision/action items and return ready-to-approve action packages',
  phases: [
    { title: 'Gather', detail: 'one read-only agent per item, batches of 3' },
    { title: 'Synthesize', detail: 'order into an approval queue: quick wins first' },
  ],
}

const ACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['key', 'title', 'status_summary', 'recommendation', 'action_type'],
  properties: {
    key: { type: 'string' },
    title: { type: 'string' },
    status_summary: { type: 'string', description: '2-4 sentences: what this is, current state, evidence (dates/ids)' },
    recommendation: { type: 'string', description: 'single concrete next action with an approvable default' },
    action_type: { type: 'string', enum: ['send_email', 'send_whatsapp', 'decision', 'sign', 'pay', 'chase', 'info_only', 'archive', 'already_done'] },
    draft: { type: ['object', 'null'], additionalProperties: false, properties: {
      channel: { type: 'string', enum: ['email', 'whatsapp'] },
      to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' },
      body: { type: 'string', description: "FULL final text in the owner's voice + thread language" },
      reply_to_message_id: { type: 'string' },
    }},
    decision_options: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    effort_minutes: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

phase('Gather')
const ITEMS = (typeof args === 'string' ? JSON.parse(args) : args) || []
if (!ITEMS.length) throw new Error('desk-sweep needs args: [{key, refs, hint}]')

const CHUNK = 3
const packages = []
for (let i = 0; i < ITEMS.length; i += CHUNK) {
  const batch = ITEMS.slice(i, i + CHUNK)
  const res = (await parallel(batch.map(it => () =>
    agent(
      `You are a READ-ONLY desk-sweep context agent. You MUST NOT send, archive, pay, sign, ` +
      `mark-read, or mutate ANYTHING — no mail sends, no POSTs to send/archive endpoints, no ` +
      `tracker mutations. Read, search, and prepare only.\n\n` +
      `ITEM key="${it.key}": ${it.hint}\nReferences: ${JSON.stringify(it.refs || [])}\n\n` +
      `Gather context read-only, every shell command with an explicit timeout ` +
      `("timeout --signal=TERM --kill-after=5s 30s <cmd>"): the task tracker record(s) for each ` +
      `ref incl. comments; Gmail via gog (search then thread get -j; messages nest under ` +
      `.thread.messages); the WhatsApp bridge store read-only via sqlite3 (merge a person's @lid ` +
      `and @s.whatsapp.net chats; resolve names via contacts); local files if referenced.\n\n` +
      `RULES: verify every load-bearing claim with an actual read; if already handled, return ` +
      `action_type=already_done with evidence. Drafts must be the FULL final text in the owner's ` +
      `voice and the thread's language, no AI tone. Decisions get 2-4 concrete options, ` +
      `recommended first. Your final output MUST be the structured action package.`,
      { label: `gather:${it.key}`, phase: 'Gather', schema: ACTION_SCHEMA }
    )
  ))).filter(Boolean)
  packages.push(...res)
  log(`gathered ${packages.length}/${ITEMS.length}`)
}

phase('Synthesize')
return await agent(
  `You are READ-ONLY. Order these action packages into an approval queue: quick wins first ` +
  `(low effort, high confidence, drafts ready), then decisions, then heavy/blocked. Drop ` +
  `nothing; flag conflicts between packages.\n\n` + JSON.stringify(packages, null, 2) +
  `\n\nReturn {queue: [same packages verbatim + "rank"], conflicts: [], stats: {total, ` +
  `ready_drafts, decisions, already_done}}.`,
  { label: 'synthesize', phase: 'Synthesize',
    schema: { type: 'object', additionalProperties: true, required: ['queue'] } }
)
```

## Step 3 — Work the approval queue (main session, outbound gate)

Per package, in rank order:

- **`already_done` / `archive` / `info_only`** → report in one line, archive/close
  immediately (tracker status → done). These are the free wins; do them without asking.
- **`send_email` / `send_whatsapp` / `chase`** → PER-DRAFT APPROVAL exactly as in
  `/ops:ops-inbox`: ONE `AskUserQuestion` per draft, single-select `[Send]` `[Edit]`
  `[Skip]`, the `preview` carrying the FULL text plus a short "Reasoning / facts verified"
  block (≤10 short lines — split longer drafts). After `[Send]`: send (email via `gog
  gmail send`, WhatsApp via the bridge), then archive the thread and update the tracker.
  Where an out-of-band send token is enforced (e.g. an outbound-comms hook), remind the
  owner ONCE up front — not per item.
- **`decision`** → present the options (recommended first) via `AskUserQuestion`, record
  the outcome in the tracker, execute any follow-through it implies.
- **`sign` / `pay`** → prepare only: surface the exact link/document/amount and what to
  check before signing/paying. NEVER sign or move money autonomously (Rule 5).

## Step 4 — Wrap up

Report: sent / decided / closed / still-open-with-reason. Schedule reminders
(`CronCreate`, non-outbound) for anything parked with a follow-up horizon. The task
tracker is the SSOT — every touched item gets its status updated there before the
summary prints.
