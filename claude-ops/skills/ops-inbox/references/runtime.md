# Inbox runtime context

Loaded from the parent SKILL.md. Follow `ops-rules`. Run these steps every invocation, before classifying.

## Runtime Context

**Standing default posture — read this first, every run.** Before the offline scan-engine, before any per-channel MCP call, the default mode of this skill is: spin up one agent per available/configured channel (WhatsApp, Email, Slack, Telegram, iMessage, Notion, Discord — whichever are configured; see "Channel availability + fallback" below) via the `Workflow` tool (Agent Teams as the fallback), running in parallel. This is the standing default for the whole skill — you do not wait for triage to discover volume before fanning out; fanning out IS the first move. Each per-channel agent: deep-reads every conversation in its channel, clears the FULL-THREAD AWARENESS GATE, and — for any NEEDS_REPLY candidate — pulls full cross-channel context on that person/topic/thread (gmail search, whatsapp search, the ops-memories contact profile, etc. — per "FULL CONTEXT — NEVER ASSUME" / "FULL-CONTEXT RECALL + CROSS-CHANNEL DEDUP" below) before drafting a reply where one is genuinely needed. It reports back structured recommendations (classification + draft + reasoning, grounded in that cross-channel research) to the orchestrating session. **"READ-ONLY" here means one thing only — never send, archive, mark-read, or mutate anything — it does NOT mean "stay inside your one assigned channel"; agents are granted the cross-channel read/search tools they need for context-gathering.** Every send still goes through the main session's Rule-6 one-draft → one-approval → one-send gate, unchanged (see "Standing behavior: RUN WIDE" and "Workflow fan-out" below for the mechanics and hard constraints). The offline `bin/ops-inbox-scan` step below is a fast pre-filter that FEEDS this fan-out — not a replacement for it, so the per-channel agents aren't blindly scanning everything from scratch. The only exception: skip the fan-out in the genuinely trivial case (script covered everything, ~1-3 candidates left) — that stays the exception, not the default framing.

Before executing, load available context:

0. **Auto-sync WhatsApp in the background (DEFAULT — every invocation)** — the FIRST thing this skill does, before any scan or menu, is guarantee the store is fresh, then fire a recent-conversation history backfill **and** a contacts-link in the background, non-blocking.

   **0a. Freshness gate (run FIRST, blocking, bounded).** Resolve accounts with `ops-wa-accounts` first. Probe **that account's** `api` (local reverse-proxy from `$PREFS_PATH` / registry), never `:8080`, never a remote IP. If policy has `ssh` + `remote_store`, classify by SSH against the live remote sqlite (`/api/chats/unread` on the bridge host loopback, or `sqlite3` over `ssh`). Do **not** treat a missing local `messages.db` as "WhatsApp down". Do **not** `launchctl kickstart` a leftover local LaunchAgent — that is a duplicate session. `~/bin/wa-inbox-fresh.sh` may still backfill via the resolved `api`. Exit 2 from freshness means that account's proxy/upstream failed; try the policy `ssh` path before skipping the channel.

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
  # Per agent-enabled account: use that account's `api` from ops-wa-accounts JSON.
  # `--port` exits 3 when more than one account is enabled — that is a loop, not a stop.
  WA_API="$(python3 -c 'import json,sys; d=json.load(sys.stdin); a=next((x for x in d.get("accounts") or [] if x.get("agent_enabled") and x.get("api")), None); print(a["api"] if a else "")' < <("$CLAUDE_PLUGIN_ROOT/bin/ops-wa-accounts"))"
  [ -n "$WA_API" ] || exit 3
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
   - Check WhatsApp via `ops-wa-accounts` (policy `api` / `ssh`), never `lsof :8080` and never `launchctl kickstart` unless policy says the bridge is local
   - Also verify the **ops mcp-proxy** is up (`lsof -i :8090 | grep LISTEN` only if this box actually runs that proxy) — Claude's MCP client connects through the proxy SSE endpoint, not directly to the bridge
   - If the resolved `api` is down, try policy `ssh` before skipping the channel
   - **Do not declare WhatsApp MCP unavailable purely because tools haven't loaded yet** — when the resolved `api` answers, retry `ToolSearch select:mcp__whatsapp__list_chats,...` up to 3× at 5s intervals to let the SSE handshake complete

4. **Ops memories**: Check `${CLAUDE_PLUGIN_DATA_DIR}/memories/` before drafting any reply:
   - `contact_*.md` — load profile for the contact you're about to reply to
   - `preferences.md` — apply user's communication style and language preferences
   - `topics_active.md` — check for active threads or deadlines related to this contact
   - `donts.md` — never violate these restrictions in drafts

5. **Launch the live inbox watcher (background job, every session)** — right after the steps above, start `bin/ops-inbox-live-watch.sh` via Bash with `run_in_background: true`. It polls the Gmail inbox (via `gog`) every ~4 minutes and exits — with a `NEW INBOX MAIL: <from> | <subject> | <date> | id=<id>` summary line — the instant a genuinely new inbound message lands; it also exits (with a `watcher expired` line) after ~6h if nothing new arrives. **The job's exit IS the new-mail ping** — treat it exactly like a direct orchestrator notification: when it fires, re-scan the affected channel and relaunch the watcher (same command) so live coverage never lapses. Pure bash + python3 + `gog`, no systemd/launchd dependency, cross-platform (Linux + macOS).

Channel processing, FULL-THREAD AWARENESS GATE, and per-channel recipes: `details.md`.
