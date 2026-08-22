# Inbox fan-out (Workflow / Agent Teams)

Loaded from the parent SKILL.md. Follow `ops-rules`. Scanners are read-only. Sends stay in the main session (Rule 6).

### Workflow fan-out (DEFAULT for real per-thread volume — per the note above)

When there is real per-thread volume to deep-read and draft, use the **`Workflow` tool** as
the **default** path: fan out one **read-only** scanner/drafter agent per channel (or per
thread-chunk within a high-volume channel), then synthesize. Channels and chunks are
processed concurrently and wall-clock collapses to the slowest single unit. **Do not fan out
for channels the offline script already fully triaged down to ~1–3 trivial candidates** —
that re-burns the tokens the cheap-triage split exists to save. The rule of thumb: offline
script triages always; the Workflow fan-out does the deep per-thread reasoning whenever
volume is more than a glance.

**Hard constraints (these override convenience — they are how this stays Rule-6-safe):**

- **Read-only scanners — Rule 6.** Every scanner agent's prompt MUST state, verbatim in
  spirit: _"You are READ-ONLY. Do NOT send, archive, mark-read, or mutate anything. Only
  read / search and classify. Return structured results."_ **"READ-ONLY" means exactly
  one thing here — never send, archive, mark-read, or mutate. It does NOT mean "stay inside
  your one assigned channel."** Each agent still owns its assigned channel's classification
  pass, but for any NEEDS_REPLY candidate it must pull full cross-channel context on that
  person/topic/thread before drafting — per "FULL CONTEXT — NEVER ASSUME" and "FULL-CONTEXT
  RECALL + CROSS-CHANNEL DEDUP" below (gmail search across the person's email, whatsapp
  search/list_messages for mentions elsewhere, the ops-memories `contact_*.md` profile,
  etc.) — not just read its own channel's thread in isolation. It then returns a
  recommendation AND a pre-written draft (when one is warranted), grounded in that full
  research, not a raw single-channel classification. **All sending stays in the main
  session**, one draft → one approval → one send. The workflow NEVER sends, archives, or
  mutates — it only reads (across whatever channels the candidate needs) and classifies.
- **Detect availability FIRST.** Only fan out a scanner for a channel that already passed
  the per-channel checks in "Channel availability + fallback". Never spawn a scanner for an
  unconfigured / unreachable channel — it burns a turn and produces a misleading
  "unreachable" row. Build the workflow's channel list from the channels you confirmed up.
- **No `AskUserQuestion` inside the workflow.** Presentation, reply drafting, approval,
  archive, and the Cron offer all happen back in the main session _after_ the workflow
  returns. Workflow agents cannot gate sends, so they must never try.
- **Each scanner loads its own channel's MCP tools** via `ToolSearch select:...` before use,
  and honours the documented reconnect handshake (WhatsApp 3× at 5s, iMessage 5s→15s) before
  reporting a channel unreachable. Never fabricate conversations. **Also grant each agent the
  read-only cross-channel search tools it needs for context-gathering** — at minimum gmail
  search/thread-read, whatsapp search/list_messages, and the ops-memories contact registry —
  so it can look up the same person/topic across other channels before drafting, not just
  its own assigned channel's tools.

**Canonical scan workflow.** Pass the available channels in via `args` (the orchestrator
builds the list from the detected-available channels), so the script body stays stable:

**⚠️ When invoking `Workflow`, you MUST pass the channel task list via the tool call's
top-level `args` parameter (as shown below) — not just referenced inside the `script` body.
Omitting it silently produces zero agents and an empty result, not an error.** A real run
failed this way: `args` was written into the script text but never passed as the tool's
`args` parameter, so the workflow spawned nothing and returned nothing to synthesize.

```js
Workflow({
  args: [
    // ONE entry per channel detected as AVAILABLE. Build select/steps from the
    // per-channel reference sections below. Examples:
    {
      key: 'email',
      select: 'select:mcp__gog__gmail_search,mcp__gog__gmail_read_thread,mcp__gog__gmail_labels',
      steps:
        'gmail_search "in:inbox newer_than:7d"; labels+from on the search envelope are first-pass only — before any NEEDS_REPLY, gog gmail thread get per candidate and clear the FULL-THREAD AWARENESS GATE (full thread both directions, 2-sentence arc, reconcile SENT).',
    },
    {
      key: 'slack',
      select:
        'select:mcp__slack__conversations_unreads,mcp__slack__channels_list,mcp__slack__conversations_history,mcp__slack__conversations_replies',
      steps: 'conversations_unreads to find unread DMs/channels; read latest via history/replies.',
    },
    {
      key: 'whatsapp',
      select:
        'select:mcp__whatsapp__list_chats,mcp__whatsapp__list_messages,mcp__whatsapp__search_contacts,mcp__whatsapp__get_chat',
      steps:
        'list_chats {sort_by:"last_active"}; last_is_from_me is ONLY a first pass. FIRST merge each person lid<->phone chats into one conversation via whatsmeow_lid_map (store/whatsapp.db) so a contact is not double-counted as NEEDS_REPLY on @lid and WAITING on the phone JID. Then, before any NEEDS_REPLY, clear the FULL-THREAD AWARENESS GATE: list_messages {chat_jid, limit: 25} for EACH mapped JID (or the DB union recipe), merge by timestamp, read BOTH directions including is_from_me=1 rows and [voice] transcripts, write the 2-sentence arc summary, and reconcile the user own sends that may be missing from the store. Never classify from the last message alone.',
    },
    {
      key: 'imessage',
      select: 'select:mcp__plugin_imessage_imessage__chat_messages',
      steps:
        'chat_messages {limit:30} (omit chat_guid); classify each thread by who sent the LAST message. Capture the chat_id GUID from each header.',
    },
    {
      key: 'telegram',
      select:
        'select:mcp__plugin_ops_telegram__list_dialogs,mcp__plugin_ops_telegram__get_messages,mcp__plugin_ops_telegram__search_messages',
      steps: 'list_dialogs (last 7d); get_messages for dialogs with pending activity.',
    },
  ],
  script: `
export const meta = {
  name: 'ops-inbox-scan',
  description: 'Read-only parallel scan + classify of all available comms channels',
  phases: [{ title: 'Scan' }, { title: 'Synthesize' }],
}

const SCAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['channel', 'reachable', 'conversations'],
  properties: {
    channel:     { type: 'string' },
    reachable:   { type: 'boolean', description: 'true ONLY if tools were actually called and returned data' },
    note:        { type: 'string',  description: 'tools called, or the exact error if unreachable' },
    conversations: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['who', 'summary', 'status'],
      properties: {
        who:           { type: 'string' },
        summary:       { type: 'string', description: 'one line: what is pending' },
        status:        { type: 'string', enum: ['NEEDS_REPLY', 'WAITING', 'HANDLED', 'FYI'] },
        chatId:        { type: 'string', description: 'JID / chat GUID / threadId needed to reply — capture it now' },
        lastMessageAt: { type: 'string' },
      },
    }},
  },
}

phase('Scan')
// args can arrive as a JSON string (harness serialization) — parse defensively
// so the fan-out never dies with "args.map is not a function".
const CHANNELS = (typeof args === 'string' ? JSON.parse(args) : args) || []
const scans = (await parallel(CHANNELS.map(c => () =>
  agent(
    \`READ-ONLY inbox scanner for the "\${c.key}" channel. You MUST NOT send, archive, \` +
    \`mark-read, or mutate anything — read / search ONLY.\\n\` +
    \`STEP 1: run ToolSearch with query exactly "\${c.select}" to load the tool schemas.\\n\` +
    \`STEP 2: \${c.steps}\\n\` +
    \`Classify each conversation NEEDS_REPLY / WAITING / HANDLED / FYI exactly as STEP 2 \` +
    \`directs (including merged-thread / full-thread rules where specified). Capture chatId \` +
    \`for each (needed later to reply). Cover ~last 7 days plus \` +
    \`anything clearly still open. Retry the documented reconnect handshake before reporting \` +
    \`reachable=false. Never fabricate conversations.\`,
    { label: \`scan:\${c.key}\`, phase: 'Scan', schema: SCAN_SCHEMA }
  )
))).filter(Boolean)

phase('Synthesize')
return await agent(
  \`You are READ-ONLY. Do NOT send, archive, mark-read, or mutate anything — only merge \` +
  \`and order the data below.\\n\` +
  \`Per-channel read-only scan results as JSON:\\n\${JSON.stringify(scans, null, 2)}\\n\\n\` +
  \`Return ONLY structured JSON with buckets: needsReply[], waiting[], fyi[], unreachable[]. \` +
  \`Each item: {channel, who, summary, chatId, lastMessageAt}. Order needsReply most-urgent \` +
  \`first. Do NOT draft replies — that happens in the main session under the per-message gate.\`,
  { label: 'synthesize', phase: 'Synthesize',
    schema: { type: 'object', additionalProperties: true } }
)
`,
});
```

After the workflow returns the synthesized buckets, proceed to **presentation + reply in
the main session** using the per-channel sections below. Stage every reply one-at-a-time
under Rule 6 (one draft → `AskUserQuestion` / approval word → send → next). The workflow
gave you _what_ needs a reply and the `chatId` to reach it; it never sent anything.

### Fallback — Agent Teams support

When the `Workflow` tool is unavailable (older harness) but
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, fall back to **Agent Teams** for the
"all channels" path — same read-only fan-out, just without the Workflow harness. Set up one
read-only scanner teammate per _available_ channel:

```
TeamCreate("inbox-channels")
Agent(team_name="inbox-channels", name="whatsapp-scanner", ...)   # READ-ONLY
Agent(team_name="inbox-channels", name="email-scanner", ...)      # READ-ONLY
Agent(team_name="inbox-channels", name="slack-scanner", ...)      # READ-ONLY
Agent(team_name="inbox-channels", name="telegram-scanner", ...)   # READ-ONLY
```

Each teammate scans its channel and reports classified results back; you can steer
("focus email first") and process replies as they land. Agent Teams' advantage over the
Workflow path is mid-flight steering and shared context (one scanner can flag a message
referencing another channel). If neither `Workflow` nor Agent Teams is available, scan
channels sequentially in the main session.

**Every fallback keeps the same read-only + Rule 6 constraints** — each scanner teammate's
prompt MUST say _"You are READ-ONLY. Do NOT send any outbound messages. Return drafts to the
orchestrator who stages them one-by-one."_ Sending stays in the main session, always.

Hermes fallback: parent SKILL.md + `hermes-plugin/RUNTIME.md` (Rule 10).
