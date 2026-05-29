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

    print("  whatsapp.py:")
    changed_py = replace_idempotent(
        whatsapp_py,
        PY_PATH_NEEDLE,
        PY_PATH_REPLACEMENT,
        PY_PATH_SENTINEL,
        "LID resolver + whatsmeow_contacts lookup",
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
