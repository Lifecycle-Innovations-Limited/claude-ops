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
  Fix K — recover_app_state MCP tool: wires the /api/recover_app_state bridge
          endpoint into the Python MCP server (whatsapp.py helper + main.py
          import alias + @mcp.tool()) so mcp__whatsapp__recover_app_state exists.
  Fix L — phone-online prerequisite + auto-retry + backfill-on-alive: adds the
          phoneOnline() gate (IsConnected && IsLoggedIn) to /api/recover_app_state
          and /api/archive so they fail fast instead of returning a misleading
          success when the link is down; adds sendRecoveryAndBackfill() (recovery
          peer-message + history backfill while alive); and escalates /api/archive
          on a server 409 "conflict" (not just local LTHash mismatch) to a
          recovery + bounded auto-retry so callers never need a manual recover->retry.
  Fix O — HistorySync -> chats.archived authoritative projection: the regular_low
          app-state (archive/pin/mute) is chronically LTHash-corrupt on many accounts
          (whatsmeow #382/#518/#858), so neither the live *events.Archive subscriber
          (Fix H) nor /api/archive can keep chats.archived in step with the phone, and
          the inbox view silently drifts (archived chats hidden / un-archived chats not
          resurfacing). Fix O reads the authoritative per-conversation Archived flag out
          of the HistorySync payload — a channel that bypasses the broken app-state — and
          projects it onto chats.archived. On a FULL/INITIAL_BOOTSTRAP sync (what a
          re-pair delivers) the conversation list is complete, so the column is reset and
          re-marked exactly to the phone's archived set. This is what makes ops-inbox see
          the full + current inbox on every run without depending on regular_low.

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

# ─── main.go: phone-number pairing path (Fix A + Fix B) ──────────────────────
# API DRIFT PORT (2026-06): upstream lharries/whatsapp-mcp switched its login path
# to QR-code ONLY — there is no PairPhone call to anchor on anymore (the old
# PAIR_NEEDLE referenced a `// No ID stored — pairing-code mode (PairPhone)` block
# that no longer exists). However the pinned whatsmeow
# (v0.0.0-20250318233852-06705625cf82) STILL exports Client.PairPhone, so per the
# task's "prefer phone-pair when supported" we RE-INTRODUCE the phone-number
# pairing path into upstream's QR-only block rather than dropping the behaviour.
#
# Two further drifts handled here vs. the old fix:
#   • PairPhone lost its leading context.Context parameter. Current signature is
#       PairPhone(phone string, showPushNotification bool, clientType PairClientType,
#                 clientDisplayName string) (string, error)
#     so Fix B can no longer pass a context deadline INTO the call. We preserve Fix
#     B's INTENT (PairPhone must not hang forever) by running it in a goroutine and
#     racing it against a 3-minute watchdog timer — equivalent bounding without the
#     removed ctx arg.
#   • The needle now matches upstream's real QR-only block (GetQRChannel + the QR
#     print loop). When WA_PHONE is set we take the pairing-code path; otherwise we
#     fall through to upstream's QR loop unchanged.
PAIR_NEEDLE = """\tif client.Store.ID == nil {
\t\t// No ID stored, this is a new client, need to pair with phone
\t\tqrChan, _ := client.GetQRChannel(context.Background())
\t\terr = client.Connect()
\t\tif err != nil {
\t\t\tlogger.Errorf(\"Failed to connect: %v\", err)
\t\t\treturn
\t\t}

\t\t// Print QR code for pairing with phone
\t\tfor evt := range qrChan {
\t\t\tif evt.Event == \"code\" {
\t\t\t\tfmt.Println(\"\\nScan this QR code with your WhatsApp app:\")
\t\t\t\tqrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
\t\t\t} else if evt.Event == \"success\" {
\t\t\t\tconnected <- true
\t\t\t\tbreak
\t\t\t}
\t\t}"""

PAIR_REPLACEMENT = """\tif client.Store.ID == nil {
\t\t// No ID stored, this is a new client, need to pair with phone.
\t\t// claude-ops Fix A/B: when WA_PHONE is set, prefer phone-number (pairing-code)
\t\t// linking over QR — the bridge runs headless on EC2 where nobody can scan a QR.
\t\t// We still open the QR channel first because whatsmeow requires it (and the
\t\t// godoc says to wait for the first QR event before calling PairPhone).
\t\tqrChan, _ := client.GetQRChannel(context.Background())
\t\terr = client.Connect()
\t\tif err != nil {
\t\t\tlogger.Errorf(\"Failed to connect: %v\", err)
\t\t\treturn
\t\t}

\t\tphone := os.Getenv(\"WA_PHONE\")
\t\tif phone != \"\" {
\t\t\t// claude-ops Fix A: per whatsmeow PairPhone godoc — wait for the
\t\t\t// websocket+noise handshake to complete before requesting a pair code,
\t\t\t// otherwise PairPhone silently hangs on the IQ response (no PairSuccess,
\t\t\t// no error). Sleeping ~3s after Connect is the godoc-endorsed gate.
\t\t\ttime.Sleep(3 * time.Second)
\t\t\t// claude-ops Fix B: wrap PairPhone with a 3-min context deadline.
\t\t\t// PairPhone now takes context as first parameter.
\t\t\ttype pairResult struct {
\t\t\t\tcode string
\t\t\t\terr  error
\t\t\t}
\t\t\tpairCh := make(chan pairResult, 1)
\t\t\tgo func() {
\t\t\t\tpairCtx, pairCancel := context.WithTimeout(context.Background(), 3*time.Minute)\n\t\t\t\tdefer pairCancel()\n\t\t\t\tc, perr := client.PairPhone(pairCtx, phone, true, whatsmeow.PairClientChrome, \"Chrome (Linux)\")
\t\t\t\tpairCh <- pairResult{code: c, err: perr}
\t\t\t}()
\t\t\tselect {
\t\t\tcase pr := <-pairCh:
\t\t\t\tif pr.err != nil {
\t\t\t\t\tlogger.Errorf(\"Failed to pair phone %s: %v\", phone, pr.err)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tfmt.Printf(\"\\nEnter this pairing code in WhatsApp on %s: %s\\n\", phone, pr.code)
\t\t\tcase <-time.After(3 * time.Minute):
\t\t\t\tlogger.Errorf(\"Timeout requesting pairing code for %s\", phone)
\t\t\t\treturn
\t\t\t}
\t\t\t// Drain the QR channel so the goroutine inside whatsmeow doesn't block;
\t\t\t// the *events.PairSuccess that lands when the user enters the code drives
\t\t\t// the Connected handler. We still watch for the success event below.
\t\t\tgo func() {
\t\t\t\tfor evt := range qrChan {
\t\t\t\t\tif evt.Event == \"success\" {
\t\t\t\t\t\tconnected <- true
\t\t\t\t\t\treturn
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}()
\t\t} else {
\t\t\t// No WA_PHONE — fall back to upstream's QR pairing loop unchanged.
\t\t\tfor evt := range qrChan {
\t\t\t\tif evt.Event == \"code\" {
\t\t\t\t\tfmt.Println(\"\\nScan this QR code with your WhatsApp app:\")
\t\t\t\t\tqrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
\t\t\t\t} else if evt.Event == \"success\" {
\t\t\t\t\tconnected <- true
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t}
\t\t}"""

PAIR_SENTINEL = "claude-ops Fix A/B: when WA_PHONE is set"

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
\t\t\t\tif err := client.FetchAppState(context.Background(), appstate.WAPatchName(req.Name), req.FullSync, false); err != nil {
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
\t\t// claude-ops Fix L: phone-online prerequisite. A recovery peer-message only
\t\t// reaches the primary device if the bridge has a live, authenticated link;
\t\t// otherwise it silently goes nowhere and the caller is misled by success:true.
\t\tif !phoneOnline(client) {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{\"success\":false,\"message\":\"phone offline: bridge not connected/logged in — reconnect the phone, then retry recover\"}`)
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
\t\t// claude-ops Fix L: dispatch recovery AND fire a history backfill while alive.
\t\tif err := sendRecoveryAndBackfill(client, appstate.WAPatchName(req.Name)); err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":%q}`, err.Error())
\t\t\treturn
\t\t}
\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"recovery + backfill dispatched for %s (phone online) — snapshot auto-applies in a few seconds, then archive works\"}`, req.Name)
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
# claude-ops Fix E: re-anchored to the `get_sender_name` def alone (was a
# 6-line MessageContext block that depended on upstream's exact blank-line
# count between the dataclass and the def — upstream collapsed two blanks to
# one and broke the splice). Anchoring on the function signature and PREPENDING
# the helper block drops the adjacency/blank-line dependency entirely while
# inserting byte-identical content. Idempotent via PY_SHAPE_SENTINEL.
PY_SHAPE_NEEDLE = """def get_sender_name(sender_jid: str) -> str:"""

PY_SHAPE_REPLACEMENT = """# claude-ops Fix E: serialization helpers + WAL-mode DB open.
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

# Sentinel keys on the inserted helper's defining line (`def _open_db(`) rather
# than the comment text. The live install was hand/older-patcher-patched with a
# differently-worded Fix E comment but the SAME _open_db helper; keying on the
# comment string would miss it and DUPLICATE the helper. `def _open_db(` is the
# stable invariant present in any Fix-E-patched tree (matches the def with or
# without a return-type annotation).
PY_SHAPE_SENTINEL = "def _open_db("


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
# claude-ops Fix J SELECT: re-anchored to the last SELECT column + `FROM chats`
# (was the whole 7-line SELECT block, which broke on a trailing space after the
# `SELECT` keyword in current upstream). `...last_is_from_me\n            FROM chats`
# is unique to list_chats (the `is_from_me as last_is_from_me` token alone is not).
# Appends `chats.archived` as the final column — byte-identical effect.
PY_LIST_CHATS_SELECT_NEEDLE = """                messages.is_from_me as last_is_from_me
            FROM chats"""

PY_LIST_CHATS_SELECT_REPLACEMENT = """                messages.is_from_me as last_is_from_me,
                chats.archived
            FROM chats"""

PY_LIST_CHATS_SELECT_SENTINEL = "chats.archived\n            FROM chats"

# --- 4. list_chats signature + archived WHERE filter ---
# claude-ops Fix J sig: re-anchored to the last param + `) -> List[Chat]:` (was
# the full def + body preamble, which broke because upstream's last param has no
# trailing comma — `sort_by: str = "last_active"` not `...,` — and the blank-line
# whitespace between `cursor()` and `# Build base query` differs). This 2-line
# anchor is unique and inserts `include_archived` as a new keyword arg, replacing
# the no-comma last param with comma + new param. Byte-identical signature effect.
PY_LIST_CHATS_SIG_NEEDLE = """    sort_by: str = "last_active"
) -> List[Chat]:"""

PY_LIST_CHATS_SIG_REPLACEMENT = """    sort_by: str = "last_active",
    include_archived: bool = False,  # claude-ops Fix J: exclude archived by default
) -> List[Chat]:"""

PY_LIST_CHATS_SIG_SENTINEL = "claude-ops Fix J: exclude archived by default"

# --- 5. list_chats WHERE: inject archived=0 filter ---
# claude-ops Fix J WHERE: re-anchored to `where_clauses = []` + the unique
# list_chats `chats.name LIKE` query clause (the prior needle reproduced the
# blank-line whitespace between `where_clauses = []` and `if query:`, which
# upstream emits with trailing spaces). `where_clauses = []`/`params = []` also
# appears in list_messages, so the anchor INCLUDES the chats.name LIKE append —
# unique to list_chats — and INjects the archived filter right after the list
# initialisers. `replace(..., 1)` + this list_chats-only token = correct target.
PY_LIST_CHATS_WHERE_NEEDLE = (
    "        where_clauses = []\n"
    "        params = []\n"
    "        \n"
    "        if query:\n"
    '            where_clauses.append("(LOWER(chats.name) LIKE LOWER(?) OR chats.jid LIKE ?)")'
)

PY_LIST_CHATS_WHERE_REPLACEMENT = (
    "        where_clauses = []\n"
    "        params = []\n"
    "\n"
    "        # claude-ops Fix J: filter archived unless caller opts in\n"
    "        if not include_archived:\n"
    '            where_clauses.append("chats.archived = 0")\n'
    "        \n"
    "        if query:\n"
    '            where_clauses.append("(LOWER(chats.name) LIKE LOWER(?) OR chats.jid LIKE ?)")'
)

PY_LIST_CHATS_WHERE_SENTINEL = "claude-ops Fix J: filter archived unless caller opts in"

# --- 6. list_chats row mapping: read chat_data[6] as archived ---
# claude-ops Fix J row-mapping: re-anchored to the list_chats `cursor.execute(
# " ".join(query_parts), ...)` + fetchall preamble that precedes the Chat()
# construction. The Chat() block itself is byte-identical to the one in
# get_contact_chats, so the bare constructor is NOT a unique anchor (replace(...,1)
# would hit whichever appears first). The `" ".join(query_parts)` execute call is
# unique to list_chats. Upstream also reflowed last_message_time onto one line and
# dropped the trailing comma on the last arg — both folded into this anchor.
# Built with explicit "\\n" joins so the blank line between fetchall() and
# `result = []` carries upstream's exact 8-space indentation (`        `) — an
# editor would silently strip it, re-breaking the anchor.
PY_LIST_CHATS_ROW_NEEDLE = (
    '        cursor.execute(" ".join(query_parts), tuple(params))\n'
    "        chats = cursor.fetchall()\n"
    "        \n"
    "        result = []\n"
    "        for chat_data in chats:\n"
    "            chat = Chat(\n"
    "                jid=chat_data[0],\n"
    "                name=chat_data[1],\n"
    "                last_message_time=datetime.fromisoformat(chat_data[2]) if chat_data[2] else None,\n"
    "                last_message=chat_data[3],\n"
    "                last_sender=chat_data[4],\n"
    "                last_is_from_me=chat_data[5]\n"
    "            )"
)

PY_LIST_CHATS_ROW_REPLACEMENT = (
    '        cursor.execute(" ".join(query_parts), tuple(params))\n'
    "        chats = cursor.fetchall()\n"
    "        \n"
    "        result = []\n"
    "        for chat_data in chats:\n"
    "            chat = Chat(\n"
    "                jid=chat_data[0],\n"
    "                name=chat_data[1],\n"
    "                last_message_time=datetime.fromisoformat(chat_data[2]) if chat_data[2] else None,\n"
    "                last_message=chat_data[3],\n"
    "                last_sender=chat_data[4],\n"
    "                last_is_from_me=chat_data[5],\n"
    "                archived=bool(chat_data[6]) if len(chat_data) > 6 else False,  # claude-ops Fix J\n"
    "            )"
)

# Sentinel keys on the inserted kwarg `archived=bool(chat_data[6])` rather than the
# full one-line expression: the live install carries the SAME mapping but black
# reflowed it across three lines, so matching the one-liner would miss it and the
# splice would report a spurious needle-not-found (harmless — replace fails clean —
# but noisy). The bare kwarg is the stable invariant of the inserted content.
PY_LIST_CHATS_ROW_SENTINEL = "archived=bool(chat_data[6])"


# ─── Fix K: wire /api/recover_app_state into the MCP server ───────────────────
# The bridge exposes POST /api/recover_app_state (Fix I) but upstream's MCP server
# only had resync_app_state. These three patches add the recover_app_state MCP tool
# (whatsapp-mcp-server/main.py import + @mcp.tool wrapper) and its bridge-call helper
# (whatsapp-mcp-server/whatsapp.py), so the fatal-recovery path is reachable as
# mcp__whatsapp__recover_app_state, not just via raw curl.
# Anchors on the resync alias line that Fix M installs (note the trailing Fix M
# comment — Fix M always runs first, so this is the line actually present).
MCP_IMPORT_NEEDLE = """    resync_app_state as whatsapp_resync_app_state,  # claude-ops Fix M
)"""
MCP_IMPORT_REPLACEMENT = """    resync_app_state as whatsapp_resync_app_state,  # claude-ops Fix M
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
# claude-ops Fix H subscriber: re-anchored to `case *events.LoggedOut:` alone.
# The previous needle also pinned the LoggedOut log string ("Device logged out,
# re-pair via WhatsApp app"), which upstream changed to "...please scan QR code
# to log in again", breaking the splice. The bare `case *events.LoggedOut:` line
# is stable, and PREPENDING the *events.Archive case before it inserts the same
# byte-identical subscriber. `v` is bound by `switch v := evt.(type)` upstream.
# Idempotent via ARCHIVE_EVENT_SENTINEL.
ARCHIVE_EVENT_NEEDLE = """\t\tcase *events.LoggedOut:"""

ARCHIVE_EVENT_REPLACEMENT = """\t\tcase *events.Archive:
\t\t\t// claude-ops Fix H: mirror app-state archive changes into messages.db so
\t\t\t// the inbox query (WHERE archived=0) stays accurate without a live
\t\t\t// app-state round-trip.
\t\t\tif err := messageStore.SetArchivedStatus(v.JID.String(), v.Action.GetArchived()); err != nil {
\t\t\t\tlogger.Warnf("Fix H: failed to persist archive status for %s: %v", v.JID, err)
\t\t\t}

\t\tcase *events.LoggedOut:"""

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
\t\t\t\terr = client.FetchAppState(ctx, patchName, true, false)
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

// claude-ops Fix L: phoneOnline reports whether the bridge has a live, authenticated
// link to WhatsApp — the prerequisite for any app-state mutation (archive) or recovery
// peer-message to actually reach the primary device. whatsmeow exposes no direct
// "is my phone awake" signal, so this is the strongest reliable gate: IsConnected
// (websocket up) AND IsLoggedIn (device paired). Without it, recover_app_state would
// return success:true while the peer-message goes nowhere and a later archive 409s.
func phoneOnline(client *whatsmeow.Client) bool {
\treturn client.IsConnected() && client.IsLoggedIn()
}

// claude-ops Fix L: sendRecoveryAndBackfill recovers a corrupt app-state collection
// and fires a history backfill while the link is alive.
//
// API-DRIFT DEGRADE (2026-06): the original implementation asked the PRIMARY device
// for a fresh unencrypted snapshot via whatsmeow.BuildAppStateRecoveryRequest ->
// client.SendPeerMessage, which BYPASSED a broken server patch chain (mismatching
// LTHash, whatsmeow #382/#858). BOTH of those APIs were REMOVED from the public
// whatsmeow surface in the pinned version (v0.0.0-20250318233852-06705625cf82):
// BuildAppStateRecoveryRequest no longer exists, and SendPeerMessage is now only an
// unexported method reachable via client.DangerousInternals(). There is no
// supported public replacement for primary-device peer-recovery in this version.
//
// Closest correct equivalent without reaching into Dangerous internals: a full
// server-side resync (FetchAppState fullSync=true), i.e. the same primitive
// healLTHash already uses. IMPORTANT BEHAVIOUR CHANGE: this can re-fetch and
// re-apply the server's patch chain, but it CANNOT bypass a server chain that is
// itself unverifiable — so a truly fatal #382/#858 corruption is no longer
// auto-recoverable from the bridge on this whatsmeow version. We log that loudly,
// attempt the resync as a best effort, and still fire the backfill. Documented in
// the PR body + CHANGELOG so the owner can decide whether to pin a whatsmeow that
// still exposes peer-recovery or accept resync-only semantics.
func sendRecoveryAndBackfill(client *whatsmeow.Client, patchName appstate.WAPatchName) error {
\tfmt.Printf(
\t\t"Fix L: primary-device app-state recovery (peer-message) is unavailable on this "+
\t\t\t"whatsmeow version; falling back to a best-effort full server resync of %s "+
\t\t\t"(cannot bypass an unverifiable server patch chain — see whatsmeow #382/#858)\\n",
\t\tstring(patchName),
\t)
\t// Best-effort full server-side resync. Errors are non-fatal here — the caller
\t// (archive auto-retry / recover endpoint) reports its own outcome.
\tif err := client.FetchAppState(context.Background(), patchName, true, false); err != nil {
\t\tfmt.Printf("Fix L: best-effort resync of %s failed: %v\\n", string(patchName), err)
\t\treturn err
\t}
\tgo requestHistorySync(client) // backfill on alive — refresh history while the link is up
\treturn nil
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
\t\t// claude-ops Fix L: phone-online prerequisite for the app-state mutation.
\t\tif !phoneOnline(client) {
\t\t\tw.WriteHeader(http.StatusServiceUnavailable)
\t\t\tfmt.Fprintln(w, `{"success":false,"message":"phone offline: bridge not connected/logged in — reconnect the phone, then retry archive"}`)
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
\t\t\t\t\t\treturn client.SendAppState(ctx, patch)
\t\t}
\t\terr = do()
\t\t// claude-ops Fix L: treat both a local LTHash mismatch and a server-side 409
\t\t// "conflict" (a churned/diverged regular_low version) as auto-recoverable.
\t\tneedsHeal := func(e error) bool {
\t\t\tif e == nil {
\t\t\t\treturn false
\t\t\t}
\t\t\ts := e.Error()
\t\t\treturn strings.Contains(s, "mismatching LTHash") ||
\t\t\t\tstrings.Contains(s, "conflict") ||
\t\t\t\tstrings.Contains(s, "code=\\"409\\"")
\t\t}
\t\tif needsHeal(err) {
\t\t\t// Auto-heal the stale local snapshot then retry once (Fix G).
\t\t\tif healErr := healLTHash(ctx, client, appstate.WAPatchRegularLow); healErr != nil {
\t\t\t\t// claude-ops Fix L: local heal failed → the SERVER patch chain is
\t\t\t\t// unverifiable. Escalate to a primary-device recovery (peer-message)
\t\t\t\t// + backfill, then auto-retry the archive with bounded backoff while
\t\t\t\t// the phone's fresh snapshot lands. No manual recover->retry needed.
\t\t\t\tif recErr := sendRecoveryAndBackfill(client, appstate.WAPatchRegularLow); recErr != nil {
\t\t\t\t\tw.WriteHeader(http.StatusConflict)
\t\t\t\t\tfmt.Fprintf(w, `{"success":false,"message":"LTHash heal failed and recovery dispatch failed: %s"}`, recErr.Error())
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tfor attempt := 1; attempt <= 4; attempt++ {
\t\t\t\t\ttime.Sleep(time.Duration(attempt*2) * time.Second)
\t\t\t\t\tif err = do(); err == nil {
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tif err != nil {
\t\t\t\t\tw.WriteHeader(http.StatusConflict)
\t\t\t\t\tfmt.Fprintf(w, `{"success":false,"message":"recovery dispatched but snapshot not yet applied (phone may be slow/offline) — retry archive shortly: %s"}`, err.Error())
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t} else {
\t\t\t\terr = do()
\t\t\t}
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


# ─── Fix M: self-contained archive_chat + resync_app_state MCP surface ────────
# WHY: Fix F adds the bridge's POST /api/archive endpoint (which heals an
# ErrMismatchingLTHash / 409 corruption internally via Fix G, then UPSERTs
# chats.archived), and Fix K wires recover_app_state into the MCP server. But the
# MCP-side archive_chat + resync_app_state helpers/tools were assumed to already
# exist in upstream (the Fix K splices anchor on them). Current upstream
# lharries/whatsapp-mcp ships NEITHER, so a fresh `git clone` + apply-patches
# leaves the MCP server with no archive_chat tool at all — archiving only works
# via raw curl to :8080. Fix M makes the whole surface self-installing: it appends
# the REST-routed helpers to whatsapp.py and the import aliases + @mcp.tool
# wrappers to main.py, so mcp__whatsapp__archive_chat always routes through the
# healing /api/archive endpoint (never the raw app-state mutation that 409s on
# corrupt regular_low patch chains — whatsmeow #382/#858). Idempotent via sentinel.
#
# These run BEFORE the Fix K splices in main(), guaranteeing archive_chat /
# resync_app_state exist for Fix K's recover_app_state anchors even on pristine
# upstream. On an already-patched tree the sentinels short-circuit (no dup defs).
# Sentinel keys on the helper *existing at all* (def present), not on a Fix-M
# marker — so this is a no-op on ANY tree that already has archive_chat, whether
# patched by Fix M (fresh upstream) or by the pre-Fix-M hand-patch path (live
# install). Without this, a rerun on an already-patched live tree would append a
# DUPLICATE archive_chat/resync_app_state (the installer promises rerun-safe).
MCP_ARCHIVE_HELPER_SENTINEL = (
    "def archive_chat(chat_jid: str, archive: bool = True) -> Tuple[bool, str]:"
)
MCP_ARCHIVE_HELPER_BLOCK = '''

def resync_app_state(
    name: str = "regular_low", full_sync: bool = True
) -> Tuple[bool, str]:
    """Force a full resync of an app-state patch type via the bridge REST API.
    Use when archive/mute/pin operations fail with an LTHash mismatch (server/local
    app-state desync). claude-ops Fix M: resync_app_state helper."""
    try:
        url = f"{WHATSAPP_API_BASE_URL}/resync_app_state"
        response = requests.post(url, json={"name": name, "full_sync": full_sync})
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


def archive_chat(chat_jid: str, archive: bool = True) -> Tuple[bool, str]:
    """Archive or unarchive a WhatsApp chat via the bridge's healing REST endpoint.

    Routes through POST /api/archive (NOT a raw whatsmeow app-state mutation). The
    bridge handler auto-heals an ErrMismatchingLTHash / HTTP 409 corruption of the
    regular_low patch chain (claude-ops Fix G — resync/recover-then-retry) and then
    UPSERTs chats.archived in store/messages.db, so this works even when the raw
    app-state path would 409 (whatsmeow #382/#858). Unarchive (archive=False) takes
    the same healed path. claude-ops Fix M: archive_chat helper."""
    try:
        if not chat_jid:
            return False, "chat_jid must be provided"
        url = f"{WHATSAPP_API_BASE_URL}/archive"
        response = requests.post(url, json={"chat_jid": chat_jid, "archive": archive})
        if response.status_code == 200:
            result = response.json()
            return result.get("success", False), result.get(
                "message", "Unknown response"
            )
        return False, f"Error: HTTP {response.status_code} - {response.text}"
    except requests.RequestException as e:
        return False, f"Request error: {e}"
    except json.JSONDecodeError:
        return False, f"Error parsing response: {response.text}"
    except Exception as e:
        return False, f"Unexpected error: {e}"
'''

# main.py import-alias splice. Anchors on the upstream import block's final entry
# (download_media), which is stable across upstream revisions. Adds archive_chat +
# resync_app_state aliases (recover_app_state stays Fix K's job, slotted after).
MCP_ARCHIVE_IMPORT_NEEDLE = """    download_media as whatsapp_download_media
)"""
MCP_ARCHIVE_IMPORT_REPLACEMENT = """    download_media as whatsapp_download_media,
    archive_chat as whatsapp_archive_chat,  # claude-ops Fix M
    resync_app_state as whatsapp_resync_app_state,  # claude-ops Fix M
)"""
# Keys on the import alias existing (either path adds it, with or without the Fix M
# comment) so it no-ops on the live already-patched tree as well as a Fix-M one.
MCP_ARCHIVE_IMPORT_SENTINEL = "archive_chat as whatsapp_archive_chat"

# main.py @mcp.tool wrappers, spliced in just before the trailing __main__ guard so
# that guard stays last. FastMCP registers tools on import.
# Keys on the archive_chat @mcp.tool def existing (Dict return = the tool wrapper,
# distinct from the Tuple-returning helper in whatsapp.py) so it no-ops on any tree
# that already exposes the tool — fresh Fix-M or live hand-patched — never dup.
MCP_ARCHIVE_TOOLS_SENTINEL = (
    "def archive_chat(chat_jid: str, archive: bool = True) -> Dict[str, Any]:"
)
MCP_ARCHIVE_TOOLS_NEEDLE = """if __name__ == "__main__":
    # Initialize and run the server
    mcp.run(transport='stdio')"""
MCP_ARCHIVE_TOOLS_REPLACEMENT = '''@mcp.tool()
def resync_app_state(name: str = "regular_low", full_sync: bool = True) -> Dict[str, Any]:
    """Force a full WhatsApp app-state resync (claude-ops Fix M).

    Use when archive_chat / mute / pin fail with a "mismatching LTHash" / 409
    conflict (server/local app-state desync). Routes through the bridge's
    /api/resync_app_state endpoint. If resync alone does not clear the conflict,
    use recover_app_state (fatal recovery via the primary device).

    Args:
        name: Patch name. One of: regular_low (default, holds archive/mute/pin),
              regular, critical_block, critical_unblock_low.
        full_sync: When True (default) request a full resync from version 0.
    """
    success, message = whatsapp_resync_app_state(name, full_sync)
    return {"success": success, "message": message}


@mcp.tool()
def archive_chat(chat_jid: str, archive: bool = True) -> Dict[str, Any]:
    """Archive or unarchive a WhatsApp chat (claude-ops Fix M: archive_chat tool).

    Archiving hides the chat from the main list (and unpins it); it does not delete
    messages or affect delivery — the chat returns when a new message arrives or on
    unarchive. Routes through the bridge's healing POST /api/archive endpoint, which
    auto-recovers from an ErrMismatchingLTHash / 409 corruption of the regular_low
    patch chain (whatsmeow #382/#858) and persists chats.archived in messages.db, so
    this succeeds where the raw whatsmeow app-state mutation would 409.

    Args:
        chat_jid: The chat JID (e.g. "123@s.whatsapp.net" or "123@g.us").
        archive: True to archive (default), False to unarchive (same healed path).
    """
    success, message = whatsapp_archive_chat(chat_jid, archive)
    return {"success": success, "message": message}


if __name__ == "__main__":
    # Initialize and run the server
    mcp.run(transport='stdio')'''


# ─── main.go Fix N: ctx-drift — add context.Background() to upstream call sites ─
# whatsmeow added context.Context parameters to sqlstore.New, GetFirstDevice,
# GetGroupInfo, and GetContact. These are pristine upstream call sites not covered
# by any other fix replacement block; patch them with targeted single-line swaps.

CTX_SQLSTORE_NEEDLE = '\tcontainer, err := sqlstore.New("sqlite3", "file:store/whatsapp.db?_foreign_keys=on", dbLog)\n'
CTX_SQLSTORE_REPLACEMENT = '\tcontainer, err := sqlstore.New(context.Background(), "sqlite3", "file:store/whatsapp.db?_foreign_keys=on", dbLog)\n'
CTX_SQLSTORE_SENTINEL = "sqlstore.New(context.Background(),"

CTX_GETFIRSTDEVICE_NEEDLE = "\tdeviceStore, err := container.GetFirstDevice()\n"
CTX_GETFIRSTDEVICE_REPLACEMENT = (
    "\tdeviceStore, err := container.GetFirstDevice(context.Background())\n"
)
CTX_GETFIRSTDEVICE_SENTINEL = "container.GetFirstDevice(context.Background())"

CTX_GETGROUPINFO_NEEDLE = "\t\t\tgroupInfo, err := client.GetGroupInfo(jid)\n"
CTX_GETGROUPINFO_REPLACEMENT = (
    "\t\t\tgroupInfo, err := client.GetGroupInfo(context.Background(), jid)\n"
)
CTX_GETGROUPINFO_SENTINEL = "client.GetGroupInfo(context.Background(),"

CTX_GETCONTACT_NEEDLE = "\t\tcontact, err := client.Store.Contacts.GetContact(jid)\n"
CTX_GETCONTACT_REPLACEMENT = (
    "\t\tcontact, err := client.Store.Contacts.GetContact(context.Background(), jid)\n"
)
CTX_GETCONTACT_SENTINEL = "client.Store.Contacts.GetContact(context.Background(),"


# ─── main.go Fix M: media-retry fallback on 403/404/410 ──────────────────────
# WhatsApp returns HTTP 403/404/410 when a media's directPath has gone stale
# server-side. whatsmeow treats those as terminal, so larger media silently
# drops. The documented recovery is SendMediaRetryReceipt: ask the sender's phone
# to re-upload, yielding a FRESH directPath. Four hunks, each anchored on UPSTREAM
# code so they apply on a pristine lharries/whatsapp-mcp clone:
#   M1: imports — add "sync" (retry registry mutex)
#   M2: imports — add waMmsRetry proto (decrypt the retry notification result)
#   M3: insert the media-retry registry + downloadWithRetry() before downloadMedia()
#   M4: route the download through downloadWithRetry()
#   M5: deliver *events.MediaRetry to the blocked downloader

# M1 — "sync" import (anchor on the pristine "strings" import line).
MEDIA_RETRY_SYNC_IMPORT_NEEDLE = '\t"strings"\n\t"syscall"\n'
MEDIA_RETRY_SYNC_IMPORT_REPLACEMENT = '\t"strings"\n\t"sync"\n\t"syscall"\n'
MEDIA_RETRY_SYNC_IMPORT_SENTINEL = '\t"sync"\n\t"syscall"\n'

# M2 — waMmsRetry proto import (anchor on the pristine types/events import line).
MEDIA_RETRY_PROTO_IMPORT_NEEDLE = '\t"go.mau.fi/whatsmeow/types/events"\n'
MEDIA_RETRY_PROTO_IMPORT_REPLACEMENT = (
    '\t"go.mau.fi/whatsmeow/types/events"\n'
    '\twaMmsRetry "go.mau.fi/whatsmeow/proto/waMmsRetry"\n'
)
MEDIA_RETRY_PROTO_IMPORT_SENTINEL = 'waMmsRetry "go.mau.fi/whatsmeow/proto/waMmsRetry"'

# M3 — the registry + downloadWithRetry() helper, inserted right before
# downloadMedia(). Anchors on the pristine downloadMedia signature.
MEDIA_RETRY_BLOCK_NEEDLE = "func downloadMedia(client *whatsmeow.Client, messageStore *MessageStore, messageID, chatJID string) (bool, string, string, string, error) {"
MEDIA_RETRY_BLOCK_REPLACEMENT = """// --- claude-ops Fix M: media-retry fallback ---------------------------------
// WhatsApp returns HTTP 403/404/410 when a media's directPath has gone stale
// server-side (common for larger media, or media that failed its at-receipt
// download). whatsmeow treats those as terminal. The documented recovery is
// SendMediaRetryReceipt: ask the sender's phone to re-upload, which yields a
// FRESH directPath we can download from. This registry lets the synchronous
// download path block on the async *events.MediaRetry response.
var (
\tmediaRetryMu    sync.Mutex
\tmediaRetryChans = map[string][]chan *events.MediaRetry{}
)

func registerMediaRetry(messageID string) chan *events.MediaRetry {
\tch := make(chan *events.MediaRetry, 1)
\tmediaRetryMu.Lock()
\tmediaRetryChans[messageID] = append(mediaRetryChans[messageID], ch)
\tmediaRetryMu.Unlock()
\treturn ch
}

func deliverMediaRetry(evt *events.MediaRetry) {
\tmediaRetryMu.Lock()
\tchans := mediaRetryChans[evt.MessageID]
\tmediaRetryMu.Unlock()
\tfor _, ch := range chans {
\t\tselect {
\t\tcase ch <- evt:
\t\tdefault:
\t\t}
\t}
}

func unregisterMediaRetry(messageID string, ch chan *events.MediaRetry) {
\tmediaRetryMu.Lock()
\tdefer mediaRetryMu.Unlock()
\twaiters := mediaRetryChans[messageID]
\tfor i, w := range waiters {
\t\tif w == ch {
\t\t\tmediaRetryChans[messageID] = append(waiters[:i], waiters[i+1:]...)
\t\t\tbreak
\t\t}
\t}
\tif len(mediaRetryChans[messageID]) == 0 {
\t\tdelete(mediaRetryChans, messageID)
\t}
}

// downloadWithRetry calls client.Download; on a 403/404/410 it asks the sender's
// phone to re-upload (SendMediaRetryReceipt), waits for the fresh directPath, and
// retries once. Any other error (or a failed retry) is returned to the caller.
func downloadWithRetry(client *whatsmeow.Client, messageStore *MessageStore, messageID, chatJID string, downloader *MediaDownloader) ([]byte, error) {
\tdata, err := client.Download(context.Background(), downloader)
\tif err == nil {
\t\treturn data, nil
\t}
\tes := err.Error()
\tif !(strings.Contains(es, "403") || strings.Contains(es, "404") || strings.Contains(es, "410")) {
\t\treturn nil, err
\t}

\t// Reconstruct enough MessageInfo for the retry receipt.
\tvar senderStr string
\tvar ts int64
\tvar fromMe bool
\t_ = messageStore.db.QueryRow(
\t\t"SELECT COALESCE(sender,''), CAST(strftime('%s', timestamp) AS INTEGER), is_from_me FROM messages WHERE id = ? AND chat_jid = ?",
\t\tmessageID, chatJID,
\t).Scan(&senderStr, &ts, &fromMe)

\tchat, perr := types.ParseJID(chatJID)
\tif perr != nil {
\t\treturn nil, fmt.Errorf("media-retry: bad chat jid %q: %v (orig: %w)", chatJID, perr, err)
\t}
\tvar sender types.JID
\tswitch {
\tcase fromMe && client.Store.ID != nil:
\t\tsender = *client.Store.ID
\tcase senderStr != "":
\t\tif strings.Contains(senderStr, "@") {
\t\t\tsender, _ = types.ParseJID(senderStr)
\t\t} else if chat.Server == types.GroupServer {
\t\t\tsender = types.NewJID(senderStr, types.DefaultUserServer)
\t\t} else {
\t\t\tsender = types.NewJID(senderStr, chat.Server)
\t\t}
\tdefault:
\t\tsender = chat
\t}
\tinfo := &types.MessageInfo{
\t\tID:        messageID,
\t\tTimestamp: time.Unix(ts, 0),
\t\tMessageSource: types.MessageSource{
\t\t\tChat:     chat,
\t\t\tSender:   sender,
\t\t\tIsFromMe: fromMe,
\t\t\tIsGroup:  chat.Server == types.GroupServer,
\t\t},
\t}

\tch := registerMediaRetry(messageID)
\tdefer unregisterMediaRetry(messageID, ch)

\tfmt.Printf("Media download hit %s for %s — requesting re-upload via media-retry...\\n", es, messageID)
\tif rerr := client.SendMediaRetryReceipt(context.Background(), info, downloader.MediaKey); rerr != nil {
\t\treturn nil, fmt.Errorf("media-retry receipt failed: %v (orig: %w)", rerr, err)
\t}

\tselect {
\tcase evt := <-ch:
\t\tnotif, derr := whatsmeow.DecryptMediaRetryNotification(evt, downloader.MediaKey)
\t\tif derr != nil {
\t\t\treturn nil, fmt.Errorf("media-retry decrypt failed: %v (orig: %w)", derr, err)
\t\t}
\t\tif notif.GetResult() != waMmsRetry.MediaRetryNotification_SUCCESS {
\t\t\treturn nil, fmt.Errorf("media-retry not successful: %s (orig: %w)", notif.GetResult().String(), err)
\t\t}
\t\tdownloader.DirectPath = notif.GetDirectPath()
\t\tdownloader.URL = ""
\t\tfmt.Printf("Media-retry returned fresh directPath for %s — retrying download...\\n", messageID)
\t\treturn client.Download(context.Background(), downloader)
\tcase <-time.After(30 * time.Second):
\t\treturn nil, fmt.Errorf("media-retry timed out after 30s (orig: %w)", err)
\t}
}

func downloadMedia(client *whatsmeow.Client, messageStore *MessageStore, messageID, chatJID string) (bool, string, string, string, error) {"""
MEDIA_RETRY_BLOCK_SENTINEL = "claude-ops Fix M: media-retry fallback"

# M4 — route downloadMedia's actual download through downloadWithRetry.
# Pristine upstream calls the OLD one-arg client.Download(downloader); whatsmeow
# @latest (which the installer `go get -u`s) takes (context, downloader), and
# downloadWithRetry uses the two-arg form. Anchor on the pristine one-arg line.
MEDIA_RETRY_CALL_NEEDLE = "\tmediaData, err := client.Download(downloader)"
MEDIA_RETRY_CALL_REPLACEMENT = "\t// media-retry fallback on 403/404/410 (claude-ops Fix M)\n\tmediaData, err := downloadWithRetry(client, messageStore, messageID, chatJID, downloader)"
MEDIA_RETRY_CALL_SENTINEL = "mediaData, err := downloadWithRetry(client, messageStore"

# M5 — deliver *events.MediaRetry to the blocked downloader (anchor on the
# pristine HistorySync case in the AddEventHandler switch).
MEDIA_RETRY_EVENT_NEEDLE = """\t\tcase *events.HistorySync:
\t\t\t// Process history sync events
\t\t\thandleHistorySync(client, messageStore, v, logger)
"""
MEDIA_RETRY_EVENT_REPLACEMENT = """\t\tcase *events.HistorySync:
\t\t\t// Process history sync events
\t\t\thandleHistorySync(client, messageStore, v, logger)

\t\tcase *events.MediaRetry:
\t\t\t// Deliver re-upload notifications to any download blocked on a 403/404/410
\t\t\t// (claude-ops Fix M — media-retry fallback).
\t\t\tdeliverMediaRetry(v)
"""
MEDIA_RETRY_EVENT_SENTINEL = "claude-ops Fix M — media-retry fallback"


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


def append_idempotent(p: pathlib.Path, block: str, sentinel: str, label: str) -> bool:
    """Append `block` to the end of a file unless `sentinel` is already present.

    Unlike replace_idempotent this needs no needle — it self-installs even on a
    pristine upstream checkout that lacks the surrounding context a splice would
    anchor on. Used by Fix M to make the archive/resync MCP surface self-contained
    so a fresh `git clone` of lharries/whatsapp-mcp + this patcher yields a working
    archive_chat tool that routes through the healing /api/archive endpoint, rather
    than silently no-opping when upstream changes shape.
    """
    text = p.read_text()
    if sentinel in text:
        print(f"  [skip] {label}: already applied")
        return False
    sep = "" if text.endswith("\n") else "\n"
    p.write_text(text + sep + block)
    print(f"  [ok]   {label}: applied")
    return True


# ─── main.go Fix O: HistorySync → chats.archived authoritative projection ─────
# The regular_low app-state collection (archive/pin/mute) is chronically corrupt
# on many accounts (whatsmeow #382/#518/#858 — "mismatching LTHash"), so neither
# the live *events.Archive subscriber (Fix H) nor /api/archive can keep
# chats.archived in step with the phone. The HistorySync payload, however, carries
# each conversation's authoritative `Archived` flag (waHistorySync.Conversation.
# Archived) — a channel that completely bypasses the broken app-state. Fix O
# projects that flag onto chats.archived so the inbox view (WHERE archived=0)
# tracks the phone. On a FULL/INITIAL_BOOTSTRAP sync (what a re-pair delivers) the
# conversation list is authoritative+complete, so the column is reset first and
# then re-marked exactly to the phone's archived set.

# 1. import the waHistorySync proto package (for the sync-type constants).
FIXN_IMPORT_NEEDLE = '\t"go.mau.fi/whatsmeow/types"\n'
FIXN_IMPORT_REPLACEMENT = (
    '\t"go.mau.fi/whatsmeow/types"\n'
    '\twaHistorySync "go.mau.fi/whatsmeow/proto/waHistorySync" // claude-ops Fix O\n'
)
FIXN_IMPORT_SENTINEL = 'waHistorySync "go.mau.fi/whatsmeow/proto/waHistorySync"'

# 2. ResetAllArchived helper, spliced in before the Close method (stable anchor).
FIXN_RESET_NEEDLE = (
    "// Close the database connection\nfunc (store *MessageStore) Close() error {"
)
FIXN_RESET_REPLACEMENT = """// claude-ops Fix O: ResetAllArchived clears the archived flag on every chat.
// Used before reprojecting a FULL/INITIAL_BOOTSTRAP HistorySync, whose conversation
// list is authoritative+complete — so chats.archived ends up mirroring the phone
// exactly (the per-conversation projection re-marks only the truly-archived set).
func (store *MessageStore) ResetAllArchived() error {
\t_, err := store.db.Exec(`UPDATE chats SET archived=0 WHERE archived<>0`)
\treturn err
}

// Close the database connection
func (store *MessageStore) Close() error {"""
FIXN_RESET_SENTINEL = "func (store *MessageStore) ResetAllArchived()"

# 3. reset-on-FULL/INITIAL at the top of handleHistorySync (anchor on the Printf).
FIXN_RESET_CALL_NEEDLE = '\tfmt.Printf("Received history sync event with %d conversations\\n", len(historySync.Data.Conversations))\n'
FIXN_RESET_CALL_REPLACEMENT = (
    '\tfmt.Printf("Received history sync event with %d conversations\\n", len(historySync.Data.Conversations))\n\n'
    "\t// claude-ops Fix O: on a FULL or INITIAL_BOOTSTRAP history sync the conversation\n"
    "\t// list is authoritative and complete (this is what a re-pair delivers), so reset\n"
    "\t// chats.archived first; the per-conversation projection below then re-marks exactly\n"
    "\t// the phone's archived set — the one reliable path to a fully-correct inbox view.\n"
    "\tif st := historySync.Data.GetSyncType(); st == waHistorySync.HistorySync_FULL || st == waHistorySync.HistorySync_INITIAL_BOOTSTRAP {\n"
    "\t\tif err := messageStore.ResetAllArchived(); err != nil {\n"
    '\t\t\tlogger.Warnf("claude-ops Fix O: ResetAllArchived failed: %v", err)\n'
    "\t\t}\n"
    "\t}\n"
)
FIXN_RESET_CALL_SENTINEL = (
    "claude-ops Fix O: on a FULL or INITIAL_BOOTSTRAP history sync"
)

# 4. per-conversation projection (anchor on the GetChatName line, stable upstream).
FIXN_PROJECT_NEEDLE = '\t\tname := GetChatName(client, messageStore, jid, chatJID, conversation, "", logger)\n'
FIXN_PROJECT_REPLACEMENT = (
    '\t\tname := GetChatName(client, messageStore, jid, chatJID, conversation, "", logger)\n\n'
    "\t\t// claude-ops Fix O: project the phone's authoritative archive flag from the\n"
    "\t\t// HistorySync payload onto chats.archived, bypassing the broken regular_low\n"
    "\t\t// app-state (#382/#858). Guard on a present flag, and only touch rows that are\n"
    "\t\t// either archived (safe to upsert) or message-bearing (StoreChat creates them),\n"
    "\t\t// so we never spawn bare archived=0 rows for empty conversations.\n"
    "\t\tif conversation.Archived != nil && (conversation.GetArchived() || len(conversation.Messages) > 0) {\n"
    "\t\t\t_ = messageStore.SetArchivedStatus(chatJID, *conversation.Archived)\n"
    "\t\t}\n"
)
FIXN_PROJECT_SENTINEL = (
    "claude-ops Fix O: project the phone's authoritative archive flag from the"
)


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
    changed_go |= replace_idempotent(
        main_go,
        CTX_SQLSTORE_NEEDLE,
        CTX_SQLSTORE_REPLACEMENT,
        CTX_SQLSTORE_SENTINEL,
        "Fix N: sqlstore.New ctx arg",
    )
    changed_go |= replace_idempotent(
        main_go,
        CTX_GETFIRSTDEVICE_NEEDLE,
        CTX_GETFIRSTDEVICE_REPLACEMENT,
        CTX_GETFIRSTDEVICE_SENTINEL,
        "Fix N: GetFirstDevice ctx arg",
    )
    changed_go |= replace_idempotent(
        main_go,
        CTX_GETGROUPINFO_NEEDLE,
        CTX_GETGROUPINFO_REPLACEMENT,
        CTX_GETGROUPINFO_SENTINEL,
        "Fix N: GetGroupInfo ctx arg",
    )
    changed_go |= replace_idempotent(
        main_go,
        CTX_GETCONTACT_NEEDLE,
        CTX_GETCONTACT_REPLACEMENT,
        CTX_GETCONTACT_SENTINEL,
        "Fix N: GetContact ctx arg",
    )
    changed_go |= replace_idempotent(
        main_go,
        MEDIA_RETRY_SYNC_IMPORT_NEEDLE,
        MEDIA_RETRY_SYNC_IMPORT_REPLACEMENT,
        MEDIA_RETRY_SYNC_IMPORT_SENTINEL,
        'Fix M: add "sync" import (media-retry registry)',
    )
    changed_go |= replace_idempotent(
        main_go,
        MEDIA_RETRY_PROTO_IMPORT_NEEDLE,
        MEDIA_RETRY_PROTO_IMPORT_REPLACEMENT,
        MEDIA_RETRY_PROTO_IMPORT_SENTINEL,
        "Fix M: add waMmsRetry proto import",
    )
    changed_go |= replace_idempotent(
        main_go,
        MEDIA_RETRY_BLOCK_NEEDLE,
        MEDIA_RETRY_BLOCK_REPLACEMENT,
        MEDIA_RETRY_BLOCK_SENTINEL,
        "Fix M: media-retry registry + downloadWithRetry()",
    )
    changed_go |= replace_idempotent(
        main_go,
        MEDIA_RETRY_CALL_NEEDLE,
        MEDIA_RETRY_CALL_REPLACEMENT,
        MEDIA_RETRY_CALL_SENTINEL,
        "Fix M: route downloadMedia through downloadWithRetry()",
    )
    changed_go |= replace_idempotent(
        main_go,
        MEDIA_RETRY_EVENT_NEEDLE,
        MEDIA_RETRY_EVENT_REPLACEMENT,
        MEDIA_RETRY_EVENT_SENTINEL,
        "Fix M: deliver *events.MediaRetry to blocked downloader",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_IMPORT_NEEDLE,
        FIXN_IMPORT_REPLACEMENT,
        FIXN_IMPORT_SENTINEL,
        "Fix O: import waHistorySync proto (sync-type constants)",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_RESET_NEEDLE,
        FIXN_RESET_REPLACEMENT,
        FIXN_RESET_SENTINEL,
        "Fix O: ResetAllArchived helper",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_RESET_CALL_NEEDLE,
        FIXN_RESET_CALL_REPLACEMENT,
        FIXN_RESET_CALL_SENTINEL,
        "Fix O: reset chats.archived on FULL/INITIAL history sync",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_PROJECT_NEEDLE,
        FIXN_PROJECT_REPLACEMENT,
        FIXN_PROJECT_SENTINEL,
        "Fix O: project HistorySync archive flag onto chats.archived",
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
    # Fix M: self-contained archive_chat + resync_app_state helpers (whatsapp.py).
    # MUST run before the Fix K helper splice — Fix K's MCP_HELPER_NEEDLE anchors on
    # the archive_chat def that this block installs. On pristine upstream this is the
    # only thing that creates archive_chat at all; on an already-patched tree the
    # sentinel short-circuits so no duplicate def is appended.
    changed_py |= append_idempotent(
        whatsapp_py,
        MCP_ARCHIVE_HELPER_BLOCK,
        MCP_ARCHIVE_HELPER_SENTINEL,
        "Fix M: archive_chat + resync_app_state helpers (whatsapp.py)",
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
    # Fix M: archive_chat + resync_app_state import aliases (main.py). MUST run before
    # the Fix K import splice — Fix K's MCP_IMPORT_NEEDLE anchors on the
    # `resync_app_state as whatsapp_resync_app_state,` line this block installs.
    changed_server_main |= replace_idempotent(
        server_main_py,
        MCP_ARCHIVE_IMPORT_NEEDLE,
        MCP_ARCHIVE_IMPORT_REPLACEMENT,
        MCP_ARCHIVE_IMPORT_SENTINEL,
        "Fix M: archive_chat + resync import aliases (main.py)",
    )
    # Fix M: archive_chat + resync_app_state @mcp.tool wrappers (main.py). MUST run
    # before the Fix K tool splice — Fix K's MCP_TOOL_NEEDLE anchors on the
    # resync_app_state tool body this block installs.
    changed_server_main |= replace_idempotent(
        server_main_py,
        MCP_ARCHIVE_TOOLS_NEEDLE,
        MCP_ARCHIVE_TOOLS_REPLACEMENT,
        MCP_ARCHIVE_TOOLS_SENTINEL,
        "Fix M: archive_chat + resync_app_state MCP tools (main.py)",
    )
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
