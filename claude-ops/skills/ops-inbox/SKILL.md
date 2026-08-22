---
name: ops-inbox
description: "This skill should be used when the user asks to \"check inbox\", \"inbox zero\", \"/ops:ops-inbox\", or \"what needs a reply\". Full inbox management across all channels — WhatsApp (whatsmeow bridge via mcp__whatsapp__*), iMessage (chat.db reader + AppleScript send via mcp__plugin_imessage_imessage__*), Email (Gmail MCP), Slack (MCP), Telegram (user-auth MCP), Discord (webhook + REST read), Notion (MCP — comments, mentions, assigned tasks). Scans FULL inbox (not just unread), identifies messages needing replies, archives handled conversations."
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
  - CronCreate
  - CronList
  - mcp__gog__gmail_search
  - mcp__gog__gmail_read_thread
  - mcp__gog__gmail_send
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
  - mcp__whatsapp__send_message
  - mcp__whatsapp__get_chat
  - mcp__whatsapp__get_message_context
  - mcp__whatsapp__archive_chat
  - mcp__whatsapp__resync_app_state
  # iMessage — official `imessage` plugin. chat_messages reads ~/Library/Messages/chat.db
  # (allowlist-scoped); reply sends via AppleScript to Messages.app. No bridge, no daemon.
  - mcp__plugin_imessage_imessage__chat_messages
  - mcp__plugin_imessage_imessage__reply
effort: high
maxTurns: 60
context: fork
---

# OPS ► INBOX ZERO

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

## ⚠️ WHATSAPP TRANSPORT — MCP ONLY, NEVER `wacli`

For **all** WhatsApp operations in this skill (list chats, read messages, search contacts, send replies, archive chats), use the `mcp__whatsapp__*` tool family backed by the whatsmeow (Go) whatsapp-bridge — upstream `lharries/whatsapp-mcp`. (Earlier docs misnamed this as "Baileys" — Baileys is the Node.js WhatsApp library; this bridge uses `go.mau.fi/whatsmeow`.)

> **Server name.** `mcp__whatsapp__*` is the single-account default. Installs with more than one account
> register one server per account (`whatsapp-personal`, `whatsapp-work`, ...) and have no plain
> `mcp__whatsapp__*` at all. Resolve the real name from the available tools before the first call, and
> when several accounts exist, scan each one separately and keep the results labelled by account. See
> CLAUDE.md Rule 8.

**NEVER call the legacy `wacli` CLI** (`wacli chats list`, `wacli messages list`, `wacli send`, `wacli doctor`, `wacli history backfill`, etc). The wacli store and keepalive daemon are deprecated for this skill.

If you find yourself reaching for any `wacli ...` shell command, stop and use the MCP tool with the same intent:

| Intent                        | ✅ Use this                                                                                                                                                                           | ❌ Do NOT use                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| List recent chats             | `mcp__whatsapp__list_chats {sort_by: "last_active", limit: 25}`                                                                                                                       | `wacli chats list`                  |
| Read full thread              | `mcp__whatsapp__list_messages {chat_jid, limit: 20}`                                                                                                                                  | `wacli messages list`               |
| Full-text search              | `mcp__whatsapp__list_messages {query: "<text>", limit: 20}`                                                                                                                           | `wacli messages search`             |
| Resolve a contact             | `mcp__whatsapp__search_contacts {query: "<name>"}`                                                                                                                                    | `wacli contacts`                    |
| Send a reply (after approval) | `mcp__whatsapp__send_message {recipient: "<JID>", message: "<text>"}`                                                                                                                 | `wacli send`                        |
| Health check                  | `lsof -i :8080 \| grep LISTEN` + (macOS) `launchctl print "gui/$(id -u)/com.${USER}.whatsapp-bridge"` / (Linux) `systemctl --user is-active whatsapp-bridge.service`                  | `wacli doctor` / `~/.wacli/.health` |
| Trigger history backfill      | `curl -fsS -X POST "$WA_API/api/backfill"` (resolve `$WA_API` first — see "WHICH NUMBER" below; claude-ops patch — runs per-chat against the 50 most-recent chats; bridge also auto-backfills 5s after every Connected event) | —                                   |

**Rationale:** the bridge exposes a typed MCP surface, returns consistent JSON shapes (`is_from_me`, `content`, `timestamp`, `sender`), supports FTS5 search natively, and avoids store-lock contention with the wacli keepalive daemon. Mixing the two surfaces caused inconsistent state in past sessions.

**Sole exception:** the `~/.wacli/.health` file is still readable for legacy daemon-health surfacing in other skills, but no `wacli` command should be invoked from this skill.

## ⚠️ WHICH NUMBER — resolve the account before the first read or send

**This box may run more than one WhatsApp bridge, one per phone number.** They are identical
processes that differ only by port and store directory. The lowest port answers first, so
`127.0.0.1:8080` looks authoritative whether or not it is the account you want. Every literal
`:8080` below is legacy shorthand for "this account's bridge", never an instruction to use 8080.

**Resolve first, every run, before any read, archive, or send:**

```bash
"$CLAUDE_PLUGIN_ROOT/bin/ops-wa-accounts" --list      # every bridge: port, number, agent yes/no
WA_PORT=$("$CLAUDE_PLUGIN_ROOT/bin/ops-wa-accounts" --port)   # the one agent-enabled account
WA_API="http://127.0.0.1:${WA_PORT}"
```

`ops-wa-accounts` reads each bridge's `run-bridge.sh` and — authoritatively — the number actually
paired in its store, then applies `~/.config/whatsapp/agent-policy.json` (never committed; it holds
real numbers). It exits non-zero rather than pick one when the answer is ambiguous.

**The rules:**

1. **Never hardcode a port, and never use whichever port answers.** Use `$WA_API` from the resolver,
   or the `whatsapp_account.bridge_port` that `ops-inbox-scan` records in its JSON.
2. **A number can be agent-disabled.** An account with `agent_enabled: false` is off-limits: do not
   scan it, do not archive it, do not send from it, do not pair or re-pair it. Someone else may be
   managing that inbox, and traffic from an agent on it is a real-world problem.
3. **If resolution is ambiguous, stop and ask.** Two enabled accounts, or none, is a question for the
   user — `AskUserQuestion` with the candidate numbers. It is never a coin flip.
4. **Reply on the number the thread lives on.** A reply from the wrong number reaches someone who does
   not recognise the sender, and it leaks which numbers the user owns. Cross-account replies are never
   an acceptable fallback.
5. **Rule 8 applies to the MCP surface too.** With several accounts the servers are named per account
   (`mcp__whatsapp-us__*`, `mcp__whatsapp-nl__*`) and a bare `mcp__whatsapp__*` may not exist. Match
   the registered name; do not assume.

**Why this section exists:** on 2026-08-16 a full inbox run followed this skill's hardcoded
`127.0.0.1:8080` and sent every reply from the number that was supposed to stay untouched. The
classification was fine. The account was wrong, and nothing in the run could tell.

## Runtime Context

Default: fan out one read-only scanner per configured channel after the offline scan. Skip fan-out only in the trivial case (~1–3 candidates). Full freshness / Mac fallback / version-heal / watcher: `references/runtime.md`.

Every run, in order:

1. Resolve the WhatsApp account (`ops-wa-accounts` — never hardcode a port).
2. Freshness: `~/bin/wa-inbox-fresh.sh` (blocking, bounded). Then `bin/ops-inbox-scan`.
3. `bin/ops-inbox-archive-set` report-only. Present KEEP vs ARCHIVE; `--apply` only after explicit OK.
4. Deep-read KEEP / NEEDS_REPLY. Fan out if volume (`references/fan-out.md`).
5. Stage drafts one at a time (Rule 6). Archive after a verified send.

Channel processing, FULL-THREAD AWARENESS GATE, and per-channel recipes: `references/details.md`.

## Standing behavior: RUN WIDE — parallel subagents / agent-teams / workflow by DEFAULT

Every `/ops:ops-inbox` run should be fast for the owner, whose time is spent only reviewing and approving — never waiting on serial reads. By default:

- **Fan out the moment there is more than a trivial amount of work.** After the offline `ops-inbox-scan` first pass, push the per-thread deep-read / dedup / context-gathering / draft-writing into parallel background workers — `Workflow` fan-out (preferred) or an Agent-Teams read-only scanner per channel/thread-chunk. Do NOT deep-read dozens of threads serially in the main session.
- **Do research, context-gathering, and draft-writing in the background while the owner works.** Kick off the readers/drafters; let them build full-thread arcs, cross-channel dedup, contact profiles, and staged draft text concurrently. Surface results as they land so the owner approves in a steady stream instead of after one big serial pass.
- **Parallelism NEVER changes the safety model.** Workers are strictly READ-ONLY — they classify and return draft text only. Every outbound send stays in the main session, one draft → one `AskUserQuestion` → one approval → one send (Rule 6 + PER-DRAFT APPROVAL).
- **Respect the box concurrency ceiling** (heartbeat `MAX_BUSY`) — queue extra work rather than exceeding it.

## Scan engine — offline script triages first, Workflow fan-out is the DEFAULT for deep per-thread work

**Run `bin/ops-inbox-scan` FIRST. It is the primary scan engine.** It classifies the two
heaviest channels — WhatsApp (direct read of the whatsmeow sqlite store) and Email (one
`gog gmail search`) — deterministically, in-process, in well under a second, emitting compact
JSON. No subagents, no MCP, near-zero tokens.

```bash
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-scan" --pretty            # both channels
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-scan" --whatsapp-only     # WA only
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-scan" --days 14           # wider window
# target a specific WhatsApp account (both flags, or neither):
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-scan" \
  --wa-store ~/.local/share/whatsapp-mcp/whatsapp-bridge-<label>/store/messages.db \
  --bridge-port <port>
```

With no flags the scan resolves the single agent-enabled account itself and **exits 3 rather than
guess** when that is ambiguous. Its JSON carries a `whatsapp_account` block (`phone`, `bridge_port`,
`store`, `resolved_by`) — that is the account every downstream archive and reply must use, and
`ops-inbox-archive-set` reads it so the two can never drift onto different numbers.

**ARCHIVE/KEEP SPLIT — `bin/ops-inbox-archive-set`.** The scan says what the
inbox looks like; this turns that into the two lists inbox-zero actually needs,
deterministically, instead of re-deciding a few hundred rows by eye every run:

```bash
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-archive-set"                      # report only
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-scan" | \
  "$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-archive-set" -                  # reuse a scan
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-archive-set" --scan /tmp/scan.json --json
# extra WhatsApp account (repeat the pair per account):
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-archive-set" \
  --wa-store ~/.local/share/whatsapp-mcp/whatsapp-bridge-us/store/messages.db \
  --bridge-port 8082
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-archive-set" --apply               # AFTER approval
```

- **ARCHIVE** — WAITING (you sent last), courtesy tails with no open ask
  ("thanks!", "will do!!"), threads past `--stale-days` (7), dead groups past
  `--dead-group-days` (30).
- **REVIEW (FYI)** — newsletters, broadcasts, automated mail. **Never swept.**
  Read it, brief the user, then ask; `--archive-fyi` is the opt-in that answer
  unlocks. See the FYI core principle below.
- Undescribed media (`[image]`, `[voice]` with no enrichment yet) is **unknown**,
  never a tail — it always lands in KEEP.
- **KEEP** — every genuine unanswered ask, plus every email carrying a
  todo/action label. Ambiguity always resolves to KEEP; keeping is safe,
  archiving is the risky direction.
- **Report-only by default.** It archives nothing without `--apply`, and never
  sends. Present the counts plus the KEEP list with `AskUserQuestion`, and only
  re-run with `--apply` after an explicit OK. `--apply --dry-run` walks the path
  without calling out.
- It enforces the todo/action-label HARD GUARDRAIL in code, so a labelled mail
  cannot be swept even when it looks exactly like a newsletter.

**ONE-SHOT TRIAGE:** `bin/ops-inbox-zero` attempts the inbox-zero
pipeline (scan → Paperclip SSOT → Slack direct API → dual-JID deep-read → proposed WA/email
archive actions → KEEP report) in one shell call. Gmail, Slack, or Paperclip can be skipped
when authentication or local services are unavailable; the report surfaces each status.
The agent still does the manual nuance
refinement (unsure rows + Rule-6 inline drafts + Telegram AskUserQuestion), but the script
handles the deterministic 80% in ~5s so the agent only spends tokens on judgment calls.

```bash
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-zero"                   # safe report-only default
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-zero" --archive         # only after explicit approval
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-zero" --no-slack        # skip Slack triage
"$CLAUDE_PLUGIN_ROOT/bin/ops-inbox-zero" --days 14         # wider window
```

Always run the report-only command first. Present the exact proposed WhatsApp and Gmail
archive items/counts with `AskUserQuestion`; only after explicit approval rerun the same
arguments with `--archive`. Never infer approval from a previous run. `unsure` items are
report-only and are never archived or unarchived by the script.

Outputs:
- `/tmp/ops-inbox-scan-clean.json` — raw scan output
- `/tmp/ops-inbox-keep.json` — classified KEEP/ARCHIVE/UNSURE rows (incl. Slack DMs)
- `/tmp/slack-triage.txt` — Slack direct-API triage (AUTH + human DMs)
- `~/.local/share/ops-inbox/keep-<ts>.md` — final report (agent reads this for Telegram)

**Why this exists:** the multi-channel scan used to fan out one Workflow subagent per
channel. A single real run burned **~330k subagent tokens / 5 agents / ~130s** to do work
that, for WhatsApp, is a sqlite read, and for Email, is a CLI call. The script does the same
classification (and _better_ — it merges each person's lid↔phone chats into one
conversation and resolves real names from `contacts`) for free. Reserve agent fan-out for
genuine reasoning, not for reading a database.

`ops-inbox-scan` JSON always includes `whatsapp` / `email` buckets (`needs_reply`, `waiting`, `groups`, `fyi`) plus `whatsapp_account` and `counts`. Partial failure still emits valid JSON.

**What the script does NOT do — and what you do next, in the MAIN session (no subagents):**

1. **Slack** — one `mcp__slack__conversations_unreads {include_messages:true}` call. One
   round-trip; a subagent is pure overhead. Skip entirely if prefs show 0 workspaces.
2. **Telegram** — one `mcp__plugin_ops_telegram__list_dialogs` call (skip the
   Pocket ops bot dialog — that's automation). Skip if unconfigured.
3. **FULL-THREAD AWARENESS GATE on the few NEEDS_REPLY candidates** — the script's WhatsApp
   buckets are merged-thread, last-direction-correct _first passes_; its `groups` entries
   are explicitly un-classified. Its email `needs_reply` is an envelope first pass. Before
   you draft ANY reply, clear the gate per "Processing each channel": for the handful of
   candidates, read the full thread both directions (incl. `[voice]`), write the 2-sentence
   arc, reconcile the user's own phone-sent messages, and demote anything already answered.
   You are now doing deep reads on ~3 threads, not scanning hundreds — that is the whole
   point of the split: cheap script-side triage, expensive reasoning only where it pays.

**Fan-out for real per-thread volume.** After the cheap scan, deep-read and draft in parallel (`Workflow` default; Agent Teams / Hermes `delegate_task` fallback). Skip only the trivial case (~1–3 candidates). Mechanics, hard constraints, and the canonical Workflow JS: `references/fan-out.md`. Fan-out never sends, archives, or mutates — Rule 6 stays in the main session.

## Agent Teams support

When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set and `Workflow` is missing, fan out one read-only scanner per available channel:

```
TeamCreate("inbox-channels")
Agent(team_name="inbox-channels", name="whatsapp-scanner", ...)
```

If the flag is NOT set, use `Workflow` or sequential main-session reads. Full script and hard constraints: `references/fan-out.md`.

### Fallback — Hermes / Grok (`delegate_task`)

When this skill runs on Hermes or Grok (no `Workflow` tool, no `AskUserQuestion`):

- **Fan-out:** `delegate_task` for one read-only scanner per available channel. If that
  tool is missing, scan sequentially in the main session. Same read-only contract.
- **Approval:** numbered options in chat. On Telegram, two turns — full draft as its own
  bubble, then the `[Send]` `[Edit]` `[Skip]` card. Never bundle drafts. Never put the
  only copy of the draft in a clipped preview.
- Plugin-wide table: Rule 10 in `CLAUDE.md` and `hermes-plugin/RUNTIME.md`.

## Additional resources

Read the matching file before acting. Do not skip.

- `references/cli.md` — WhatsApp MCP + gog CLI
- `references/details.md` — inbox-zero rules, gates, per-channel processing
- `references/runtime.md` — freshness, Mac fallback, version-heal, watcher
- `references/fan-out.md` — Workflow JS, Agent Teams, hard constraints
- `CHANNELS.md` — channel setup
