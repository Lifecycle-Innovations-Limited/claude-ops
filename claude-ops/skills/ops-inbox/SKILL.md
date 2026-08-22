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

**Standing default posture — read this first, every run.** Before the offline scan-engine, before any per-channel MCP call, the default mode of this skill is: spin up one agent per available/configured channel (WhatsApp, Email, Slack, Telegram, iMessage, Notion, Discord — whichever are configured; see "Channel availability + fallback" below) via the `Workflow` tool (Agent Teams as the fallback), running in parallel. This is the standing default for the whole skill — you do not wait for triage to discover volume before fanning out; fanning out IS the first move. Each per-channel agent: deep-reads every conversation in its channel, clears the FULL-THREAD AWARENESS GATE, and — for any NEEDS_REPLY candidate — pulls full cross-channel context on that person/topic/thread (gmail search, whatsapp search, the ops-memories contact profile, etc. — per "FULL CONTEXT — NEVER ASSUME" / "FULL-CONTEXT RECALL + CROSS-CHANNEL DEDUP" below) before drafting a reply where one is genuinely needed. It reports back structured recommendations (classification + draft + reasoning, grounded in that cross-channel research) to the orchestrating session. **"READ-ONLY" here means one thing only — never send, archive, mark-read, or mutate anything — it does NOT mean "stay inside your one assigned channel"; agents are granted the cross-channel read/search tools they need for context-gathering.** Every send still goes through the main session's Rule-6 one-draft → one-approval → one-send gate, unchanged (see "Standing behavior: RUN WIDE" and "Workflow fan-out" below for the mechanics and hard constraints). The offline `bin/ops-inbox-scan` step below is a fast pre-filter that FEEDS this fan-out — not a replacement for it, so the per-channel agents aren't blindly scanning everything from scratch. The only exception: skip the fan-out in the genuinely trivial case (script covered everything, ~1-3 candidates left) — that stays the exception, not the default framing.

Before executing, load available context:

0. **Auto-sync WhatsApp in the background (DEFAULT — every invocation)** — the FIRST thing this skill does, before any scan or menu, is guarantee the store is fresh, then fire a recent-conversation history backfill **and** a contacts-link in the background, non-blocking.

   **0a. Freshness gate (run FIRST, blocking, bounded).** Before classifying anything, run `~/bin/wa-inbox-fresh.sh` (shipped by `scripts/install-whatsapp-bridge-linux.sh`). It probes the bridge with a real **curl connection probe** (`curl -s -m4 http://127.0.0.1:8080/`), forces a backfill, triggers voice-note transcription, and waits (bounded ~32s) for the newest message to settle, then prints a FRESHNESS report (`newest message = … (N min old)`). It **only restarts the bridge if the curl probe genuinely fails twice** — do NOT gate liveness on `ss | grep :8080`, because `ss` renders port 8080 as the service name `webcache`, so the grep never matches and you'd needlessly bounce a healthy bridge. Exit 2 means the bridge is down and unrecoverable → the store is STALE, do not trust last-sender classification.

### Mac WhatsApp.app fallback (bridge-miss recovery)

The whatsmeow bridge can **silently miss inbound messages** when its history/app-state sync lags — most often on `@lid` chats (e.g. 2026-06-11 it missed a reply from a contact that the Mac WhatsApp.app had). The Mac app keeps an **unencrypted** local Core Data store at `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`, readable over Tailscale SSH, so it is a reliable ground-truth backstop.

- **When it runs AUTOMATICALLY:** `wa-inbox-fresh.sh` now invokes the Mac cross-check itself whenever the bridge store looks stale — on exit 2 (store unreadable) or when the newest message is >2h old, it prints a `MAC GROUND TRUTH` block (latest 10 messages from the Mac app store) inline in the freshness report. No orchestration needed.
- **When to use manually:** a contact's _known_ reply is missing from the bridge (common on `@lid` chats) — cross-check before classifying that thread as "no reply".
- **Command:** `bin/wa-mac-latest.sh --contact <name|number> [N]` (also `--recent [N]`, `--since "YYYY-MM-DD HH:MM"`, add `--json` for machine-readable output). It reads `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite` over SSH. Schema: `ZWAMESSAGE` (`ZTEXT`, `ZISFROMME`, `ZMESSAGEDATE` = seconds since 2001-01-01) joined to `ZWACHATSESSION` (`ZPARTNERNAME`, `ZCONTACTJID`).
- **Transport chain (`bin/wa-mac-transport.sh`, shared by all wa-mac-\* scripts):** ① Tailscale/direct SSH (`WA_MAC_SSH=user@host`) → ② Cloudflare-tunnel SSH (`WA_MAC_CF_HOST=ssh-mac.example.com`, via `cloudflared access ssh` ProxyCommand) when Tailscale is down. One-time wiring: `scripts/setup-wa-mac-cf-tunnel.sh` (installs cloudflared locally + the Mac LaunchDaemon from a remotely-managed tunnel token, then verifies end-to-end). Both env vars live in the shell profile, never in the repo.
- **READ-ONLY ground truth for reads.** The reader never writes and never sends. Sends still go through the whatsmeow bridge (`mcp__whatsapp__send_message`) under the Rule-6 outbound-approval gate — the Mac store is only consulted to confirm what actually arrived. The ONLY write-capable Mac surface is `wa-mac-archive.sh` (archive-only, see Tier 4 of the archive ladder).
- **Why no Linux-native alternative:** there is no official WhatsApp Linux desktop app; the third-party Flatpak clients (`whatsapp-for-linux`, ZapZap) are Electron WhatsApp-Web wrappers that need a GUI, consume a linked-device slot, and store data in encrypted IndexedDB (not a queryable SQLite) — so the Mac `ChatStorage.sqlite` is the preferred backstop.

  **The FULL-THREAD AWARENESS GATE (in "Processing each channel") depends on this step having run first.** That gate's "read both directions incl. `[voice]`" only works once `wa-inbox-fresh.sh` (freshness + backfill) and the voice-note transcription pass (step 0c) have completed and the store has settled — otherwise outbound rows and `[voice]` bodies are still missing and the gate reads an incomplete thread.

  **0b. Background backfill + contacts-link** (idempotent, safe every time). The backfill pulls recent messages for the 50 most-active chats; the link populates `messages.db.contacts` from the whatsmeow session store so both `<pn>@s.whatsapp.net` and `<lid>@lid` chat JIDs resolve to names (without it the `contacts` table is empty and LID-format chats show raw phone numbers):

  ```bash
  BR="${WHATSAPP_BRIDGE_DIR:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge}"
  WA_PORT=$("$CLAUDE_PLUGIN_ROOT/bin/ops-wa-accounts" --port) || exit 3   # never assume 8080
  WA_API="http://127.0.0.1:${WA_PORT}"
  if curl -s -o /dev/null -m 4 "$WA_API/" 2>/dev/null; then
    curl -fsS -m 10 -X POST "$WA_API/api/backfill" >/dev/null 2>&1 &   # recent-conversation backfill
    [ -f "$BR/link_contacts.py" ] && python3 "$BR/link_contacts.py" >/dev/null 2>&1 &  # contacts link (phone + LID aliases)
  fi
  ```

  Kick this off, then continue with the steps below while it runs — give the link ~2s before name-resolving chats. `link_contacts.py` resolves names via `whatsmeow_contacts` + `whatsmeow_lid_map` (name preference: full_name → first_name → push_name → business_name). It ships via `scripts/install-whatsapp-bridge-linux.sh` into the bridge dir; recreate it from `whatsmeow_contacts`/`whatsmeow_lid_map` if absent.

  **0c. Voice notes are first-class.** Incoming voice notes (`media_type='audio'`, empty `content`) are auto-transcribed into `content` as `[voice] <text>` by the `whatsapp-transcribe.timer` (systemd-user, every 10 min, OpenAI `whisper-1`) — and `wa-inbox-fresh.sh` triggers a transcribe pass on every scan. So a voice note shows up in NEEDS_REPLY / thread scans exactly like a text message; treat a `[voice] …` body as the sender's words. Transcription is idempotent (only ever fills empty audio rows, never clobbers real text) and capped per run, so it never re-bills or stacks.

  **0c-bis. ALL media is now first-class, not just voice.** Beyond voice→`[voice]` (transcribe above), incoming **video / image / document** media (empty `content`) is auto-enriched into `content` as `[video] …` / `[image] …` / `[document] …` by `transcriber/enrich_media.py` (vision for stills/video frames + Whisper for any audio track) on the `whatsapp-enrich.timer` (systemd-user, every 10 min) — and `wa-inbox-fresh.sh` queues an enrich pass on every scan. So an image, clip, or PDF shows up in NEEDS_REPLY / thread scans with a real, readable body, exactly like text. Enrichment is idempotent (only fills empty media rows) and capped per run. The bridge also **self-heals media that 403/404/410s** (stale `directPath`, common for larger media) by asking the sender's phone to re-upload via `SendMediaRetryReceipt` (`apply-patches.py` Fix M), so large media never silently drops.

  **0d. The scan engine self-refreshes + self-reconciles on EVERY run — this is automatic, you do not orchestrate it.** `bin/ops-inbox-scan` (the primary classifier, step "Scan engine" below) now does the refresh/pull itself, BLOCKING and bounded, before it classifies — so the data is converged by the time you read its JSON, regardless of whether the background `ops-inbox-autosync` hook has finished. On each invocation the scan:
  - **Refreshes (frontfill/backfill):** if this account's bridge is reachable (the port it resolved, not a fixed `:8080`), it fires `POST /api/backfill` + `link_contacts.py`, then **waits (bounded ~18s) for the newest stored message timestamp to stop advancing** so the classify pass reads a settled store. This is the blocking guarantee the background hook alone does NOT give. Skip with `OIS_NO_REFRESH=1` (set automatically on repeat calls in one session to avoid re-waiting).
  - **Reconciles outbound sends (owner directive 2026-06-05 "include all things I sent to all people"):** it reads the bridge's outbound-send journal (`journalctl --user -u whatsapp-bridge.service`, or the bridge log file on non-systemd hosts) into a `{recipient_jid → latest_send_epoch}` map, and **demotes any NEEDS_REPLY thread whose last inbound is older than a send to any of that person's JIDs** (`reconciled` flag set, moved to WAITING). This catches replies that went out via `/api/send` or a phone send that has not yet landed in `messages.db` — the single most common false-NEEDS_REPLY. Only epoch-stamped send lines drive demotion (a send that genuinely predates the inbound never demotes).

  Net effect: running `/ops:ops-inbox` autonomously pulls the latest state AND folds in everything the user already sent, with **zero extra orchestration on your part** — just read the scan JSON. A `reconciled` field on a WAITING item means "already answered, reply not yet in the store"; never re-draft it. You still clear the FULL-THREAD AWARENESS GATE on whatever genuine NEEDS_REPLY candidates remain.

1. **Self-heal plugin version pin** — if any `${CLAUDE_PLUGIN_DATA_DIR}` file or `~/.claude/plugins/installed_plugins.json` references a `cache/ops-marketplace/ops/X.Y.Z/` path that no longer exists on disk, downstream hooks (`stop-all.sh`, `ops-post-session-cleanup`) emit `Plugin directory does not exist`. Resolve before scanning:

   ```bash
   INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
   CACHE_DIR="$HOME/.claude/plugins/cache/ops-marketplace/ops"
   PINNED=$(python3 -c "import json; d=json.load(open('$INSTALLED')); print(d.get('plugins',{}).get('ops@ops-marketplace',[{}])[0].get('version',''))")
   LATEST=$(ls "$CACHE_DIR" 2>/dev/null | sort -V | tail -1)
   if [ -n "$PINNED" ] && [ -n "$LATEST" ] && [ "$PINNED" != "$LATEST" ] && [ ! -d "$CACHE_DIR/$PINNED" ]; then
     python3 -c "
   import json
   p='$INSTALLED'; d=json.load(open(p))
   for e in d.get('plugins',{}).get('ops@ops-marketplace',[]):
     if e.get('version')=='$PINNED':
       e['version']='$LATEST'
       e['installPath']='$CACHE_DIR/$LATEST'
   json.dump(d, open(p,'w'), indent=2)
   "
     bash "$HOME/.claude/scripts/hooks/ops-plugin-version-heal.sh"   # rewrites daemon-services.json + mcp-proxy/servers.json
   fi
   ```

   The existing `ops-plugin-version-heal.sh` only rewrites _downstream_ targets from `installed_plugins.json` (the source of truth). When the source itself is stale, the heal hook is a no-op — patch it first, then re-run the hook.

2. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `default_channels` — which channels to scan by default
   - `secrets_manager` / `doppler` — how to resolve channel credentials if not in env

3. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - Check `whatsapp-bridge` status — verify `com.${USER}.whatsapp-bridge` is running (`lsof -i :8080` or `launchctl print "gui/$(id -u)/com.${USER}.whatsapp-bridge"`)
   - Also verify the **ops mcp-proxy** is up on `:8090` (`lsof -i :8090 | grep LISTEN`) — Claude's MCP client connects through the proxy SSE endpoint, not directly to the bridge. If :8080 is up but :8090 is down, `mcp__whatsapp__*` tools will never load.
   - If either layer is down, surface the issue before WhatsApp operations
   - **Do not declare WhatsApp MCP unavailable purely because tools haven't loaded yet** — when both ports are LISTEN, retry `ToolSearch select:mcp__whatsapp__list_chats,...` up to 3× at 5s intervals to let the SSE handshake complete

4. **Ops memories**: Check `${CLAUDE_PLUGIN_DATA_DIR}/memories/` before drafting any reply:
   - `contact_*.md` — load profile for the contact you're about to reply to
   - `preferences.md` — apply user's communication style and language preferences
   - `topics_active.md` — check for active threads or deadlines related to this contact
   - `donts.md` — never violate these restrictions in drafts

5. **Launch the live inbox watcher (background job, every session)** — right after the steps above, start `bin/ops-inbox-live-watch.sh` via Bash with `run_in_background: true`. It polls the Gmail inbox (via `gog`) every ~4 minutes and exits — with a `NEW INBOX MAIL: <from> | <subject> | <date> | id=<id>` summary line — the instant a genuinely new inbound message lands; it also exits (with a `watcher expired` line) after ~6h if nothing new arrives. **The job's exit IS the new-mail ping** — treat it exactly like a direct orchestrator notification: when it fires, re-scan the affected channel and relaunch the watcher (same command) so live coverage never lapses. Pure bash + python3 + `gog`, no systemd/launchd dependency, cross-platform (Linux + macOS).

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

**ONE-SHOT TRIAGE (Sam 2026-07-21):** `bin/ops-inbox-zero` attempts the inbox-zero
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

`ops-inbox-scan` output (always valid JSON, even on partial failure):

```jsonc
{
  "generated_at": "…", "window_days": 7,
  "whatsapp": {
    "needs_reply": [ { "who", "jid", "alt_jids", "last_message_at", "age_min",
                       "last_from_me", "preview":[{from_me,text}] } ],
    "waiting":  [ … ],   // you sent last — no action
    "groups":   [ … ],   // group chats w/ recent activity + preview — YOU scan these
                         // for @mentions / a direct question before any NEEDS_REPLY
    "fyi":      [ … ]    // newsletters / broadcasts
  },
  "email": { "reachable": true, "needs_reply":[…], "waiting":[…], "fyi":[…] },
  "counts": { … }, "notes": [ … ]
}
```

**What the script does NOT do — and what you do next, in the MAIN session (no subagents):**

1. **Slack** — one `mcp__slack__conversations_unreads {include_messages:true}` call. One
   round-trip; a subagent is pure overhead. Skip entirely if prefs show 0 workspaces.
2. **Telegram** — one `mcp__plugin_ops_telegram__list_dialogs` call (skip the
   `@SamCloudDevBot` / Pocket ops bot dialog — that's automation). Skip if unconfigured.
3. **FULL-THREAD AWARENESS GATE on the few NEEDS_REPLY candidates** — the script's WhatsApp
   buckets are merged-thread, last-direction-correct _first passes_; its `groups` entries
   are explicitly un-classified. Its email `needs_reply` is an envelope first pass. Before
   you draft ANY reply, clear the gate per "Processing each channel": for the handful of
   candidates, read the full thread both directions (incl. `[voice]`), write the 2-sentence
   arc, reconcile the user's own phone-sent messages, and demote anything already answered.
   You are now doing deep reads on ~3 threads, not scanning hundreds — that is the whole
   point of the split: cheap script-side triage, expensive reasoning only where it pays.

**When to use the Workflow fan-out below — DEFAULT for real per-thread volume:** the offline
`ops-inbox-scan` is the cheap first-pass triage and always runs first, but the per-thread
deep-read/draft work (clearing the FULL-THREAD AWARENESS GATE + cross-channel dedup on every
candidate) is **reasoning work, and reasoning work fans out in parallel by default.** The
moment there is real volume — more than a handful of NEEDS_REPLY candidates across channels,
a Slack/Telegram/iMessage backlog of human threads, or any channel the script can't reach —
**default to the `Workflow` fan-out**: launch one read-only drafter/scanner agent per
channel (or per thread-chunk within a channel), run them concurrently, and synthesize. This
is faster and more token-efficient than serially deep-reading dozens of threads in the main
session, and it collapses wall-clock to the slowest single channel.

**The only time you skip the fan-out** is the genuinely trivial case: the script already
covered everything and only ~1–3 threads need a deep read (e.g. WA + email with a couple of
candidates and a glance at Slack/Telegram). Then the script + a couple of inline MCP calls is
enough and a fan-out would be pure overhead. For anything with real per-thread volume, the
fan-out is the default — not a fallback.

**Either way, the fan-out NEVER sends, archives, or mutates.** Scanner/drafter agents are
strictly read-only and return classifications + draft text; **every outbound send stays in
the main session under the Rule-6 one-draft → one-approval → one-send gate.** Defaulting to
parallel fan-out changes only HOW threads are read and drafted, never the outbound-approval
safety.

---

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

### Fallback — Hermes (`delegate_task`)

When this skill runs on Hermes (no `Workflow` tool, no `AskUserQuestion`):

- **Fan-out:** `delegate_task` for one read-only scanner per available channel. If that
  tool is missing, scan sequentially in the main session. Same read-only contract.
- **Approval:** numbered options in chat. On Telegram, two turns — full draft as its own
  bubble, then the `[Send]` `[Edit]` `[Skip]` card. Never bundle drafts. Never put the
  only copy of the draft in a clipped preview.
- Plugin-wide table: Rule 10 in `CLAUDE.md` and `hermes-plugin/RUNTIME.md`.

## Additional resources

Channel, CLI, and edge-case detail lives in `references/` next to this skill. Read those files before acting on a matching channel or sub-command. Do not skip them.
