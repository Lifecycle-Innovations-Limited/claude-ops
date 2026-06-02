# WhatsApp bridge — endpoints, MCP tools, and when to use which

Canonical reference for the whatsmeow (`go.mau.fi/whatsmeow`, upstream `lharries/whatsapp-mcp`)
WhatsApp bridge used by `ops-inbox` / `ops-comms`. Covers every surface, the correct payloads,
and the **decision rule for MCP vs direct REST vs direct sqlite**.

## Architecture (three surfaces, one store)

```
 your phone (primary device)
        │  WhatsApp multi-device sync
        ▼
 whatsmeow bridge (Go)  ── REST :8080 ──┐         store/messages.db   (chats, messages, contacts, messages_fts)
   ExecStart=whatsapp-bridge            │         store/whatsapp.db    (whatsmeow session: device, app_state, lid_map)
        │                               │
        │ writes both .db files         ▼
        │                       Python MCP server (whatsapp-mcp-server/main.py)
        │                          → queries messages.db directly for reads
        │                          → calls bridge :8080 for sends/archive/backfill
        │                               │
        │                          ops mcp-proxy :8090  (SSE; Claude's MCP client connects HERE)
        ▼                               │
 store/*.db  ◄──────── read directly ───┘   mcp__whatsapp__*  tools
```

- **Bridge REST (:8080)** — the whatsmeow client. The only thing that can talk to WhatsApp servers.
- **MCP tools (`mcp__whatsapp__*`)** — a thin Python wrapper. **Reads** hit `messages.db` directly;
  **writes** (send/archive/backfill/resync/download) call the bridge REST endpoints. Reached through
  the ops **mcp-proxy on :8090** (SSE), NOT :8080 directly.
- **sqlite stores** — `messages.db` (message data) + `whatsapp.db` (whatsmeow session/app-state/lid-map).
  Read-only sqlite is a fully valid surface and the fastest path for classification.

## Liveness checks (do these FIRST)

| Layer | Check | Note |
|---|---|---|
| Bridge REST :8080 | `curl -s -o /dev/null -m4 http://127.0.0.1:8080/` (404 = UP) | **Never** `ss \| grep :8080` — ss renders 8080 as service name `webcache`, so the grep never matches → false "down". |
| MCP proxy :8090 | `ss -ltn \| grep :8090` + `curl -sS -m3 http://127.0.0.1:8090/servers/whatsapp/sse \| head -1` | If :8090 down, `mcp__whatsapp__*` will never load even though the bridge is healthy. |
| systemd | `systemctl --user is-active whatsapp-bridge.service` | `Restart=always`; `whatsapp-bridge-keepalive.timer` (60s) catches hangs. |

## Bridge REST endpoints (direct API, `http://127.0.0.1:8080`)

All POST, JSON body. Source: `whatsapp-bridge/main.go`.

| Endpoint | Body | Returns | Use it for |
|---|---|---|---|
| `POST /api/send` | `{"recipient":"<JID>","message":"<text>"}` | `{success,message}` | Send a text. `recipient` is a full JID (`<phone>@s.whatsapp.net`, `<lid>@lid`, or `<id>@g.us`). |
| `POST /api/download` | `{"message_id":"…","chat_jid":"…"}` | media bytes / path | Fetch media for a message. |
| `POST /api/backfill` | (none) | `{success:"backfill requested"}` | Request history sync for the ~50 most-active chats. Also auto-runs 5s after each `Connected`. |
| `POST /api/resync_app_state` | `{"name":"regular_low","full_sync":true}` | `{success,message}` | Force app-state resync from existing patches. **Cannot fix a fatally-corrupt patch chain — use `/api/recover_app_state`.** |
| `POST /api/recover_app_state` | `{"name":"regular_low"}` | `{success,message}` | **Fatal recovery** for an unverifiable collection (`mismatching LTHash`). Asks the PRIMARY device for an unencrypted snapshot (`BuildAppStateRecoveryRequest`→`SendPeerMessage`); whatsmeow's `handleAppStateRecovery` rebuilds it, bypassing broken patches, and a history backfill fires while the link is alive (Fix L). **Phone-online gated (Fix L):** returns `503 phone offline` if the bridge isn't connected+logged-in, instead of a misleading `success:true`. The ONLY thing that unblocks archive when LTHash is fatally desynced. |
| `POST /api/archive` | `{"chat_jid":"<JID>","archive":true}` | `{success,message}` | Archive / unarchive (`archive:false`). Writes `chats.archived` AND pushes a `regular_low` app-state mutation. **Phone-online gated + auto-recovering (Fix L):** on a local LTHash mismatch OR a server `409 conflict` it auto-heals, then escalates to `recover_app_state` + a bounded retry (~20s) so callers never need a manual recover→retry. Still returns `503 phone offline` if the link is down. |

There is **no** delete/mark-read/group-admin endpoint. There is no `/api/health` — probe `/` (404 = alive).

## MCP tools (`mcp__whatsapp__*`)

Source: `whatsapp-mcp-server/main.py`. Load with
`ToolSearch select:mcp__whatsapp__list_chats,mcp__whatsapp__list_messages,...` (retry 3× at 5s if both ports are up).

| Tool | Backed by | Notes |
|---|---|---|
| `list_chats {sort_by,limit}` | messages.db read | chat list + last-message metadata |
| `list_messages {chat_jid,limit,query}` | messages.db read (FTS5 when `query`) | thread read / full-text search |
| `search_contacts {query}` | messages.db read | name/phone lookup |
| `get_chat {chat_jid}` / `get_contact_chats` / `get_direct_chat_by_contact` / `get_last_interaction` / `get_message_context` | messages.db read | metadata / context windows |
| `send_message {recipient,message}` | → `POST /api/send` | text send |
| `send_file` / `send_audio_message {recipient,media_path}` | → bridge | media send |
| `download_media {message_id,chat_jid}` | → `POST /api/download` | media fetch |
| `resync_app_state {name,full_sync}` | → `POST /api/resync_app_state` | same LTHash caveat |
| `recover_app_state {name}` | → `POST /api/recover_app_state` | **fatal LTHash recovery** — phone must be online; the ONLY thing that unblocks a 409-desynced archive |
| `archive_chat {chat_jid,archive}` | → `POST /api/archive` | routes through the **healing** REST endpoint (Fix M); same app-state blocker only when the phone is offline |

**Every MCP write maps 1:1 to a bridge REST endpoint.** The MCP gives you nothing the REST API can't —
it's a typed wrapper. So the MCP can never succeed where the REST endpoint fails (e.g. archive).

> **`archive_chat` heal routing (Fix M).** `mcp__whatsapp__archive_chat` (and `resync_app_state`)
> deliberately POST to the bridge's `POST /api/archive` (resp. `/api/resync_app_state`) endpoint —
> **never** a raw whatsmeow app-state mutation. `/api/archive` is the **heal source of truth**: on an
> `ErrMismatchingLTHash` / `409 conflict` against a corrupt `regular_low` patch chain (whatsmeow
> #382/#858, e.g. versions v228/v621/v643) it auto-recovers (resync → recover-via-primary-device →
> bounded retry, Fix G/L) and only then UPSERTs `chats.archived` into `messages.db`. Routing the MCP
> tool through this endpoint means every MCP archive gets the same heal as raw `curl`, so archiving
> works going forward instead of dead-ending on a 409. **Durability:** `scripts/whatsapp/apply-patches.py`
> Fix M installs this archive/resync MCP surface (helpers in `whatsapp.py`, import aliases + `@mcp.tool`
> wrappers in `main.py`) self-contained — current upstream `lharries/whatsapp-mcp` ships none of it, so
> without Fix M a fresh reinstall would leave the MCP server with no working `archive_chat` at all. Fix M
> is idempotent against both a pristine upstream clone and an already-patched live tree (sentinels key on
> the function defs, not a marker, so reruns never duplicate).

> **Patcher re-anchoring (Fix E / Fix H subscriber / Fix J).** The `list_chats` `archived` filter and
> the bridge's `*events.Archive` subscriber (the two pieces that keep `messages.db.chats.archived`
> accurate, so `archive_chat` and the inbox-zero `WHERE archived=0` query stay consistent) are installed
> by `apply-patches.py` Fix J + Fix H. Their splice anchors had bit-rotted against current upstream
> (whitespace reflow, dropped trailing commas, a changed `events.LoggedOut` log string), so a fresh
> reinstall silently skipped them. They are now re-anchored to minimal stable tokens (`def get_sender_name`,
> `case *events.LoggedOut:`, `…last_is_from_me\n FROM chats`, etc.) and the Fix E / Fix J-row sentinels
> key on the inserted content's invariant (`def _open_db(`, `archived=bool(chat_data[6])`) so they no-op
> on the live tree (patched by an older patcher with differently-worded comments) rather than duplicating
> the helper. Runtime behaviour is unchanged — only the insertion is made robust.

## Decision rule — MCP vs direct REST vs direct sqlite

1. **READS / classification (list chats, read threads, who-sent-last, search, name resolution)**
   → **direct sqlite on `messages.db`** is the primary path. It has zero transport dependency
   (works even when :8090 proxy is down / MCP unloaded), is the fastest, and is what the MCP reads
   under the hood anyway. Always apply the **lid↔phone identity merge** (`whatsmeow_lid_map` in
   `whatsapp.db`) so one person isn't double-counted. Use `mcp__whatsapp__list_*` instead only when
   you specifically want the MCP's shaping and the proxy is confirmed up.

2. **SENDS (text/media)** → `mcp__whatsapp__send_message` **if** the :8090 proxy loaded the tools;
   **else** `curl -X POST :8080/api/send`. Both are identical on the wire. Always under the Rule-6
   one-draft → one-approval gate (token at `/tmp/.claude-send-ok`).

3. **BACKFILL / freshness** → direct `POST /api/backfill` (no MCP equivalent worth the handshake).
   The `wa-inbox-fresh.sh` gate already does this before a scan.

4. **ARCHIVE / app-state mutations** → `POST /api/archive` (or `mcp__whatsapp__archive_chat` — same path).
   **Currently blocked when app-state is desynced (see below). Do not assume archive works — test once,
   and if it 409s, surface the phone-toggle heal rather than retrying.**

Rule of thumb: **read from sqlite, write through the bridge.** Reach for the MCP only when the proxy is
up and you want its typed shaping; never treat "MCP is down" as "WhatsApp is unavailable" — the bridge
and the DB are still fully usable.

## Known blockers + heals

- **App-state LTHash mismatch (archive / mute / pin / resync 409) → FIXED via `/api/recover_app_state`.**
  `POST /api/archive` returns `409 conflict updating app state (regular_low)` and `resync_app_state`
  returns `failed to verify patch vNNN: mismatching LTHash` (whatsmeow [#382](https://github.com/tulir/whatsmeow/issues/382)/[#858](https://github.com/tulir/whatsmeow/issues/858)).
  The whatsmeow client can't verify the server's `regular_low` patch chain. **Clearing the local
  snapshot does NOT fix it, and a single phone archive-toggle does NOT fully heal it** — the server
  patch chain itself fails verification on re-fetch. **The fix: `POST /api/recover_app_state` with the
  phone online** — it requests a fresh unencrypted snapshot from the primary device and rebuilds the
  collection from scratch (bypassing the broken patches), restoring `regular_low` to a clean version.
  After it lands, archive works on every surface. (Do NOT hand-set `chats.archived=1` — it diverges
  from the phone and can hide future inbound; archive through the bridge instead.) Note: archive is a
  per-chat lid/phone-aware op — archive the actual `chat_jid` of the active chat, not a contacts-table
  JID, which may differ from the live `@lid` chat.

- **fts5 "no such module: fts5" → silent message loss.** If `messages.db` has `messages_fts` triggers
  but the bridge binary lacks fts5, every insert fails and messages (incl. your own phone-sends) are
  dropped. Fixed by building with `-tags sqlite_fts5` + the migrate capability guard (v2.18.8+).

- **Phone-sends missing from the store.** whatsmeow only captures your phone-originated sends while the
  bridge is ONLINE; it cannot re-fetch own-sends missed during downtime. Maximize uptime
  (`Restart=always` + `whatsapp-bridge-keepalive.timer`) and **never needlessly restart the bridge**.

- **lid↔phone split.** The same person appears as `<lid>@lid` and `<pn>@s.whatsapp.net`; merge via
  `whatsmeow_lid_map` before classifying or you double-count.

## systemd units (systemd-user)

| Unit | Role |
|---|---|
| `whatsapp-bridge.service` | the bridge (`Restart=always`, RestartSec=10s) |
| `whatsapp-bridge-keepalive.timer` (60s) | curl-probe hang-detection → restart only on genuine unresponsiveness |
| `whatsapp-backfill.timer` (2h) | periodic history backfill |
| `whatsapp-transcribe.timer` (10m) | Whisper voice-note → `[voice] …` into `content` |

Pre-scan gate: `~/bin/wa-inbox-fresh.sh` (freshness + backfill + transcribe trigger, run before any scan).
