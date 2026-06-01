#!/usr/bin/env python3
"""Idempotently patch upstream lharries/whatsapp-mcp for Linux EC2 deploys.

Applied to ~/.local/share/whatsapp-mcp/{whatsapp-bridge/main.go, whatsapp-mcp-server/whatsapp.py}.

Patches included:
  Fix A — 3s sleep between client.Connect() and PairPhone (whatsmeow noise
          handshake race; library hangs silently otherwise).
  Fix B — context.WithTimeout(3m) wrapping PairPhone so internal hangs are
          recoverable (context.Background() never times out).
  Auto-backfill on events.Connected (5s delay).
  POST /api/backfill REST endpoint for on-demand / scheduled backfill.
  Crash-safe requestHistorySync — whatsmeow's BuildHistorySyncRequest panics
          on nil *types.MessageInfo; new impl picks the 50 most-active chats
          and anchors against each chat's oldest stored message.
  Python whatsapp.py — LID-to-phone resolver via whatsmeow_lid_map, and
          contact-name lookup via whatsmeow_contacts (replaces the macOS-only
          `contacts` table populated by the Contacts.app mapper).
  Fix C — Outbound send persistence: /api/send handler persists sent messages
          as is_from_me=1 rows in messages.db immediately after SendMessage
          succeeds. Without this, agent-sent messages were absent from the MCP
          read path (bridge only stored phone-originated echoes, not API sends).
  Fix D — POST /api/resync_app_state REST endpoint: makes the MCP server's
          resync_app_state tool actually reachable (previously returned 404).
          Triggers client.FetchAppState for the requested patch name.
  Fix E — Python MCP shape fix: all tool functions now return JSON-serialisable
          dicts (not dataclass objects). Adds _open_db() with WAL mode so reads
          never block the bridge writer and always see the latest committed state
          (single source of truth). Fixes the 30+ pydantic validation errors on
          list_chats, list_messages, search_contacts, get_chat, get_contact_chats,
          get_direct_chat_by_contact, get_last_interaction, get_message_context.
  Fix F — POST /api/archive endpoint: implement archive/unarchive via
          whatsmeow's appstate.BuildArchive + client.SendAppState. Body:
          {"chat_jid":"...","archive":true}. On LTHash mismatch, auto-heals
          by clearing the stale patch rows and retrying once (Fix G below).
  Fix G — Auto-heal LTHash corruption: when any app-state op returns an error
          wrapping appstate.ErrMismatchingLTHash, delete the stale version/MAC
          rows for that patch name from whatsapp.db and re-request a full_sync
          from version 0 (max 2 attempts, never loops). Identity/session/
          pre_key tables are never touched.
  Fix H — Persist archive state: idempotent ALTER TABLE to add an `archived`
          INTEGER NOT NULL DEFAULT 0 column to the chats table in messages.db.
          Subscribes to *events.Archive and UPSERT-updates the flag. Makes
          inbox = WHERE archived=0 directly queryable without hitting the
          bridge's app-state layer on every scan.
  Fix I — Preserve archived on StoreChat: the original StoreChat used
          `INSERT OR REPLACE INTO chats (jid, name, last_message_time)`, and
          REPLACE deletes+reinserts the row — silently resetting the `archived`
          column (Fix H) back to its DEFAULT (0) on every chat update (i.e. every
          new message). Archived chats wrongly resurfaced in the inbox. Replaced
          with an UPSERT (ON CONFLICT(jid) DO UPDATE) that touches only name and
          last_message_time, leaving `archived` untouched.
  Fix J — list_chats: expose archived status and filter it out by default.
          Adds `chats.archived` to SELECT, an `include_archived: bool = False`
          param (when False appends `chats.archived = 0` to WHERE), maps the
          column into the Chat dataclass and _chat_to_dict output as `archived`
          bool. Ops-inbox and other callers see only active chats by default;
          pass include_archived=True to recover the old behaviour.

Every patch is gated on a sentinel string so re-running is a no-op.

Usage:
  apply-patches.py [--install-dir PATH]
    --install-dir  Defaults to ~/.local/share/whatsapp-mcp
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

REPO_DIR_DEFAULT = pathlib.Path.home() / ".local/share/whatsapp-mcp"

# ─── main.go: PairPhone race (Fix A + Fix B) ─────────────────────────────────
PAIR_NEEDLE = """\t\t// No ID stored — pairing-code mode (PairPhone)
\t\terr = client.Connect()
\t\tif err != nil {
\t\t\tlogger.Errorf(\"Failed to connect: %v\", err)
\t\t\treturn
\t\t}

\t\tphone := os.Getenv(\"WA_PHONE\")
\t\tif phone == \"\" {
\t\t\tphone = \"31614446458\"
\t\t}
\t\tcode, perr := client.PairPhone(context.Background(), phone, true, whatsmeow.PairClientChrome, \"Chrome (Linux)\")"""

PAIR_REPLACEMENT = """\t\t// No ID stored — pairing-code mode (PairPhone)
\t\terr = client.Connect()
\t\tif err != nil {
\t\t\tlogger.Errorf(\"Failed to connect: %v\", err)
\t\t\treturn
\t\t}

\t\t// claude-ops Fix A: per whatsmeow PairPhone godoc — wait for the websocket+noise
\t\t// handshake to complete before requesting a pair code, otherwise PairPhone
\t\t// silently hangs on the IQ response (no PairSuccess, no error).
\t\ttime.Sleep(3 * time.Second)

\t\tphone := os.Getenv(\"WA_PHONE\")
\t\tif phone == \"\" {
\t\t\tphone = \"31614446458\"
\t\t}
\t\t// claude-ops Fix B: bound PairPhone with a real deadline. context.Background() has
\t\t// no deadline, so an internal hang in PairPhone is unrecoverable; with a
\t\t// deadline the call returns and we hit the outer select watchdog.
\t\tpairCtx, pairCancel := context.WithTimeout(context.Background(), 3*time.Minute)
\t\tdefer pairCancel()
\t\tcode, perr := client.PairPhone(pairCtx, phone, true, whatsmeow.PairClientChrome, \"Chrome (Linux)\")"""

PAIR_SENTINEL = "per whatsmeow PairPhone godoc"

# ─── main.go: auto-backfill on Connected ─────────────────────────────────────
AUTO_BACKFILL_NEEDLE = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")

\t\tcase *events.LoggedOut:"""

AUTO_BACKFILL_REPLACEMENT = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")
\t\t\t// claude-ops: auto-trigger a deep history backfill on every Connected event.
\t\t\t// Idempotent — whatsmeow dedups by message ID. Delayed 5s so the initial
\t\t\t// history sync the server pushes on connect has a chance to settle.
\t\t\tgo func(c *whatsmeow.Client) {
\t\t\t\ttime.Sleep(5 * time.Second)
\t\t\t\tlogger.Infof(\"Auto-backfill: requesting extra history\")
\t\t\t\trequestHistorySync(c)
\t\t\t}(client)

\t\tcase *events.LoggedOut:"""

AUTO_BACKFILL_SENTINEL = "deep history backfill on every Connected event"

# ─── main.go: /api/backfill REST endpoint ────────────────────────────────────
API_BACKFILL_NEEDLE = """\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""

API_BACKFILL_REPLACEMENT = """\t// claude-ops: on-demand history backfill — POST /api/backfill.
\thttp.HandleFunc(\"/api/backfill\", func(w http.ResponseWriter, r *http.Request) {
\t\tif r.Method != http.MethodPost {
\t\t\thttp.Error(w, \"Method not allowed\", http.StatusMethodNotAllowed)
\t\t\treturn
\t\t}
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tif !client.IsConnected() {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{\"success\":false,\"error\":\"client not connected\"}`)
\t\t\treturn
\t\t}
\t\tgo requestHistorySync(client)
\t\tfmt.Fprintln(w, `{\"success\":true,\"message\":\"backfill requested\"}`)
\t})

\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""

API_BACKFILL_SENTINEL = 'http.HandleFunc("/api/backfill"'

# ─── main.go: crash-safe requestHistorySync ──────────────────────────────────
SAFE_RHS_NEEDLE = """// Request history sync from the server
func requestHistorySync(client *whatsmeow.Client) {
\tif client == nil {
\t\tfmt.Println(\"Client is not initialized. Cannot request history sync.\")
\t\treturn
\t}

\tif !client.IsConnected() {
\t\tfmt.Println(\"Client is not connected. Please ensure you are connected to WhatsApp first.\")
\t\treturn
\t}

\tif client.Store.ID == nil {
\t\tfmt.Println(\"Client is not logged in. Please scan the QR code first.\")
\t\treturn
\t}

\t// Build and send a history sync request
\thistoryMsg := client.BuildHistorySyncRequest(nil, 100)
\tif historyMsg == nil {
\t\tfmt.Println(\"Failed to build history sync request.\")
\t\treturn
\t}

\t_, err := client.SendMessage(context.Background(), types.JID{
\t\tServer: \"s.whatsapp.net\",
\t\tUser:   \"status\",
\t}, historyMsg)

\tif err != nil {
\t\tfmt.Printf(\"Failed to request history sync: %v\\n\", err)
\t} else {
\t\tfmt.Println(\"History sync requested. Waiting for server response...\")
\t}
}"""

SAFE_RHS_REPLACEMENT = """// Request history sync from the server.
//
// claude-ops: whatsmeow's BuildHistorySyncRequest REQUIRES a non-nil
// *types.MessageInfo (it dereferences .Chat / .ID / .Timestamp). Passing nil
// panics with SIGSEGV — see whatsmeow send.go:572. To do a deep backfill we
// therefore iterate the most recently active chats and request older messages
// *before the oldest message we already have* in each. This is also more
// efficient than asking the server for global history.
func requestHistorySync(client *whatsmeow.Client) {
\tif client == nil {
\t\tfmt.Println(\"Client is not initialized. Cannot request history sync.\")
\t\treturn
\t}
\tif !client.IsConnected() {
\t\tfmt.Println(\"Client is not connected. Please ensure you are connected to WhatsApp first.\")
\t\treturn
\t}
\tif client.Store.ID == nil {
\t\tfmt.Println(\"Client is not logged in. Please scan the QR code first.\")
\t\treturn
\t}

\tdb, err := sql.Open(\"sqlite3\", \"file:store/messages.db?_foreign_keys=on&mode=ro\")
\tif err != nil {
\t\tfmt.Printf(\"Backfill: failed to open messages.db: %v\\n\", err)
\t\treturn
\t}
\tdefer db.Close()

\trows, err := db.Query(`SELECT jid FROM chats ORDER BY last_message_time DESC LIMIT 50`)
\tif err != nil {
\t\tfmt.Printf(\"Backfill: chat enumeration failed: %v\\n\", err)
\t\treturn
\t}
\tchatJIDs := []string{}
\tfor rows.Next() {
\t\tvar j string
\t\tif err := rows.Scan(&j); err == nil {
\t\t\tchatJIDs = append(chatJIDs, j)
\t\t}
\t}
\trows.Close()
\tif len(chatJIDs) == 0 {
\t\tfmt.Println(\"Backfill: no chats yet — initial sync will populate; skipping.\")
\t\treturn
\t}

\trequested := 0
\tfor _, chatJID := range chatJIDs {
\t\tvar msgID, sender string
\t\tvar ts time.Time
\t\tvar isFromMe bool
\t\trow := db.QueryRow(
\t\t\t`SELECT id, sender, timestamp, is_from_me
                FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC LIMIT 1`,
\t\t\tchatJID)
\t\tif err := row.Scan(&msgID, &sender, &ts, &isFromMe); err != nil {
\t\t\tcontinue
\t\t}
\t\tchatJ, err := types.ParseJID(chatJID)
\t\tif err != nil {
\t\t\tcontinue
\t\t}
\t\tanchor := &types.MessageInfo{
\t\t\tMessageSource: types.MessageSource{Chat: chatJ, IsFromMe: isFromMe},
\t\t\tID:            msgID,
\t\t\tTimestamp:     ts,
\t\t}
\t\thistoryMsg := client.BuildHistorySyncRequest(anchor, 100)
\t\tif historyMsg == nil {
\t\t\tcontinue
\t\t}
\t\tif _, err := client.SendMessage(context.Background(), types.JID{
\t\t\tServer: \"s.whatsapp.net\",
\t\t\tUser:   \"status\",
\t\t}, historyMsg); err == nil {
\t\t\trequested++
\t\t}
\t}
\tfmt.Printf(\"Backfill: requested extra history for %d chat(s)\\n\", requested)
}"""

SAFE_RHS_SENTINEL = "whatsmeow's BuildHistorySyncRequest REQUIRES"

# ─── whatsapp.py: LID + whatsmeow_contacts resolver ──────────────────────────
PY_PATH_NEEDLE = """MESSAGES_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'whatsapp-bridge', 'store', 'messages.db')
WHATSAPP_API_BASE_URL = "http://localhost:8080/api\""""

PY_PATH_REPLACEMENT = """MESSAGES_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'whatsapp-bridge', 'store', 'messages.db')
# claude-ops: whatsmeow's own store DB — holds contacts (full_name / push_name) and
# the LID↔phone map. Authoritative for contact name resolution; the messages.db
# `chats.name` is only populated when whatsmeow happens to push the name, so it
# leaves group senders unresolved.
WHATSAPP_DEVICE_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'whatsapp-bridge', 'store', 'whatsapp.db')
WHATSAPP_API_BASE_URL = "http://localhost:8080/api"


def _resolve_lid_to_pn(jid_or_lid: str) -> str:
    \"\"\"claude-ops: If jid_or_lid is a LID jid (e.g. ``218030407741450@lid`` or bare
    digits matching whatsmeow_lid_map.lid), return the phone-number form
    (``<pn>@s.whatsapp.net``). Otherwise return the input unchanged.\"\"\"
    if not jid_or_lid:
        return jid_or_lid
    bare = jid_or_lid.split('@')[0]
    bare_core = bare.split(':')[0]
    if not bare_core.isdigit():
        return jid_or_lid
    try:
        conn = sqlite3.connect(WHATSAPP_DEVICE_DB_PATH)
        cur = conn.cursor()
        cur.execute(\"SELECT pn FROM whatsmeow_lid_map WHERE lid = ? LIMIT 1\", (bare_core,))
        row = cur.fetchone()
        if row and row[0]:
            return f\"{row[0]}@s.whatsapp.net\"
    except sqlite3.Error:
        pass
    finally:
        if 'conn' in locals():
            conn.close()
    return jid_or_lid


def _name_from_whatsmeow_contacts(jid: str):
    \"\"\"claude-ops: Look up display name from whatsmeow's own contacts table
    (full_name → push_name → business_name → first_name). Tries the jid as-given,
    then a LID-resolved form, then a bare-phone LIKE match.\"\"\"
    if not jid:
        return None
    try:
        conn = sqlite3.connect(WHATSAPP_DEVICE_DB_PATH)
        cur = conn.cursor()
        candidates = {jid}
        resolved = _resolve_lid_to_pn(jid)
        if resolved != jid:
            candidates.add(resolved)
        bare = jid.split('@')[0].split(':')[0]
        if bare.isdigit():
            candidates.add(f\"{bare}@s.whatsapp.net\")
        for cand in candidates:
            cur.execute(
                \"\"\"SELECT COALESCE(NULLIF(full_name,''), NULLIF(push_name,''),
                                   NULLIF(business_name,''), NULLIF(first_name,''))
                       FROM whatsmeow_contacts
                       WHERE their_jid = ? LIMIT 1\"\"\",
                (cand,))
            row = cur.fetchone()
            if row and row[0]:
                return row[0]
        if bare.isdigit():
            cur.execute(
                \"\"\"SELECT COALESCE(NULLIF(full_name,''), NULLIF(push_name,''),
                                   NULLIF(business_name,''), NULLIF(first_name,''))
                       FROM whatsmeow_contacts
                       WHERE their_jid LIKE ? LIMIT 1\"\"\",
                (f\"{bare}@%\",))
            row = cur.fetchone()
            if row and row[0]:
                return row[0]
    except sqlite3.Error:
        pass
    finally:
        if 'conn' in locals():
            conn.close()
    return None"""

PY_PATH_SENTINEL = "_name_from_whatsmeow_contacts"

# ─── main.go Fix C: persist outbound sends to messages.db (is_from_me=1) ─────
# The /api/send handler called client.SendMessage but discarded the response and
# never wrote a row to messages.db. Phone-originated self-sends were stored via
# the inbound event path, but agent sends via POST /api/send were invisible to
# the MCP read path. This patch persists each successful send immediately.
OUTBOUND_PERSIST_NEEDLE = """\t// Send message
\t_, err = client.SendMessage(context.Background(), recipientJID, msg)

\tif err != nil {
\t\treturn false, fmt.Sprintf("Error sending message: %v", err)
\t}

\treturn true, fmt.Sprintf("Message sent to %s", recipient)
}"""

OUTBOUND_PERSIST_REPLACEMENT = """\t// Send message
\tsendResp, err := client.SendMessage(context.Background(), recipientJID, msg)

\tif err != nil {
\t\treturn false, fmt.Sprintf("Error sending message: %v", err)
\t}

\t// claude-ops Fix C: persist the sent message to messages.db so the MCP server
\t// sees it as is_from_me=1 (single source of truth). The bridge's inbound event
\t// handler stores phone-originated sends; POST /api/send sends were previously
\t// never written. INSERT OR REPLACE is idempotent if whatsmeow also echoes it.
\tif messageStore != nil {
\t\tchatJID := recipientJID.String()
\t\tsenderJID := client.Store.ID.User
\t\tts := sendResp.Timestamp
\t\tif ts.IsZero() {
\t\t\tts = time.Now()
\t\t}
\t\tmsgID := string(sendResp.ID)
\t\tif msgID == "" {
\t\t\tmsgID = client.GenerateMessageID()
\t\t}
\t\t_ = messageStore.StoreChat(chatJID, "", ts)
\t\t_ = messageStore.StoreMessage(
\t\t\tmsgID, chatJID, senderJID, message, ts, true,
\t\t\t"", "", "", nil, nil, nil, 0,
\t\t)
\t}

\treturn true, fmt.Sprintf("Message sent to %s", recipient)
}"""

OUTBOUND_PERSIST_SENTINEL = "claude-ops Fix C: persist the sent message"

# The function signature must also accept *MessageStore (needle matches original)
OUTBOUND_SIG_NEEDLE = "func sendWhatsAppMessage(client *whatsmeow.Client, recipient string, message string, mediaPath string) (bool, string) {"
OUTBOUND_SIG_REPLACEMENT = "func sendWhatsAppMessage(client *whatsmeow.Client, messageStore *MessageStore, recipient string, message string, mediaPath string) (bool, string) {"
OUTBOUND_SIG_SENTINEL = "messageStore *MessageStore, recipient string"

# The /api/send call site must pass messageStore
OUTBOUND_CALLSITE_NEEDLE = "success, message := sendWhatsAppMessage(client, req.Recipient, req.Message, req.MediaPath)"
OUTBOUND_CALLSITE_REPLACEMENT = "// messageStore passed so outbound is persisted immediately (claude-ops Fix C)\n\t\tsuccess, message := sendWhatsAppMessage(client, messageStore, req.Recipient, req.Message, req.MediaPath)"
OUTBOUND_CALLSITE_SENTINEL = "messageStore passed so outbound is persisted immediately"

# The appstate import is needed for Fix D
APPSTATE_IMPORT_NEEDLE = (
    '\t"go.mau.fi/whatsmeow"\n\twaProto "go.mau.fi/whatsmeow/binary/proto"'
)
APPSTATE_IMPORT_REPLACEMENT = '\t"go.mau.fi/whatsmeow"\n\t"go.mau.fi/whatsmeow/appstate"\n\twaProto "go.mau.fi/whatsmeow/binary/proto"'
APPSTATE_IMPORT_SENTINEL = '"go.mau.fi/whatsmeow/appstate"'

# ─── main.go Fix D: POST /api/resync_app_state REST endpoint ──────────────────
RESYNC_ENDPOINT_NEEDLE = """\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""

RESYNC_ENDPOINT_REPLACEMENT = """\t// claude-ops Fix D: POST /api/resync_app_state — force a full whatsmeow
\t// app-state resync. Used by the MCP server's resync_app_state tool.
\t// Body: {"name":"regular_low","full_sync":true}
\thttp.HandleFunc(\"/api/resync_app_state\", func(w http.ResponseWriter, r *http.Request) {
\t\tif r.Method != http.MethodPost {
\t\t\thttp.Error(w, \"Method not allowed\", http.StatusMethodNotAllowed)
\t\t\treturn
\t\t}
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tif !client.IsConnected() {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{\"success\":false,\"message\":\"client not connected\"}`)
\t\t\treturn
\t\t}
\t\tvar req struct {
\t\t\tName     string `json:\"name\"`
\t\t\tFullSync bool   `json:\"full_sync\"`
\t\t}
\t\treq.Name = \"regular_low\"
\t\treq.FullSync = true
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err == nil {
\t\t\tif req.Name == \"\" {
\t\t\t\treq.Name = \"regular_low\"
\t\t\t}
\t\t}
\t\tif err := client.FetchAppState(context.Background(), appstate.WAPatchName(req.Name), req.FullSync, false); err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":%q}`, err.Error())
\t\t\treturn
\t\t}
\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"app-state %s resynced\"}`, req.Name)
\t})

\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""

RESYNC_ENDPOINT_SENTINEL = "claude-ops Fix D: POST /api/resync_app_state"

# ─── main.go Fix I: POST /api/recover_app_state REST endpoint ─────────────────
# Recovers a FATALLY corrupt app-state collection. When the server's patch chain
# is unverifiable ("failed to verify patch vNNN: mismatching LTHash", whatsmeow
# #382/#858) neither /api/archive nor /api/resync_app_state can apply or re-fetch
# it — clearing the local snapshot doesn't help because the server snapshot itself
# fails the LTHash check. whatsmeow's only real recovery is to ask the PRIMARY
# device for an unencrypted copy: BuildAppStateRecoveryRequest -> SendPeerMessage.
# The phone replies with a PEER_DATA_OPERATION_RESPONSE that whatsmeow's
# handleAppStateRecovery (auto-wired in message.go) uses to rebuild the collection
# from scratch, bypassing the broken patches. After it lands, archive works.
# Applies AFTER Fix D (anchors on the goroutine block Fix D re-emits).
RECOVER_ENDPOINT_NEEDLE = RESYNC_ENDPOINT_NEEDLE
RECOVER_ENDPOINT_REPLACEMENT = """\t// claude-ops Fix I: POST /api/recover_app_state — recover a FATALLY corrupt
\t// app-state collection whose server patch chain is unverifiable (LTHash
\t// mismatch, whatsmeow #382/#858). Asks the user's PRIMARY device for an
\t// unencrypted snapshot; whatsmeow's handleAppStateRecovery rebuilds from it.
\t// The phone MUST be online to respond. Body: {"name":"regular_low"} (default).
\thttp.HandleFunc(\"/api/recover_app_state\", func(w http.ResponseWriter, r *http.Request) {
\t\tif r.Method != http.MethodPost {
\t\t\thttp.Error(w, \"Method not allowed\", http.StatusMethodNotAllowed)
\t\t\treturn
\t\t}
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tif !client.IsConnected() {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{\"success\":false,\"message\":\"client not connected\"}`)
\t\t\treturn
\t\t}
\t\tvar req struct {
\t\t\tName string `json:\"name\"`
\t\t}
\t\treq.Name = \"regular_low\"
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err == nil {
\t\t\tif req.Name == \"\" {
\t\t\t\treq.Name = \"regular_low\"
\t\t\t}
\t\t}
\t\tmsg := whatsmeow.BuildAppStateRecoveryRequest(appstate.WAPatchName(req.Name))
\t\tif _, err := client.SendPeerMessage(context.Background(), msg); err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":%q}`, err.Error())
\t\t\treturn
\t\t}
\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"recovery request sent to primary device for %s — it returns a fresh snapshot in a few seconds (phone must be online), then archive works\"}`, req.Name)
\t})

\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""
RECOVER_ENDPOINT_SENTINEL = "claude-ops Fix I: POST /api/recover_app_state"

# ─── main.go Fix D (Connected): auto-resync regular_low on startup ────────────
CONNECTED_RESYNC_NEEDLE = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")
\t\t\t// claude-ops: auto-trigger a deep history backfill on every Connected event."""

CONNECTED_RESYNC_REPLACEMENT = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")
\t\t\t// claude-ops Fix I: do NOT auto-touch regular_low app-state on connect.
\t\t\t// The previous handler ran FetchAppState(regular_low, fullSync=true), which
\t\t\t// DELETED the local snapshot and re-fetched the server's broken patch chain
\t\t\t// (\"failed to verify patch vNNN: mismatching LTHash\", whatsmeow #382/#858),
\t\t\t// re-corrupting it on EVERY connect and undoing any recovery. Auto-requesting
\t\t\t// recovery on connect is also wrong — it overwrites a good in-sync snapshot
\t\t\t// with the phone's low-version recovery baseline, so the next archive mutation
\t\t\t// conflicts with the server head (409). Correct behaviour: leave regular_low
\t\t\t// untouched and recover ON DEMAND via POST /api/recover_app_state only when an
\t\t\t// archive/mute/pin op actually fails with LTHash.
\t\t\t// claude-ops: auto-trigger a deep history backfill on every Connected event."""

CONNECTED_RESYNC_SENTINEL = (
    "claude-ops Fix I: do NOT auto-touch regular_low app-state on connect"
)

# ─── whatsapp.py Fix E: WAL-mode _open_db + dict serialisation helpers ────────
# The MCP server returned raw dataclass objects where FastMCP expected dicts,
# causing 30+ pydantic validation errors on every list_chats / list_messages
# call. This patch adds _open_db (WAL mode, read-only) and _*_to_dict helpers,
# then all public functions return dicts/list-of-dicts.
PY_SHAPE_NEEDLE = """@dataclass
class MessageContext:
    message: Message
    before: List[Message]
    after: List[Message]


def get_sender_name(sender_jid: str) -> str:"""

PY_SHAPE_REPLACEMENT = """@dataclass
class MessageContext:
    message: Message
    before: List[Message]
    after: List[Message]


# claude-ops Fix E: serialization helpers + WAL-mode DB open.
# All public tool functions return plain dicts so FastMCP can validate them.
def _open_db(path: str, read_only: bool = True):
    \"\"\"Open SQLite in WAL mode: reads see bridge's latest committed state without
    ever blocking or being blocked by the bridge writer (single source of truth).\"\"\"
    import sqlite3 as _sq
    if read_only:
        conn = _sq.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        conn = _sq.connect(path, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except _sq.Error:
        pass
    return conn


def _message_to_dict(msg) -> dict:
    ts = msg.timestamp
    return {
        "id": msg.id,
        "chat_jid": msg.chat_jid,
        "chat_name": msg.chat_name,
        "sender": msg.sender,
        "content": msg.content,
        "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
        "is_from_me": bool(msg.is_from_me),
        "media_type": msg.media_type,
    }


def _chat_to_dict(chat) -> dict:
    lmt = chat.last_message_time
    return {
        "jid": chat.jid,
        "name": chat.name,
        "last_message_time": lmt.isoformat() if hasattr(lmt, "isoformat") else (str(lmt) if lmt else None),
        "last_message": chat.last_message,
        "last_sender": chat.last_sender,
        "last_is_from_me": bool(chat.last_is_from_me) if chat.last_is_from_me is not None else None,
        "is_group": chat.is_group,
    }


def _contact_to_dict(contact) -> dict:
    return {"phone_number": contact.phone_number, "name": contact.name, "jid": contact.jid}


def get_sender_name(sender_jid: str) -> str:"""

PY_SHAPE_SENTINEL = "claude-ops Fix E: serialization helpers + WAL-mode DB open"


# ─── whatsapp.py Fix J: list_chats exposes archived + excludes by default ──────
# The chats table has an `archived` column (added by Fix H in main.go) but
# list_chats never selected it, so archived chats were returned indistinguishably
# from active ones. Fix J:
#   1. Adds `archived` field to the Chat dataclass (defaulting False —
#      backwards-compatible; callers that don't read it are unaffected).
#   2. Adds `chats.archived` to the SELECT column list (new 7th positional col).
#   3. Maps chat_data[6] → Chat.archived in the row→Chat constructor call.
#   4. Adds `archived` key to _chat_to_dict output.
#   5. Adds `include_archived: bool = False` param to list_chats; when False,
#      prepends `chats.archived = 0` to the WHERE clause so archived chats are
#      excluded unless explicitly requested.

# --- 1. Chat dataclass: add archived field ---
PY_CHAT_DATACLASS_NEEDLE = """@dataclass
class Chat:
    jid: str
    name: Optional[str]
    last_message_time: Optional[datetime]
    last_message: Optional[str] = None
    last_sender: Optional[str] = None
    last_is_from_me: Optional[bool] = None"""

PY_CHAT_DATACLASS_REPLACEMENT = """@dataclass
class Chat:
    jid: str
    name: Optional[str]
    last_message_time: Optional[datetime]
    last_message: Optional[str] = None
    last_sender: Optional[str] = None
    last_is_from_me: Optional[bool] = None
    archived: bool = False  # claude-ops Fix J: exposed from chats.archived column"""

PY_CHAT_DATACLASS_SENTINEL = "claude-ops Fix J: exposed from chats.archived column"

# --- 2. _chat_to_dict: add archived key ---
PY_CHAT_TO_DICT_NEEDLE = """        "is_group": chat.is_group,
    }


def _contact_to_dict"""

PY_CHAT_TO_DICT_REPLACEMENT = """        "is_group": chat.is_group,
        "archived": bool(chat.archived),  # claude-ops Fix J
    }


def _contact_to_dict"""

PY_CHAT_TO_DICT_SENTINEL = '"archived": bool(chat.archived),  # claude-ops Fix J'

# --- 3. list_chats SELECT: add chats.archived column ---
PY_LIST_CHATS_SELECT_NEEDLE = """            SELECT
                chats.jid,
                chats.name,
                chats.last_message_time,
                messages.content as last_message,
                messages.sender as last_sender,
                messages.is_from_me as last_is_from_me
            FROM chats"""

PY_LIST_CHATS_SELECT_REPLACEMENT = """            SELECT
                chats.jid,
                chats.name,
                chats.last_message_time,
                messages.content as last_message,
                messages.sender as last_sender,
                messages.is_from_me as last_is_from_me,
                chats.archived
            FROM chats"""

PY_LIST_CHATS_SELECT_SENTINEL = "chats.archived\n            FROM chats"

# --- 4. list_chats signature + archived WHERE filter ---
PY_LIST_CHATS_SIG_NEEDLE = """def list_chats(
    query: Optional[str] = None,
    limit: int = 20,
    page: int = 0,
    include_last_message: bool = True,
    sort_by: str = "last_active",
) -> List[Chat]:
    \"\"\"Get chats matching the specified criteria.\"\"\"
    try:
        conn = sqlite3.connect(MESSAGES_DB_PATH)
        cursor = conn.cursor()

        # Build base query
        query_parts = ["""

PY_LIST_CHATS_SIG_REPLACEMENT = """def list_chats(
    query: Optional[str] = None,
    limit: int = 20,
    page: int = 0,
    include_last_message: bool = True,
    sort_by: str = "last_active",
    include_archived: bool = False,  # claude-ops Fix J: exclude archived by default
) -> List[Chat]:
    \"\"\"Get chats matching the specified criteria.\"\"\"
    try:
        conn = sqlite3.connect(MESSAGES_DB_PATH)
        cursor = conn.cursor()

        # Build base query
        query_parts = ["""

PY_LIST_CHATS_SIG_SENTINEL = "claude-ops Fix J: exclude archived by default"

# --- 5. list_chats WHERE: inject archived=0 filter ---
PY_LIST_CHATS_WHERE_NEEDLE = """        where_clauses = []
        params = []

        if query:
            where_clauses.append(
                "(LOWER(chats.name) LIKE LOWER(?) OR chats.jid LIKE ?)"
            )
            params.extend([f"%{query}%", f"%{query}%"])

        if where_clauses:
            query_parts.append("WHERE " + " AND ".join(where_clauses))"""

PY_LIST_CHATS_WHERE_REPLACEMENT = """        where_clauses = []
        params = []

        # claude-ops Fix J: filter archived unless caller opts in
        if not include_archived:
            where_clauses.append("chats.archived = 0")

        if query:
            where_clauses.append(
                "(LOWER(chats.name) LIKE LOWER(?) OR chats.jid LIKE ?)"
            )
            params.extend([f"%{query}%", f"%{query}%"])

        if where_clauses:
            query_parts.append("WHERE " + " AND ".join(where_clauses))"""

PY_LIST_CHATS_WHERE_SENTINEL = "claude-ops Fix J: filter archived unless caller opts in"

# --- 6. list_chats row mapping: read chat_data[6] as archived ---
PY_LIST_CHATS_ROW_NEEDLE = """            chat = Chat(
                jid=chat_data[0],
                name=chat_data[1],
                last_message_time=datetime.fromisoformat(chat_data[2])
                if chat_data[2]
                else None,
                last_message=chat_data[3],
                last_sender=chat_data[4],
                last_is_from_me=chat_data[5],
            )"""

PY_LIST_CHATS_ROW_REPLACEMENT = """            chat = Chat(
                jid=chat_data[0],
                name=chat_data[1],
                last_message_time=datetime.fromisoformat(chat_data[2])
                if chat_data[2]
                else None,
                last_message=chat_data[3],
                last_sender=chat_data[4],
                last_is_from_me=chat_data[5],
                archived=bool(chat_data[6]) if len(chat_data) > 6 else False,  # claude-ops Fix J
            )"""

PY_LIST_CHATS_ROW_SENTINEL = (
    "archived=bool(chat_data[6]) if len(chat_data) > 6 else False,  # claude-ops Fix J"
)


# ─── Fix K: wire /api/recover_app_state into the MCP server ───────────────────
# The bridge exposes POST /api/recover_app_state (Fix I) but upstream's MCP server
# only had resync_app_state. These three patches add the recover_app_state MCP tool
# (whatsapp-mcp-server/main.py import + @mcp.tool wrapper) and its bridge-call helper
# (whatsapp-mcp-server/whatsapp.py), so the fatal-recovery path is reachable as
# mcp__whatsapp__recover_app_state, not just via raw curl.
MCP_IMPORT_NEEDLE = """    resync_app_state as whatsapp_resync_app_state,
)"""
MCP_IMPORT_REPLACEMENT = """    resync_app_state as whatsapp_resync_app_state,
    recover_app_state as whatsapp_recover_app_state,  # claude-ops Fix K
)"""
MCP_IMPORT_SENTINEL = "recover_app_state as whatsapp_recover_app_state"

MCP_TOOL_NEEDLE = """    success, message = whatsapp_resync_app_state(name, full_sync)
    return {"success": success, "message": message}


@mcp.tool()
def archive_chat(chat_jid: str, archive: bool = True) -> Dict[str, Any]:"""
MCP_TOOL_REPLACEMENT = """    success, message = whatsapp_resync_app_state(name, full_sync)
    return {"success": success, "message": message}


@mcp.tool()
def recover_app_state(name: str = "regular_low") -> Dict[str, Any]:
    \"\"\"Fatal-recovery for a corrupt WhatsApp app-state collection (claude-ops Fix K).

    Use when archive_chat / resync_app_state keep failing with a "mismatching
    LTHash" / 409 conflict that resync cannot fix — the server's patch chain is
    unverifiable (whatsmeow #382/#858). This asks the user's PRIMARY device for a
    fresh unencrypted snapshot and rebuilds the collection from scratch, bypassing
    the broken patches. The phone MUST be online; allow a few seconds, then retry
    archive_chat.

    Args:
        name: Patch name to recover (default regular_low — holds archive/mute/pin).
    \"\"\"
    success, message = whatsapp_recover_app_state(name)
    return {"success": success, "message": message}


@mcp.tool()
def archive_chat(chat_jid: str, archive: bool = True) -> Dict[str, Any]:"""
MCP_TOOL_SENTINEL = (
    'def recover_app_state(name: str = "regular_low") -> Dict[str, Any]:'
)

MCP_HELPER_NEEDLE = """        return False, f"Error: HTTP {response.status_code} - {response.text}"
    except requests.RequestException as e:
        return False, f"Request error: {e}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def archive_chat(chat_jid: str, archive: bool = True) -> Tuple[bool, str]:"""
MCP_HELPER_REPLACEMENT = """        return False, f"Error: HTTP {response.status_code} - {response.text}"
    except requests.RequestException as e:
        return False, f"Request error: {e}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def recover_app_state(name: str = "regular_low") -> Tuple[bool, str]:
    \"\"\"Fatal-recovery for a corrupt app-state collection whose server patch chain
    is unverifiable (mismatching LTHash that resync_app_state cannot fix). Asks the
    primary device for a fresh unencrypted snapshot; the phone must be online.
    claude-ops Fix K.\"\"\"
    try:
        url = f"{WHATSAPP_API_BASE_URL}/recover_app_state"
        response = requests.post(url, json={"name": name})
        if response.status_code == 200:
            result = response.json()
            return result.get("success", False), result.get(
                "message", "Unknown response"
            )
        return False, f"Error: HTTP {response.status_code} - {response.text}"
    except requests.RequestException as e:
        return False, f"Request error: {e}"
    except Exception as e:
        return False, f"Unexpected error: {e}"


def archive_chat(chat_jid: str, archive: bool = True) -> Tuple[bool, str]:"""
MCP_HELPER_SENTINEL = "claude-ops Fix K"


# ─── main.go Fix H: idempotent chats.archived migration + SetArchived helper ──
# The chats table only has (jid, name, last_message_time). Without an `archived`
# column the ops-inbox skill can't query "inbox = non-archived" without a live
# app-state round-trip. This patch:
#   1. adds an idempotent ALTER TABLE in NewMessageStore (guarded by PRAGMA table_info)
#   2. adds a SetArchivedStatus(*sql.DB, jid, bool) helper used by Fix F
#   3. subscribes to *events.Archive inside the event handler to keep the flag current
# The archived column migration is spliced in just before `return &MessageStore{db: db}, nil`.
CHATS_SCHEMA_MIGRATION_NEEDLE = """\treturn &MessageStore{db: db}, nil
}"""

CHATS_SCHEMA_MIGRATION_REPLACEMENT = """\t// claude-ops Fix H: idempotent migration — add `archived` column if absent.
\t// Uses PRAGMA table_info so it is safe to run on every startup against an
\t// existing DB that was created before this patch (ALTER TABLE fails if the
\t// column already exists; the PRAGMA guard prevents that).
\tvar colExists int
\t_ = db.QueryRow(
\t\t`SELECT COUNT(*) FROM pragma_table_info('chats') WHERE name='archived'`,
\t).Scan(&colExists)
\tif colExists == 0 {
\t\tif _, err := db.Exec(`ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`); err != nil {
\t\t\tdb.Close()
\t\t\treturn nil, fmt.Errorf("failed to add archived column: %v", err)
\t\t}
\t}

\treturn &MessageStore{db: db}, nil
}

// SetArchivedStatus persists the WhatsApp archive flag for a chat into messages.db.
// Called by the /api/archive handler (Fix F) and the *events.Archive subscriber (Fix H).
// claude-ops Fix H.
func (store *MessageStore) SetArchivedStatus(jid string, archived bool) error {
\tarchVal := 0
\tif archived {
\t\tarchVal = 1
\t}
\t_, err := store.db.Exec(
\t\t`INSERT INTO chats (jid, archived) VALUES (?, ?)
\t\t ON CONFLICT(jid) DO UPDATE SET archived=excluded.archived`,
\t\tjid, archVal,
\t)
\treturn err
}"""

CHATS_SCHEMA_MIGRATION_SENTINEL = "claude-ops Fix H: idempotent migration"

# ─── main.go Fix H: subscribe to *events.Archive in the event handler ──────
# Keeps messages.db.chats.archived in sync when WhatsApp pushes app-state
# archive mutations from another device (phone or Web).
ARCHIVE_EVENT_NEEDLE = """\t\tcase *events.LoggedOut:
\t\t\tlogger.Warnf(\"Device logged out, re-pair via WhatsApp app\")
\t\t}
\t})"""

ARCHIVE_EVENT_REPLACEMENT = """\t\tcase *events.Archive:
\t\t\t// claude-ops Fix H: mirror app-state archive changes into messages.db so
\t\t\t// the inbox query (WHERE archived=0) stays accurate without a live
\t\t\t// app-state round-trip.
\t\t\tif err := messageStore.SetArchivedStatus(v.JID.String(), v.Action.GetArchived()); err != nil {
\t\t\t\tlogger.Warnf("Fix H: failed to persist archive status for %s: %v", v.JID, err)
\t\t\t}

\t\tcase *events.LoggedOut:
\t\t\tlogger.Warnf(\"Device logged out, re-pair via WhatsApp app\")
\t\t}
\t})"""

ARCHIVE_EVENT_SENTINEL = "claude-ops Fix H: mirror app-state archive changes"

# ─── main.go Fix G: healLTHash helper ────────────────────────────────────────
# When whatsmeow returns an error wrapping ErrMismatchingLTHash it means the
# local app-state snapshot is corrupt/stale. The only safe recovery is:
#   1. delete the stale version+MAC rows for that patch name from whatsapp.db
#      (DO NOT touch sync_keys, identity, or session tables — those force re-pair)
#   2. call FetchAppState with fullSync=true, version 0 to re-download from server
# This is injected as a standalone helper right before startRESTServer.
HEAL_LTHASH_NEEDLE = """// Start a REST API server to expose the WhatsApp client functionality
func startRESTServer(client *whatsmeow.Client, messageStore *MessageStore, port int) {"""

HEAL_LTHASH_REPLACEMENT = """// healLTHash recovers from an ErrMismatchingLTHash app-state corruption by
// deleting the stale snapshot rows for patchName from whatsapp.db and triggering
// a fresh full_sync from version 0. Returns nil when the resync succeeds or the
// error is not an LTHash mismatch (caller should not retry in that case).
//
// SAFE: only whatsmeow_app_state_version and whatsmeow_app_state_mutation_macs
// rows for the named patch are deleted. sync_keys, identity, sessions, pre_keys,
// and sender_keys are never touched — deleting those forces a re-pair.
//
// claude-ops Fix G.
func healLTHash(ctx context.Context, client *whatsmeow.Client, patchName appstate.WAPatchName) error {
\tconst maxAttempts = 2
\tfor attempt := 1; attempt <= maxAttempts; attempt++ {
\t\t// Open whatsapp.db directly to wipe the stale snapshot rows.
\t\twdb, err := sql.Open("sqlite3", "file:store/whatsapp.db?_foreign_keys=on")
\t\tif err != nil {
\t\t\treturn fmt.Errorf("healLTHash: open whatsapp.db: %w", err)
\t\t}
\t\tjid := ""
\t\tif client.Store != nil && client.Store.ID != nil {
\t\t\tjid = client.Store.ID.String()
\t\t}
\t\t_, _ = wdb.ExecContext(ctx,
\t\t\t`DELETE FROM whatsmeow_app_state_version WHERE jid=? AND name=?`, jid, string(patchName))
\t\t_, _ = wdb.ExecContext(ctx,
\t\t\t`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`, jid, string(patchName))
\t\twdb.Close()

\t\t// Re-fetch from version 0 (fullSync=true, onlyIfNotSynced=false).
\t\terr = client.FetchAppState(ctx, patchName, true, false)
\t\tif err == nil {
\t\t\treturn nil
\t\t}
\t\t// Only retry on another LTHash mismatch; any other error is permanent.
\t\tif !strings.Contains(err.Error(), "mismatching LTHash") {
\t\t\treturn err
\t\t}
\t\tif attempt < maxAttempts {
\t\t\ttime.Sleep(2 * time.Second)
\t\t}
\t}
\treturn fmt.Errorf("healLTHash: still failing after %d attempts", maxAttempts)
}

// Start a REST API server to expose the WhatsApp client functionality
func startRESTServer(client *whatsmeow.Client, messageStore *MessageStore, port int) {"""

HEAL_LTHASH_SENTINEL = "claude-ops Fix G."

# ─── main.go Fix F: POST /api/archive endpoint ───────────────────────────────
# Inserts the /api/archive handler just before the "Run server in goroutine" block.
# Uses whatsmeow appstate.BuildArchive + client.SendAppState (the correct path for
# companion-device archive mutations — not FetchAppState, which is read-only).
# On LTHash mismatch, calls healLTHash then retries once.
# Also UPSERTs the archived flag into messages.db via messageStore.SetArchivedStatus.
ARCHIVE_ENDPOINT_NEEDLE = """\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""

ARCHIVE_ENDPOINT_REPLACEMENT = """\t// claude-ops Fix F: POST /api/archive — archive or unarchive a chat.
\t// Body: {"chat_jid":"<JID>","archive":true}
\t// Uses whatsmeow's appstate.BuildArchive + client.SendAppState which is the
\t// correct companion-device path. On LTHash mismatch, auto-heals via Fix G
\t// and retries once so callers never need to manually resync first.
\thttp.HandleFunc(\"/api/archive\", func(w http.ResponseWriter, r *http.Request) {
\t\tif r.Method != http.MethodPost {
\t\t\thttp.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
\t\t\treturn
\t\t}
\t\tw.Header().Set("Content-Type", "application/json")
\t\tif !client.IsConnected() {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{"success":false,"message":"client not connected"}`)
\t\t\treturn
\t\t}
\t\tvar req struct {
\t\t\tChatJID string `json:"chat_jid"`
\t\t\tArchive bool   `json:"archive"`
\t\t}
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChatJID == "" {
\t\t\tw.WriteHeader(http.StatusBadRequest)
\t\t\tfmt.Fprintln(w, `{"success":false,"message":"chat_jid required"}`)
\t\t\treturn
\t\t}
\t\ttargetJID, err := types.ParseJID(req.ChatJID)
\t\tif err != nil {
\t\t\tw.WriteHeader(http.StatusBadRequest)
\t\t\tfmt.Fprintf(w, `{"success":false,"message":"invalid chat_jid: %s"}`, err.Error())
\t\t\treturn
\t\t}

\t\t// Look up the last message timestamp for this chat so WhatsApp clients
\t\t// display the archive state correctly in the chat list.
\t\tvar lastMsgTime time.Time
\t\t_ = messageStore.db.QueryRow(
\t\t\t`SELECT timestamp FROM messages WHERE chat_jid=? ORDER BY timestamp DESC LIMIT 1`,
\t\t\treq.ChatJID,
\t\t).Scan(&lastMsgTime)

\t\tpatch := appstate.BuildArchive(targetJID, req.Archive, lastMsgTime, nil)
\t\tctx := r.Context()

\t\tdo := func() error {
\t\t\treturn client.SendAppState(ctx, patch)
\t\t}
\t\terr = do()
\t\tif err != nil && strings.Contains(err.Error(), "mismatching LTHash") {
\t\t\t// Auto-heal the stale snapshot then retry once (Fix G).
\t\t\tif healErr := healLTHash(ctx, client, appstate.WAPatchRegularLow); healErr != nil {
\t\t\t\tw.WriteHeader(http.StatusConflict)
\t\t\t\tfmt.Fprintf(w, `{"success":false,"message":"LTHash heal failed: %s"}`, healErr.Error())
\t\t\t\treturn
\t\t\t}
\t\t\terr = do()
\t\t}
\t\tif err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{"success":false,"message":%q}`, err.Error())
\t\t\treturn
\t\t}

\t\t// Persist the flag locally so the inbox query is immediately consistent.
\t\t_ = messageStore.SetArchivedStatus(req.ChatJID, req.Archive)

\t\tfmt.Fprintf(w, `{"success":true,"message":"chat %s archived=%v"}`, req.ChatJID, req.Archive)
\t})

\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf("REST API server error: %v\\n", err)
\t\t}
\t}()
}"""

ARCHIVE_ENDPOINT_SENTINEL = "claude-ops Fix F: POST /api/archive"

# ─── main.go Fix I: preserve archived column on StoreChat ─────────────────────
# StoreChat used `INSERT OR REPLACE INTO chats (jid, name, last_message_time)`.
# REPLACE is delete+reinsert, so the `archived` column (added by Fix H) was
# silently reset to its DEFAULT (0) on every chat update — i.e. every inbound
# message un-archived the chat in messages.db, making archived chats resurface
# in the inbox. Swap to an UPSERT that updates only name + last_message_time and
# leaves `archived` (and any future columns) untouched.
STORECHAT_PRESERVE_NEEDLE = """func (store *MessageStore) StoreChat(jid, name string, lastMessageTime time.Time) error {
\t_, err := store.db.Exec(
\t\t"INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)",
\t\tjid, name, lastMessageTime,
\t)
\treturn err
}"""

STORECHAT_PRESERVE_REPLACEMENT = """func (store *MessageStore) StoreChat(jid, name string, lastMessageTime time.Time) error {
\t// claude-ops Fix I: UPSERT instead of INSERT OR REPLACE. REPLACE is
\t// delete+reinsert, which resets the `archived` column (Fix H) to its DEFAULT
\t// (0) on every chat update. ON CONFLICT(jid) DO UPDATE touches only the two
\t// columns we actually own here, preserving `archived` (and any future column).
\t_, err := store.db.Exec(
\t\t`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
\t\t ON CONFLICT(jid) DO UPDATE SET name=excluded.name, last_message_time=excluded.last_message_time`,
\t\tjid, name, lastMessageTime,
\t)
\treturn err
}"""

STORECHAT_PRESERVE_SENTINEL = "claude-ops Fix I"


def replace_idempotent(
    p: pathlib.Path, needle: str, replacement: str, sentinel: str, label: str
) -> bool:
    """Apply a single replace; return True if changed, False if already applied."""
    text = p.read_text()
    if sentinel in text:
        print(f"  [skip] {label}: already applied")
        return False
    if needle not in text:
        print(f"  [error] {label}: needle not found in {p}", file=sys.stderr)
        print(
            "          (upstream may have changed shape; patch needs refresh)",
            file=sys.stderr,
        )
        return False
    p.write_text(text.replace(needle, replacement, 1))
    print(f"  [ok]   {label}: applied")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--install-dir",
        type=pathlib.Path,
        default=REPO_DIR_DEFAULT,
        help="lharries/whatsapp-mcp install root (default: ~/.local/share/whatsapp-mcp)",
    )
    args = ap.parse_args()

    main_go = args.install_dir / "whatsapp-bridge" / "main.go"
    whatsapp_py = args.install_dir / "whatsapp-mcp-server" / "whatsapp.py"
    server_main_py = args.install_dir / "whatsapp-mcp-server" / "main.py"

    for p in (main_go, whatsapp_py, server_main_py):
        if not p.is_file():
            print(f"ERROR: expected file does not exist: {p}", file=sys.stderr)
            return 1

    print(f"Applying claude-ops patches to {args.install_dir} ...")

    changed_go = False
    print("  main.go:")
    changed_go |= replace_idempotent(
        main_go,
        PAIR_NEEDLE,
        PAIR_REPLACEMENT,
        PAIR_SENTINEL,
        "Fix A/B (PairPhone handshake + deadline)",
    )
    changed_go |= replace_idempotent(
        main_go,
        AUTO_BACKFILL_NEEDLE,
        AUTO_BACKFILL_REPLACEMENT,
        AUTO_BACKFILL_SENTINEL,
        "auto-backfill on events.Connected",
    )
    changed_go |= replace_idempotent(
        main_go,
        API_BACKFILL_NEEDLE,
        API_BACKFILL_REPLACEMENT,
        API_BACKFILL_SENTINEL,
        "POST /api/backfill endpoint",
    )
    changed_go |= replace_idempotent(
        main_go,
        SAFE_RHS_NEEDLE,
        SAFE_RHS_REPLACEMENT,
        SAFE_RHS_SENTINEL,
        "crash-safe requestHistorySync (per-chat anchor)",
    )
    changed_go |= replace_idempotent(
        main_go,
        APPSTATE_IMPORT_NEEDLE,
        APPSTATE_IMPORT_REPLACEMENT,
        APPSTATE_IMPORT_SENTINEL,
        "Fix D: add go.mau.fi/whatsmeow/appstate import",
    )
    changed_go |= replace_idempotent(
        main_go,
        OUTBOUND_SIG_NEEDLE,
        OUTBOUND_SIG_REPLACEMENT,
        OUTBOUND_SIG_SENTINEL,
        "Fix C: sendWhatsAppMessage signature (+messageStore)",
    )
    changed_go |= replace_idempotent(
        main_go,
        OUTBOUND_CALLSITE_NEEDLE,
        OUTBOUND_CALLSITE_REPLACEMENT,
        OUTBOUND_CALLSITE_SENTINEL,
        "Fix C: /api/send call site passes messageStore",
    )
    changed_go |= replace_idempotent(
        main_go,
        OUTBOUND_PERSIST_NEEDLE,
        OUTBOUND_PERSIST_REPLACEMENT,
        OUTBOUND_PERSIST_SENTINEL,
        "Fix C: persist outbound send as is_from_me=1 row",
    )
    changed_go |= replace_idempotent(
        main_go,
        CONNECTED_RESYNC_NEEDLE,
        CONNECTED_RESYNC_REPLACEMENT,
        CONNECTED_RESYNC_SENTINEL,
        "Fix I: no destructive auto-resync on Connected (recover on demand)",
    )
    changed_go |= replace_idempotent(
        main_go,
        RESYNC_ENDPOINT_NEEDLE,
        RESYNC_ENDPOINT_REPLACEMENT,
        RESYNC_ENDPOINT_SENTINEL,
        "Fix D: POST /api/resync_app_state endpoint",
    )
    # Fix I must run AFTER Fix D — it anchors on the goroutine block Fix D re-emits.
    changed_go |= replace_idempotent(
        main_go,
        RECOVER_ENDPOINT_NEEDLE,
        RECOVER_ENDPOINT_REPLACEMENT,
        RECOVER_ENDPOINT_SENTINEL,
        "Fix I: POST /api/recover_app_state endpoint (LTHash fatal recovery)",
    )
    changed_go |= replace_idempotent(
        main_go,
        CHATS_SCHEMA_MIGRATION_NEEDLE,
        CHATS_SCHEMA_MIGRATION_REPLACEMENT,
        CHATS_SCHEMA_MIGRATION_SENTINEL,
        "Fix H: chats.archived column migration + SetArchivedStatus helper",
    )
    changed_go |= replace_idempotent(
        main_go,
        ARCHIVE_EVENT_NEEDLE,
        ARCHIVE_EVENT_REPLACEMENT,
        ARCHIVE_EVENT_SENTINEL,
        "Fix H: subscribe *events.Archive to persist archive flag",
    )
    changed_go |= replace_idempotent(
        main_go,
        STORECHAT_PRESERVE_NEEDLE,
        STORECHAT_PRESERVE_REPLACEMENT,
        STORECHAT_PRESERVE_SENTINEL,
        "Fix I: StoreChat UPSERT preserves archived column",
    )
    changed_go |= replace_idempotent(
        main_go,
        HEAL_LTHASH_NEEDLE,
        HEAL_LTHASH_REPLACEMENT,
        HEAL_LTHASH_SENTINEL,
        "Fix G: healLTHash auto-recovery helper",
    )
    changed_go |= replace_idempotent(
        main_go,
        ARCHIVE_ENDPOINT_NEEDLE,
        ARCHIVE_ENDPOINT_REPLACEMENT,
        ARCHIVE_ENDPOINT_SENTINEL,
        "Fix F: POST /api/archive endpoint",
    )

    print("  whatsapp.py:")
    changed_py = replace_idempotent(
        whatsapp_py,
        PY_PATH_NEEDLE,
        PY_PATH_REPLACEMENT,
        PY_PATH_SENTINEL,
        "LID resolver + whatsmeow_contacts lookup",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_SHAPE_NEEDLE,
        PY_SHAPE_REPLACEMENT,
        PY_SHAPE_SENTINEL,
        "Fix E: WAL _open_db + dict serialisation helpers",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_CHAT_DATACLASS_NEEDLE,
        PY_CHAT_DATACLASS_REPLACEMENT,
        PY_CHAT_DATACLASS_SENTINEL,
        "Fix J: Chat dataclass archived field",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_CHAT_TO_DICT_NEEDLE,
        PY_CHAT_TO_DICT_REPLACEMENT,
        PY_CHAT_TO_DICT_SENTINEL,
        "Fix J: _chat_to_dict archived key",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_LIST_CHATS_SELECT_NEEDLE,
        PY_LIST_CHATS_SELECT_REPLACEMENT,
        PY_LIST_CHATS_SELECT_SENTINEL,
        "Fix J: list_chats SELECT chats.archived",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_LIST_CHATS_SIG_NEEDLE,
        PY_LIST_CHATS_SIG_REPLACEMENT,
        PY_LIST_CHATS_SIG_SENTINEL,
        "Fix J: list_chats include_archived param",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_LIST_CHATS_WHERE_NEEDLE,
        PY_LIST_CHATS_WHERE_REPLACEMENT,
        PY_LIST_CHATS_WHERE_SENTINEL,
        "Fix J: list_chats archived WHERE filter",
    )
    changed_py |= replace_idempotent(
        whatsapp_py,
        PY_LIST_CHATS_ROW_NEEDLE,
        PY_LIST_CHATS_ROW_REPLACEMENT,
        PY_LIST_CHATS_ROW_SENTINEL,
        "Fix J: list_chats row→Chat archived mapping",
    )
    # Fix K: recover_app_state bridge-call helper (whatsapp.py)
    changed_py |= replace_idempotent(
        whatsapp_py,
        MCP_HELPER_NEEDLE,
        MCP_HELPER_REPLACEMENT,
        MCP_HELPER_SENTINEL,
        "Fix K: recover_app_state helper (whatsapp.py)",
    )

    changed_server_main = False
    print("  whatsapp-mcp-server/main.py:")
    # Fix K: recover_app_state MCP tool (import alias + @mcp.tool wrapper)
    changed_server_main |= replace_idempotent(
        server_main_py,
        MCP_IMPORT_NEEDLE,
        MCP_IMPORT_REPLACEMENT,
        MCP_IMPORT_SENTINEL,
        "Fix K: recover_app_state import alias (main.py)",
    )
    changed_server_main |= replace_idempotent(
        server_main_py,
        MCP_TOOL_NEEDLE,
        MCP_TOOL_REPLACEMENT,
        MCP_TOOL_SENTINEL,
        "Fix K: recover_app_state MCP tool (main.py)",
    )
    changed_py = changed_py or changed_server_main

    if changed_go:
        print("  main.go changed — caller should `go build` the bridge")
    if changed_py:
        print(
            "  whatsapp.py changed — restart the MCP server (mcp-proxy.service) to load"
        )
    if not (changed_go or changed_py):
        print("All patches already applied; nothing to do.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
