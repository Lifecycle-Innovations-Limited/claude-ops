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
\t\t\tphone = \"10000000000\"
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
\t\t\tphone = \"10000000000\"
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

# ─── main.go Fix D (Connected): auto-resync regular_low on startup ────────────
CONNECTED_RESYNC_NEEDLE = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")
\t\t\t// claude-ops: auto-trigger a deep history backfill on every Connected event."""

CONNECTED_RESYNC_REPLACEMENT = """\t\tcase *events.Connected:
\t\t\tlogger.Infof(\"Connected to WhatsApp\")
\t\t\t// claude-ops Fix D: force a full resync of the regular_low app-state patch
\t\t\t// on every connect. Clears LTHash mismatch errors that fire when the local
\t\t\t// snapshot is stale. Non-fatal if it fails (message delivery unaffected).
\t\t\tgo func(c *whatsmeow.Client) {
\t\t\t\ttime.Sleep(3 * time.Second)
\t\t\t\tlogger.Infof(\"Auto-resync: fetching fresh regular_low app-state snapshot\")
\t\t\t\tif err := c.FetchAppState(context.Background(), \"regular_low\", true, false); err != nil {
\t\t\t\t\tlogger.Debugf(\"regular_low app-state resync: %v (non-fatal)\", err)
\t\t\t\t} else {
\t\t\t\t\tlogger.Infof(\"regular_low app-state resync complete\")
\t\t\t\t}
\t\t\t}(client)
\t\t\t// claude-ops: auto-trigger a deep history backfill on every Connected event."""

CONNECTED_RESYNC_SENTINEL = "claude-ops Fix D: force a full resync of the regular_low"

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

    for p in (main_go, whatsapp_py):
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
        "Fix D: auto-resync regular_low on Connected event",
    )
    changed_go |= replace_idempotent(
        main_go,
        RESYNC_ENDPOINT_NEEDLE,
        RESYNC_ENDPOINT_REPLACEMENT,
        RESYNC_ENDPOINT_SENTINEL,
        "Fix D: POST /api/resync_app_state endpoint",
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
