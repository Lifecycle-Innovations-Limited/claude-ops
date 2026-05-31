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
| `POST /api/resync_app_state` | `{"name":"regular_low","full_sync":true}` | `{success,message}` | Force app-state (archive/mute/pin/contacts) resync. **Often fails LTHash — see blocker below.** |
| `POST /api/archive` | `{"chat_jid":"<JID>","archive":true}` | `{success,message}` | Archive / unarchive (`archive:false`). Writes `chats.archived` AND pushes a `regular_low` app-state mutation. **Blocked when app-state is desynced — see blocker.** |

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
| `archive_chat {chat_jid,archive}` | → `POST /api/archive` | same app-state blocker |

**Every MCP write maps 1:1 to a bridge REST endpoint.** The MCP gives you nothing the REST API can't —
it's a typed wrapper. So the MCP can never succeed where the REST endpoint fails (e.g. archive).

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

- **App-state LTHash mismatch (archive / mute / pin / resync 409).** `POST /api/archive` returns
  `409 conflict updating app state (regular_low)`, and `resync_app_state` returns
  `failed to verify patch vNNN: mismatching LTHash`. The whatsmeow client can't verify the server's
  `regular_low` patch chain. **Clearing the local snapshot does NOT fix it** (the server patches
  themselves fail verification on re-fetch). The reliable heal is a **phone-side action: toggle archive
  on ANY one chat from your phone** (archive then unarchive) — that emits a fresh app-state mutation the
  bridge can resync from. Until then, archive is unavailable on every surface (REST and MCP). Setting
  `chats.archived=1` locally is possible but does NOT propagate to the phone and diverges state — avoid.

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
