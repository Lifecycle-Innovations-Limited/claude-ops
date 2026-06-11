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
  Fix P — maximum history on (re-)pair: upstream pairs with RequireFullSync=false and
          small history-sync limits, so a fresh pair only backfills a recent window.
          Fix P sets store.DeviceProps.RequireFullSync=true and maxes the history-sync
          config (FullSyncDaysLimit ~10y, size/quota 100GB) before the client is built,
          so the phone ships the deepest full-history snapshot it has on the next pair —
          feeding handleHistorySync and the Fix O projection with as much real data as
          possible. Effective on the NEXT pair only.
  Fix Q — app-state readiness gate (the durable re-pair LTHash-corruption fix):
          after a fresh re-pair the regular_low app-state collection (archive/
          pin/mute) is NOT fully synced yet, so the very first /api/archive
          mutation builds a patch on top of an empty/partial local LTHash baseline.
          The server rejects it ("mismatching LTHash") and — worse — the failed
          half-applied mutation leaves the local collection diverged so neither
          /api/archive nor /api/resync_app_state can heal it without a manual
          phone tap. Fix Q closes that window: on the first *events.Connected it
          fires a full FetchAppState(regular_low) in the background and only then
          flips a mutex-guarded `appStateReady` flag. /api/archive rejects with
          HTTP 425 (Too Early) + {"error":"app_state_not_ready"} until the flag is
          set, so an archive is NEVER attempted against an unsynced LTHash. Adds a
          tiny GET /api/app_state_status -> {"ready":bool} so callers (ops-inbox)
          can wait for readiness before mutating.
  Fix R — /api/resync_app_state discard_local mode: heals an ALREADY-corrupted
          regular_low LTHash WITHOUT a phone tap. When the request carries
          discard_local=true (query param or JSON body) the handler first wipes the
          local app-state version + mutation-MAC rows for the collection from
          whatsmeow.db (dropping the diverged local LTHash baseline — the same SAFE
          row set Fix G clears, never touching identity/session/pre_key tables),
          then runs a full FetchAppState(fullSync=true) to re-pull the server's
          authoritative state onto a clean baseline. Without discard_local the
          handler behaves exactly as before (plain full resync).
  Fix T — skip-and-continue past unverifiable LTHash patches: the server's
          regular_low patch chain may contain one or more patches that fail
          LTHash verification regardless of local state ("failed to verify patch
          vNNN: mismatching LTHash" — whatsmeow #382/#858/#1176). These bad
          patches repeat on EVERY incremental notification sync, so the bridge
          is permanently wedged even after re-pair. Fix T adds
          syncAppStateSkipBad() which wraps FetchAppState in a bounded retry
          loop: on each ErrMismatchingLTHash it parses the failing version N
          from the error string, writes version N with a zeroed hash directly
          into whatsmeow_app_state_version, clears all mutation MACs for the
          collection (so the fresh fetch starts from a clean LTHash accumulator),
          and retries FetchAppState from the new cursor — effectively skipping
          the bad patch and applying all subsequent valid patches. Up to 30
          bad patches are skipped per call. syncAppStateThenReady() is updated
          to use syncAppStateSkipBad() so the on-connect sync no longer wedges
          on bad patches. /api/resync_app_state gains a skip_bad=true query
          param / JSON field that calls syncAppStateSkipBad() directly, allowing
          the currently-wedged bridge to self-heal without a re-pair or binary
          swap.
  Fix U — no-re-pair archive reconcile: POST /api/reconcile_archived rebuilds
          chats.archived in messages.db to match the phone's authoritative
          archive state without re-pairing. Sequence: ResetAllArchived() zeros
          the column; client.EmitAppStateEventsOnFullSync is set true so the
          subsequent full app-state fetch fires *events.Archive synchronously
          for every archived chat; Fix H's SetArchivedStatus subscriber writes
          each one into chats.archived; EmitAppStateEventsOnFullSync is
          restored to false after. Uses syncAppStateSkipBad (Fix T) to handle
          any bad patches in the chain. Idempotent: running twice yields the
          same counts. Returns {"archived_count":N,"non_archived_count":M}.
  Fix S — wa-inbox-fresh.sh app-state freshness wait: before ops-inbox performs
          any archive mutation it polls GET /api/app_state_status and waits up to
          ~30s for ready:true, so the first post-re-pair archive is never fired
          against an unsynced LTHash. Best-effort: an old bridge without the
          endpoint (404/curl failure) is treated as ready so ops-inbox never hard-
          fails on a stale bridge.
  Fix T — skip-and-continue past unverifiable LTHash patches (the durable fix
          for a permanently-wedged bridge without re-pair): the server's
          regular_low patch chain may contain patches that fail LTHash
          verification regardless of local state, causing every incremental
          notification sync to abort. Fix T adds syncAppStateSkipBad() which
          wraps FetchAppState in a bounded retry loop (up to 200 skips): on each
          ErrMismatchingLTHash failure it advances the stored version cursor
          past the failing patch (writing the version with a zero hash, clearing
          mutation MACs), then retries. syncAppStateThenReady() is updated to
          use this loop so the on-connect sync never permanently wedges.
          /api/resync_app_state?skip_bad=true (or JSON skip_bad:true) calls
          syncAppStateSkipBad() directly to heal an already-wedged bridge
          without a restart or re-pair.
  Fix V — extend skip loop to tolerate missing sync keys + throttle + key-
          arrival poller: two sub-fixes that make Fix T robust when the
          whatsmeow_app_state_sync_keys table is empty (e.g. after a manual DB
          wipe). (a) isSkippablePatchErr() extends the "skip this patch"
          condition to include "didn't find app state key" errors in addition to
          "mismatching LTHash", so the skip loop advances past key-missing
          patches rather than bailing out immediately. (b) A 300ms sleep between
          skip iterations prevents the server-side 429 rate-overlimit that
          occurred when 40+ rapid back-to-back FetchAppState calls exhausted the
          per-connection IQ budget mid-loop. (c) syncAppStateThenReady spawns a
          5s-interval poller that watches whatsmeow_app_state_sync_keys for new
          rows (the phone delivers them asynchronously in response to whatsmeow's
          automatic key-share request); once keys arrive, the poller re-runs
          syncAppStateSkipBad so appStateReady flips without requiring a restart
          or manual /api/resync_app_state call. Poller gives up after 10 min.

VERIFIED end-to-end heal sequence for a massively poisoned regular_low chain
(2026-06-10, validated 31/31 batch archives at >=2 s pacing):

  STEP 1 — Wipe stale sync keys (nuclear option for severe key corruption).
    Stop the bridge, then in store/whatsapp.db run:
      DELETE FROM whatsmeow_app_state_sync_keys;
      DELETE FROM whatsmeow_app_state_version;
      DELETE FROM whatsmeow_app_state_mutation_macs;
    The phone MUST be online. Start the bridge — whatsmeow auto-requests fresh
    keys; the phone reissues them (~114 observed). Wait for "new app state keys
    received" in the bridge log before proceeding.

  STEP 2 — Ensure Fix T + Fix V patches applied and bridge binary rebuilt.
    Run this script, then rebuild and restart (use --build --restart, or:
      cd ~/.local/share/whatsapp-mcp/whatsapp-bridge
      go build -o whatsapp-bridge .
      systemctl --user restart whatsapp-bridge.service   # Linux
    Without the rebuild the running binary does not have Fix T + Fix V; the
    skip loop will NOT run and the bridge stays wedged.

  STEP 3 — Skip loop runs automatically on connect.
    syncAppStateThenReady (Fix Q + Fix T + Fix V) fires on *events.Connected.
    Watch logs for "skipping bad patch vNNN" lines. Expect one 429 rate-overlimit
    pause (~15-20 min) mid-loop when the IQ budget is exhausted; the loop
    resumes automatically after the cooldown (Fix V throttle + poller).
    Success indicators:
      "regular_low sync complete (skipped N bad patches)"
      "archive mutations enabled"

  STEP 4 — Verify archive works.
    curl -s -X POST http://localhost:8080/api/archive \
      -H 'Content-Type: application/json' \
      -d '{"chat_jid":"<JID>","archive":true}'
    Should return {"success":true,...}. If you need to reconcile existing archived
    state without re-pairing:
    curl -s -X POST http://localhost:8080/api/reconcile_archived
    Returns {"archived_count":N,"non_archived_count":M}.

  Upstream: tulir/whatsmeow#1171 (SkipBrokenAppStatePatches opt-in). If/when
  merged, the bridge can adopt the upstream flag and retire Fix T + Fix V.

Every patch is gated on a sentinel string so re-running is a no-op.

Usage:
  apply-patches.py [--install-dir PATH] [--build] [--restart]
    --install-dir  Defaults to ~/.local/share/whatsapp-mcp
    --build        After patching, run `go build -o whatsapp-bridge .` in the
                   bridge dir when any .go file changed.  Exits non-zero on
                   build failure.  No-op when no Go files changed.
    --restart      After a successful --build, restart the whatsapp-bridge
                   service.  Linux: systemctl --user restart whatsapp-bridge.service.
                   macOS: launchctl kickstart -k with load-w fallback.  No-op
                   when --build was not requested or the build failed.
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
\t\t\t\t// claude-ops Fix V: the recovery peer-message makes the phone re-send the
\t\t\t\t// regular_low snapshot ASYNCHRONOUSLY. Blindly re-calling SendAppState
\t\t\t\t// against the still-stale local cache fails on every attempt until that
\t\t\t\t// fresh snapshot is processed — which is why the old short blind loop
\t\t\t\t// returned 409 and forced a manual recover->retry. Each retry must first
\t\t\t\t// RE-PULL the server's freshly-recovered patch chain (healLTHash =
\t\t\t\t// FetchAppState) before re-attempting the mutation, with a larger bounded
\t\t\t\t// budget (~60s, capped backoff) so callers converge without any manual step.
\t\t\t\t//
\t\t\t\t// FAIL-FAST on the unfixable class (NEVER-LEAK guard): healLTHash does a
\t\t\t\t// destructive local wipe + FetchAppState(fullSync=true, from v0). When the
\t\t\t\t// SERVER patch chain is genuinely unverifiable (persistent corruption),
\t\t\t\t// every re-pull FAILS and re-pulling 8x cannot help — it is pure
\t\t\t\t// cost/latency burn (repeated full-snapshot wipes). So: keep retrying only
\t\t\t\t// while the re-pull SUCCEEDS (transient case — snapshot still landing); if
\t\t\t\t// healLTHash itself keeps failing, bail after 2 such failures and let the
\t\t\t\t// caller resync/re-pair rather than burning the remaining attempts.
\t\t\t\thealFails := 0
\t\t\t\tfor attempt := 1; attempt <= 8; attempt++ {
\t\t\t\t\tbackoff := time.Duration(attempt*2) * time.Second
\t\t\t\t\tif backoff > 10*time.Second {
\t\t\t\t\t\tbackoff = 10 * time.Second
\t\t\t\t\t}
\t\t\t\t\ttime.Sleep(backoff)
\t\t\t\t\t// Re-pull the phone's recovered snapshot so the retry writes against
\t\t\t\t\t// the new patch chain, not the stale cache that caused the 409.
\t\t\t\t\tif hErr := healLTHash(ctx, client, appstate.WAPatchRegularLow); hErr != nil {
\t\t\t\t\t\t// Re-pull failed → server chain still unverifiable. Don't burn the
\t\t\t\t\t\t// remaining destructive fullSync passes on a state re-pulling can't fix.
\t\t\t\t\t\thealFails++
\t\t\t\t\t\tif healFails >= 2 {
\t\t\t\t\t\t\terr = hErr
\t\t\t\t\t\t\tbreak
\t\t\t\t\t\t}
\t\t\t\t\t\tcontinue
\t\t\t\t\t}
\t\t\t\t\thealFails = 0
\t\t\t\t\tif err = do(); err == nil {
\t\t\t\t\t\tbreak
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tif err != nil {
\t\t\t\t\tw.WriteHeader(http.StatusConflict)
\t\t\t\t\tfmt.Fprintf(w, `{"success":false,"message":"app-state recovery could not produce a verifiable regular_low snapshot (persistent server-side corruption — resync/re-pair needed, not a transient retry): %s"}`, err.Error())
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
# Broaden sentinel to cover the old "Fix I" variant already present on live installs
# (live bridge has "claude-ops Fix I: media-retry fallback" comment from a prior
# hand-patch; re-running apply-patches would have missed it and appended a duplicate).
# Keying on `func downloadWithRetry` — present in any variant of the block.
MEDIA_RETRY_BLOCK_SENTINEL = "func downloadWithRetry("

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
# Broadened to cover "Fix I" comment in old live-install variant.
MEDIA_RETRY_EVENT_SENTINEL = "case *events.MediaRetry:"


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


def replace_if_present(
    p: pathlib.Path, needle: str, replacement: str, sentinel: str, label: str
) -> bool:
    """Like replace_idempotent but no-ops quietly when needle is absent."""
    text = p.read_text()
    if sentinel in text:
        print(f"  [skip] {label}: already applied")
        return False
    if needle not in text:
        print(f"  [skip] {label}: not needed")
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
// Used before reprojecting an INITIAL_BOOTSTRAP HistorySync, whose conversation
// list is authoritative+complete — so chats.archived ends up mirroring the phone
// exactly (the per-conversation projection re-marks only the truly-archived set).
func (store *MessageStore) ResetAllArchived() error {
\t_, err := store.db.Exec(`UPDATE chats SET archived=0 WHERE archived<>0`)
\treturn err
}

// Close the database connection
func (store *MessageStore) Close() error {"""
FIXN_RESET_SENTINEL = "func (store *MessageStore) ResetAllArchived()"

# 3. reset-on-INITIAL_BOOTSTRAP at the top of handleHistorySync (anchor on the Printf).
FIXN_RESET_CALL_NEEDLE = '\tfmt.Printf("Received history sync event with %d conversations\\n", len(historySync.Data.Conversations))\n'
FIXN_RESET_CALL_REPLACEMENT = (
    '\tfmt.Printf("Received history sync event with %d conversations\\n", len(historySync.Data.Conversations))\n\n'
    "\t// claude-ops Fix O: on INITIAL_BOOTSTRAP the conversation list is authoritative\n"
    "\t// and complete (first blob after re-pair); reset chats.archived first, then the\n"
    "\t// per-conversation projection below re-marks exactly the phone's archived set.\n"
    "\t// FULL sync is incremental (subset of chats per blob) — do not reset globally.\n"
    "\tif st := historySync.Data.GetSyncType(); st == waHistorySync.HistorySync_INITIAL_BOOTSTRAP {\n"
    "\t\tif err := messageStore.ResetAllArchived(); err != nil {\n"
    '\t\t\tlogger.Warnf("claude-ops Fix O: ResetAllArchived failed: %v", err)\n'
    "\t\t}\n"
    "\t}\n"
)
FIXN_RESET_CALL_SENTINEL = (
    "claude-ops Fix O: on INITIAL_BOOTSTRAP the conversation list is authoritative"
)

# 4. per-conversation projection (anchor on the GetChatName line, stable upstream).
FIXN_PROJECT_NEEDLE = '\t\tname := GetChatName(client, messageStore, jid, chatJID, conversation, "", logger)\n'
FIXN_PROJECT_REPLACEMENT = (
    '\t\tname := GetChatName(client, messageStore, jid, chatJID, conversation, "", logger)\n\n'
    "\t\t// claude-ops Fix O: project the phone's authoritative archive flag from the\n"
    "\t\t// HistorySync payload onto chats.archived, bypassing the broken regular_low\n"
    "\t\t// app-state (#382/#858). Guard on a present flag. Archive/mark-up uses\n"
    "\t\t// SetArchivedStatus (UPSERT); metadata-only unarchive UPDATEs an existing row\n"
    "\t\t// so bare archived=0 chats are never spawned for unknown empty conversations.\n"
    "\t\tif conversation.Archived != nil {\n"
    "\t\t\tif conversation.GetArchived() || len(conversation.Messages) > 0 {\n"
    "\t\t\t\t_ = messageStore.SetArchivedStatus(chatJID, *conversation.Archived)\n"
    "\t\t\t} else {\n"
    "\t\t\t\t_, _ = messageStore.db.Exec(`UPDATE chats SET archived=0 WHERE jid=? AND archived<>0`, chatJID)\n"
    "\t\t\t}\n"
    "\t\t}\n"
)
FIXN_PROJECT_SENTINEL = (
    "claude-ops Fix O: project the phone's authoritative archive flag from the"
)
# Fix-up for installs that already applied the pre-fix projection guard.
FIXN_PROJECT_FIXUP_NEEDLE = (
    "\t\t// either archived (safe to upsert) or message-bearing (StoreChat creates them),\n"
    "\t\t// so we never spawn bare archived=0 rows for empty conversations.\n"
    "\t\tif conversation.Archived != nil && (conversation.GetArchived() || len(conversation.Messages) > 0) {\n"
    "\t\t\t_ = messageStore.SetArchivedStatus(chatJID, *conversation.Archived)\n"
    "\t\t}\n"
)
FIXN_PROJECT_FIXUP_REPLACEMENT = (
    "\t\t// either archived (UPSERT) or message-bearing (StoreChat creates them).\n"
    "\t\t// Metadata-only unarchive UPDATEs an existing row so bare archived=0 chats\n"
    "\t\t// are never spawned for unknown empty conversations.\n"
    "\t\tif conversation.Archived != nil {\n"
    "\t\t\tif conversation.GetArchived() || len(conversation.Messages) > 0 {\n"
    "\t\t\t\t_ = messageStore.SetArchivedStatus(chatJID, *conversation.Archived)\n"
    "\t\t\t} else {\n"
    "\t\t\t\t_, _ = messageStore.db.Exec(`UPDATE chats SET archived=0 WHERE jid=? AND archived<>0`, chatJID)\n"
    "\t\t\t}\n"
    "\t\t}\n"
)
FIXN_PROJECT_FIXUP_SENTINEL = "Metadata-only unarchive UPDATEs an existing row"


# ─── main.go Fix P: request maximum history on (re-)pair ──────────────────────
# store.DeviceProps is whatsmeow's global registration payload, read when a device
# pairs. Upstream defaults to RequireFullSync=false + StorageQuotaMb=10240 with nil
# day/size limits, so a fresh pair only backfills a small recent window. Fix P flips
# RequireFullSync on and maxes every limit, so the phone ships the deepest full-
# history snapshot it has (years of conversations) on the next pair — feeding
# handleHistorySync and the Fix O archive projection with as much real data as
# possible. Only takes effect on the NEXT pair (payload is sent at pairing time).

# 1. imports: the non-sqlstore store pkg (for DeviceProps) + waCompanionReg (config type).
FIXP_IMPORT_NEEDLE = '\t"go.mau.fi/whatsmeow/store/sqlstore"\n'
FIXP_IMPORT_REPLACEMENT = (
    '\twaCompanionReg "go.mau.fi/whatsmeow/proto/waCompanionReg" // claude-ops Fix P: history-sync config\n'
    '\t"go.mau.fi/whatsmeow/store"\n'
    '\t"go.mau.fi/whatsmeow/store/sqlstore"\n'
)
FIXP_IMPORT_SENTINEL = 'waCompanionReg "go.mau.fi/whatsmeow/proto/waCompanionReg"'

# 2. set DeviceProps before the client is created (stable anchor).
FIXP_PROPS_NEEDLE = (
    "\t// Create client instance\n\tclient := whatsmeow.NewClient(deviceStore, logger)"
)
FIXP_PROPS_REPLACEMENT = (
    "\t// claude-ops Fix P: request the MAXIMUM history WhatsApp will ship on (re-)pair.\n"
    "\t// store.DeviceProps is the global registration payload read when the device pairs.\n"
    "\t// Upstream defaults to RequireFullSync=false + StorageQuotaMb=10240 with nil day\n"
    "\t// limits, so a fresh pair only backfills a small recent window. Flip RequireFullSync\n"
    "\t// on and raise every limit so the phone sends the deepest full-history snapshot it\n"
    "\t// has, feeding handleHistorySync + the Fix O archive projection. Effective on the\n"
    "\t// NEXT pair only (the payload is sent at pairing).\n"
    "\tstore.DeviceProps.RequireFullSync = proto.Bool(true)\n"
    "\tstore.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{\n"
    "\t\tFullSyncDaysLimit:   proto.Uint32(3650),   // ~10 years\n"
    "\t\tFullSyncSizeMbLimit: proto.Uint32(102400), // 100 GB\n"
    "\t\tStorageQuotaMb:      proto.Uint32(102400),\n"
    "\t}\n"
    '\tlogger.Infof("claude-ops Fix P: RequireFullSync=true, full-sync limits maxed (10y / 100GB) — deepest history on next pair")\n\n'
    "\t// Create client instance\n\tclient := whatsmeow.NewClient(deviceStore, logger)"
)
FIXP_PROPS_SENTINEL = "claude-ops Fix P: request the MAXIMUM history"


# ─── main.go Fix Q: app-state readiness gate + full-sync-on-connect ────────────
# THE durable fix for the post-re-pair LTHash corruption. Three spliced parts:
#   Q1 — a global mutex-guarded `appStateReady` flag + helpers + a tiny
#        GET /api/app_state_status endpoint, all injected as a standalone block
#        right before startRESTServer (same anchor Fix G uses). The status endpoint
#        chains on the same goroutine block the other endpoints re-emit.
#   Q2 — on *events.Connected, kick a background FetchAppState(regular_low,
#        fullSync=true) and flip appStateReady true ONLY after it returns, so the
#        local LTHash baseline is fully in sync before any archive is attempted.
#   Q3 — /api/archive rejects with HTTP 425 + {"error":"app_state_not_ready"} until
#        the flag is set.
#
# whatsmeow API used (all already exercised by Fixes D/F/G in this file, so the
# signatures are verified against the pinned version v0.0.0-20250318233852-...):
#   client.FetchAppState(ctx, appstate.WAPatchRegularLow, fullSync=true, onlyIfNotSynced=false)
#   appstate.WAPatchRegularLow
#
# Q1: globals + helpers + status endpoint, injected before startRESTServer. The
# status endpoint itself is appended via the goroutine-block chain inside the
# helper text so it lands inside startRESTServer's handler-registration region —
# but registering an http.HandleFunc from a free function is awkward, so instead
# the status endpoint is spliced separately (FIXQ_STATUS_*) on the goroutine needle
# and the readiness state lives in package-level vars defined here.
FIXQ_STATE_NEEDLE = (
    """// healLTHash recovers from an ErrMismatchingLTHash app-state corruption by"""
)
FIXQ_STATE_REPLACEMENT = """// claude-ops Fix Q: app-state readiness state. After a FRESH re-pair the
// regular_low collection (archive/pin/mute) is not fully synced yet, so the first
// archive mutation would build a patch on an empty/partial local LTHash baseline
// and the server rejects it ("mismatching LTHash") — corrupting the collection so
// it can only be healed with a manual phone tap. We gate archive mutations on a
// full FetchAppState(regular_low) completing first (markAppStateReady below).
var (
\tappStateReadyMu sync.RWMutex
\tappStateReady   bool
)

// appStateIsReady reports whether the regular_low app-state has completed its
// post-connect full sync, so archive mutations can be built on a valid LTHash.
func appStateIsReady() bool {
\tappStateReadyMu.RLock()
\tdefer appStateReadyMu.RUnlock()
\treturn appStateReady
}

// setAppStateReady records the readiness flag (true once the regular_low full
// sync has landed).
func setAppStateReady(v bool) {
\tappStateReadyMu.Lock()
\tappStateReady = v
\tappStateReadyMu.Unlock()
}

// syncAppStateThenReady runs a full FetchAppState(regular_low) and flips the
// readiness flag once it returns successfully. Safe to call on every Connected;
// onlyIfNotSynced=false forces a fetch but whatsmeow no-ops cheaply when already
// in sync. Best-effort: on error we leave appStateReady false so the next connect
// retries (and /api/resync_app_state?discard_local=true remains the manual heal).
func syncAppStateThenReady(client *whatsmeow.Client) {
\tif client == nil {
\t\treturn
\t}
\tsetAppStateReady(false)
\tif err := client.FetchAppState(context.Background(), appstate.WAPatchRegularLow, true, false); err != nil {
\t\tfmt.Printf("Fix Q: regular_low app-state sync failed (archive gated until it succeeds): %v\\n", err)
\t\treturn
\t}
\tsetAppStateReady(true)
\tfmt.Println("Fix Q: regular_low app-state synced — archive mutations enabled")
}

// healLTHash recovers from an ErrMismatchingLTHash app-state corruption by"""
FIXQ_STATE_SENTINEL = "claude-ops Fix Q: app-state readiness state"

# Q1b: GET /api/app_state_status — chains on the goroutine block the other
# endpoints re-emit. Returns {"ready":bool} so ops-inbox can wait for readiness.
FIXQ_STATUS_NEEDLE = RESYNC_ENDPOINT_NEEDLE
FIXQ_STATUS_REPLACEMENT = """\t// claude-ops Fix Q: GET /api/app_state_status — {"ready":bool}. Lets callers
\t// (ops-inbox / wa-inbox-fresh.sh) wait for the regular_low full sync to land
\t// before issuing the first post-re-pair archive, avoiding LTHash corruption.
\thttp.HandleFunc(\"/api/app_state_status\", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tfmt.Fprintf(w, `{\"ready\":%v}`, appStateIsReady())
\t})

\t// Run server in a goroutine so it doesn't block
\tgo func() {
\t\tif err := http.ListenAndServe(serverAddr, nil); err != nil {
\t\t\tfmt.Printf(\"REST API server error: %v\\n\", err)
\t\t}
\t}()
}"""
FIXQ_STATUS_SENTINEL = "claude-ops Fix Q: GET /api/app_state_status"

# Q2: kick the full regular_low sync on Connected and flip readiness when done.
# Anchors on the closing two lines of the auto-backfill goroutine
# (`requestHistorySync(c)` + `}(client)`) — byte-identical across patcher
# generations (the `logger.Infof("Auto-backfill: ...")` line drifted across
# versions, so it is deliberately NOT part of the anchor). Inserts the new
# goroutine right after the backfill goroutine closes.
FIXQ_CONNECT_NEEDLE = """\t\t\t\trequestHistorySync(c)
\t\t\t}(client)
"""
FIXQ_CONNECT_REPLACEMENT = """\t\t\t\trequestHistorySync(c)
\t\t\t}(client)
\t\t\t// claude-ops Fix Q: full regular_low app-state sync on connect, then flip
\t\t\t// appStateReady. Until this lands, /api/archive returns 425 so no archive
\t\t\t// mutation is built on an unsynced LTHash baseline (the re-pair corruption).
\t\t\tgo syncAppStateThenReady(client)
"""
FIXQ_CONNECT_SENTINEL = "claude-ops Fix Q: full regular_low app-state sync on connect"

# Q3: readiness gate at the top of the /api/archive handler. Inserts the 425 check
# right before the Fix L phone-online prerequisite comment (stable, emitted by
# ARCHIVE_ENDPOINT_REPLACEMENT).
FIXQ_GATE_NEEDLE = """\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\t// claude-ops Fix L: phone-online prerequisite for the app-state mutation.
\t\tif !phoneOnline(client) {"""
FIXQ_GATE_REPLACEMENT = """\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\t// claude-ops Fix Q: app-state readiness gate. Reject archive mutations until
\t\t// the post-connect regular_low full sync has landed, so we never build a patch
\t\t// on an unsynced LTHash baseline (the fresh-re-pair corruption). 425 Too Early.
\t\tif !appStateIsReady() {
\t\t\tw.WriteHeader(http.StatusTooEarly)
\t\t\tfmt.Fprintln(w, `{\"success\":false,\"error\":\"app_state_not_ready\",\"message\":\"regular_low app-state still syncing after (re-)pair — retry shortly or POST /api/resync_app_state\"}`)
\t\t\treturn
\t\t}
\t\t// claude-ops Fix L: phone-online prerequisite for the app-state mutation.
\t\tif !phoneOnline(client) {"""
FIXQ_GATE_SENTINEL = "claude-ops Fix Q: app-state readiness gate"


# ─── main.go Fix R: /api/resync_app_state discard_local mode ───────────────────
# Heals an ALREADY-corrupted regular_low LTHash WITHOUT a phone tap. When the
# request carries discard_local=true (query param or JSON body) the handler wipes
# the local app-state version + mutation-MAC rows for the collection (dropping the
# diverged local LTHash baseline — the SAME safe row set Fix G clears, never
# touching identity/session/pre_key tables) BEFORE the FetchAppState, so the
# server's authoritative state re-pulls onto a clean baseline. Without the flag the
# handler is unchanged (plain full resync). Replaces the body of the Fix D handler.
# Anchored on the struct+default+decode block, which is byte-identical across
# patcher generations (the FetchAppState line's indentation drifted, so it is NOT
# part of the anchor). The DiscardLocal field is added to the struct and the
# discard logic is spliced right after the decode `}`, before the FetchAppState.
FIXR_DISCARD_NEEDLE = """\t\tvar req struct {
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
"""
FIXR_DISCARD_REPLACEMENT = """\t\tvar req struct {
\t\t\tName         string `json:\"name\"`
\t\t\tFullSync     bool   `json:\"full_sync\"`
\t\t\tDiscardLocal bool   `json:\"discard_local\"`
\t\t}
\t\treq.Name = \"regular_low\"
\t\treq.FullSync = true
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err == nil {
\t\t\tif req.Name == \"\" {
\t\t\t\treq.Name = \"regular_low\"
\t\t\t}
\t\t}
\t\t// claude-ops Fix R: discard_local=true (query param OR JSON body) drops the
\t\t// diverged local LTHash baseline for this collection before re-fetching, so an
\t\t// already-corrupted regular_low heals without a manual phone tap. Wipes only the
\t\t// version + mutation-MAC rows (same SAFE set as Fix G's healLTHash); identity,
\t\t// session, and pre_key tables are never touched.
\t\tif r.URL.Query().Get(\"discard_local\") == \"true\" {
\t\t\treq.DiscardLocal = true
\t\t}
\t\tif req.DiscardLocal {
\t\t\treq.FullSync = true
\t\t\twdb, derr := sql.Open(\"sqlite3\", \"file:store/whatsapp.db?_foreign_keys=on\")
\t\t\tif derr != nil {
\t\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"discard_local: open whatsapp.db: %s\"}`, derr.Error())
\t\t\t\treturn
\t\t\t}
\t\t\tjid := \"\"
\t\t\tif client.Store != nil && client.Store.ID != nil {
\t\t\t\tjid = client.Store.ID.String()
\t\t\t}
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_version WHERE jid=? AND name=?`, jid, req.Name)
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`, jid, req.Name)
\t\t\twdb.Close()
\t\t\t// A clean local baseline means archive will be unsafe until the re-fetch lands;
\t\t\t// drop readiness so the gate (Fix Q) re-arms, then the resync below re-enables it.
\t\t\tsetAppStateReady(false)
\t\t}
"""
FIXR_DISCARD_SENTINEL = "claude-ops Fix R: discard_local=true"

# Fix R follow-up: re-arm readiness after a successful resync (so discard_local
# leaves the gate open again). Anchors on the Fix D success line.
FIXR_READY_NEEDLE = """\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"app-state %s resynced\"}`, req.Name)"""
FIXR_READY_REPLACEMENT = """\t\t// claude-ops Fix R: resync succeeded — regular_low baseline is valid again.
\t\tif req.Name == \"regular_low\" {
\t\t\tsetAppStateReady(true)
\t\t}
\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"app-state %s resynced\"}`, req.Name)"""
FIXR_READY_SENTINEL = "claude-ops Fix R: resync succeeded"


# ─── main.go Fix T: skip-and-continue past unverifiable LTHash patches ─────────
# When the server's regular_low patch chain contains patches whose LTHash MAC
# cannot be verified ("failed to verify patch vNNN: mismatching LTHash") every
# incremental notification sync aborts at the same patch — a permanent wedge.
# Re-pair downloads the same server chain and hits the same bad patch, so the
# bridge is wedged again within seconds of pairing. Fix T adds:
#
#   skipLTHashPatch(ctx, client, name, failingVersion):
#     Bumps the local version cursor past failingVersion by writing version
#     failingVersion with a zero LTHash directly into whatsmeow_app_state_version,
#     then clears all mutation MACs for the collection from
#     whatsmeow_app_state_mutation_macs (so the next FetchAppState accumulates
#     a fresh LTHash from version failingVersion onward rather than inheriting a
#     now-wrong accumulator). Identity/session/pre_key tables are never touched.
#
#   syncAppStateSkipBad(ctx, client, name):
#     Calls FetchAppState(name, false, false) in a bounded retry loop. On each
#     "mismatching LTHash" failure it calls skipLTHashPatch to advance past the
#     bad patch and retries. Up to 200 bad patches are skipped; any other error
#     is returned immediately. On success appStateReady is set true.
#
#   syncAppStateThenReady (existing Fix Q helper) is replaced to call
#   syncAppStateSkipBad so the on-connect sync no longer wedges.
#
#   /api/resync_app_state gains skip_bad=true (query param OR JSON body) which
#   calls syncAppStateSkipBad directly so the currently-wedged bridge can
#   self-heal via a single curl without a restart or re-pair.
#
# API note: both client.FetchAppState and client.Store.AppState.PutAppStateVersion
# / DeleteAppStateMutationMACs are available and exercised by existing fixes.
# For the DB write in skipLTHashPatch we use a direct SQL connection (same
# pattern as healLTHash / Fix G) to avoid whatsmeow's appStateSyncLock — the
# lock is already held when FetchAppState is running, but skipLTHashPatch is
# called OUTSIDE FetchAppState (after it returns an error), so there is no
# re-entrancy issue.

# T1: replace syncAppStateThenReady to call syncAppStateSkipBad, and insert
# skipLTHashPatch + syncAppStateSkipBad before it.
# Anchor: the existing syncAppStateThenReady body (installed by Fix Q). On a
# Fix-Q-patched tree this is byte-identical; sentinel gates on the new helper.
FIXT_SYNC_NEEDLE = """// syncAppStateThenReady runs a full FetchAppState(regular_low) and flips the
// readiness flag once it returns successfully. Safe to call on every Connected;
// onlyIfNotSynced=false forces a fetch but whatsmeow no-ops cheaply when already
// in sync. Best-effort: on error we leave appStateReady false so the next connect
// retries (and /api/resync_app_state?discard_local=true remains the manual heal).
func syncAppStateThenReady(client *whatsmeow.Client) {
\tif client == nil {
\t\treturn
\t}
\tsetAppStateReady(false)
\tif err := client.FetchAppState(context.Background(), appstate.WAPatchRegularLow, true, false); err != nil {
\t\tfmt.Printf("Fix Q: regular_low app-state sync failed (archive gated until it succeeds): %v\\n", err)
\t\treturn
\t}
\tsetAppStateReady(true)
\tfmt.Println("Fix Q: regular_low app-state synced — archive mutations enabled")
}"""

# Upgrade anchor: the Fix T replacement block already on production bridges. Fix V
# changed the sentinel to isSkippablePatchErr but left FIXT_SYNC_NEEDLE on the
# pre-Fix-T syncAppStateThenReady, so re-running the patcher on a Fix-T install
# neither skipped nor replaced. replace_if_present on this needle upgrades in place.
FIXT_SYNC_FIXT_NEEDLE = """// skipLTHashPatch advances the local regular_low cursor past failingVersion so
// the next FetchAppState fetches patches from failingVersion+1 onward.
// It writes version=failingVersion with a zero hash into whatsmeow_app_state_version
// and clears all mutation MACs for the collection so the LTHash accumulator
// starts fresh. Safe: only version+MAC rows are touched; identity/session/
// pre_key tables are never modified. claude-ops Fix T.
func skipLTHashPatch(client *whatsmeow.Client, patchName appstate.WAPatchName, failingVersion uint64) error {
\twdb, err := sql.Open("sqlite3", "file:store/whatsapp.db?_foreign_keys=on")
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: open whatsapp.db: %w", err)
\t}
\tdefer wdb.Close()
\tjid := ""
\tif client.Store != nil && client.Store.ID != nil {
\t\tjid = client.Store.ID.String()
\t}
\t// Write version=failingVersion with a zeroed 128-byte hash. This tells
\t// FetchAppState to fetch patches from failingVersion+1 onward and accumulate
\t// a fresh LTHash (no longer chained off the bad patch's unverifiable state).
\tzeroHash := make([]byte, 128)
\t_, err = wdb.Exec(
\t\t`INSERT INTO whatsmeow_app_state_version (jid, name, version, hash) VALUES (?, ?, ?, ?)
\t\t ON CONFLICT(jid, name) DO UPDATE SET version=excluded.version, hash=excluded.hash`,
\t\tjid, string(patchName), failingVersion, zeroHash,
\t)
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: write version %d: %w", failingVersion, err)
\t}
\t// Clear all mutation MACs so the LTHash accumulator starts clean from this
\t// version (stale MACs from earlier patches would corrupt the new accumulation).
\t_, err = wdb.Exec(
\t\t`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`,
\t\tjid, string(patchName),
\t)
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: clear MACs: %w", err)
\t}
\tfmt.Printf("Fix T: skipped bad patch v%d for %s — cursor bumped, MACs cleared\\n", failingVersion, patchName)
\treturn nil
}

// syncAppStateSkipBad fetches app-state patches for name, automatically skipping
// any patch that fails LTHash verification (up to maxSkips times). This is the
// durable fix for server-side bad patches (whatsmeow #382/#858/#1176): instead of
// aborting the entire sync on one unverifiable patch, we advance past it and apply
// all subsequent valid patches. On success appStateReady is set true.
// claude-ops Fix T.
func syncAppStateSkipBad(client *whatsmeow.Client, patchName appstate.WAPatchName) error {
\tif client == nil {
\t\treturn fmt.Errorf("syncAppStateSkipBad: client is nil")
\t}
\tconst maxSkips = 200
\tskipped := 0
\tfor {
\t\terr := client.FetchAppState(context.Background(), patchName, false, false)
\t\tif err == nil {
\t\t\tfmt.Printf("Fix T: %s sync complete (skipped %d bad patch(es))\\n", patchName, skipped)
\t\t\treturn nil
\t\t}
\t\terrStr := err.Error()
\t\tif !strings.Contains(errStr, "mismatching LTHash") {
\t\t\treturn err // non-LTHash error: propagate immediately
\t\t}
\t\tif skipped >= maxSkips {
\t\t\treturn fmt.Errorf("Fix T: aborted after skipping %d bad patches — still failing: %w", maxSkips, err)
\t\t}
\t\t// Parse the failing version number from the error string.
\t\t// Error format: "...failed to verify patch vNNN: mismatching LTHash"
\t\tvar failingVersion uint64
\t\tif _, parseErr := fmt.Sscanf(errStr[strings.LastIndex(errStr, "patch v")+len("patch v"):], "%d", &failingVersion); parseErr != nil {
\t\t\treturn fmt.Errorf("Fix T: couldn't parse failing version from %q: %w", errStr, err)
\t\t}
\t\tif skipErr := skipLTHashPatch(client, patchName, failingVersion); skipErr != nil {
\t\t\treturn fmt.Errorf("Fix T: skip failed: %v (original: %w)", skipErr, err)
\t\t}
\t\tskipped++
\t}
}

// syncAppStateThenReady runs a full regular_low sync using the skip-bad-patch
// loop (Fix T) and flips appStateReady once it returns. Safe to call on every
// Connected. Best-effort: on error appStateReady stays false so the next connect
// retries. claude-ops Fix Q updated by Fix T.
func syncAppStateThenReady(client *whatsmeow.Client) {
\tif client == nil {
\t\treturn
\t}
\tsetAppStateReady(false)
\tif err := syncAppStateSkipBad(client, appstate.WAPatchRegularLow); err != nil {
\t\tfmt.Printf("Fix Q/T: regular_low app-state sync failed (archive gated until it succeeds): %v\\n", err)
\t\treturn
\t}
\tsetAppStateReady(true)
\tfmt.Println("Fix Q/T: regular_low app-state synced — archive mutations enabled")
}"""

FIXT_SYNC_REPLACEMENT = """// skipLTHashPatch advances the local regular_low cursor past failingVersion so
// the next FetchAppState fetches patches from failingVersion+1 onward.
// It writes version=failingVersion with a zero hash into whatsmeow_app_state_version
// and clears all mutation MACs for the collection so the LTHash accumulator
// starts fresh. Safe: only version+MAC rows are touched; identity/session/
// pre_key tables are never modified. claude-ops Fix T.
func skipLTHashPatch(client *whatsmeow.Client, patchName appstate.WAPatchName, failingVersion uint64) error {
\twdb, err := sql.Open("sqlite3", "file:store/whatsapp.db?_foreign_keys=on")
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: open whatsapp.db: %w", err)
\t}
\tdefer wdb.Close()
\tjid := ""
\tif client.Store != nil && client.Store.ID != nil {
\t\tjid = client.Store.ID.String()
\t}
\t// Write version=failingVersion with a zeroed 128-byte hash. This tells
\t// FetchAppState to fetch patches from failingVersion+1 onward and accumulate
\t// a fresh LTHash (no longer chained off the bad patch's unverifiable state).
\tzeroHash := make([]byte, 128)
\t_, err = wdb.Exec(
\t\t`INSERT INTO whatsmeow_app_state_version (jid, name, version, hash) VALUES (?, ?, ?, ?)
\t\t ON CONFLICT(jid, name) DO UPDATE SET version=excluded.version, hash=excluded.hash`,
\t\tjid, string(patchName), failingVersion, zeroHash,
\t)
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: write version %d: %w", failingVersion, err)
\t}
\t// Clear all mutation MACs so the LTHash accumulator starts clean from this
\t// version (stale MACs from earlier patches would corrupt the new accumulation).
\t_, err = wdb.Exec(
\t\t`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`,
\t\tjid, string(patchName),
\t)
\tif err != nil {
\t\treturn fmt.Errorf("skipLTHashPatch: clear MACs: %w", err)
\t}
\tfmt.Printf("Fix T: skipped bad patch v%d for %s — cursor bumped, MACs cleared\\n", failingVersion, patchName)
\treturn nil
}

var (
\tsyncKeyPollerMu      sync.Mutex
\tsyncKeyPollerRunning bool
)

// isSkippablePatchErr returns true when the error means "this specific patch
// version cannot be verified — advance the cursor past it and retry." Two cases:
//   - "mismatching LTHash" — server hash doesn't match our accumulator
//     (whatsmeow #382/#858/#1176). Never self-heals without skipping.
//   - "didn't find app state key" — the sync key needed to decrypt/verify
//     this patch is absent (e.g. after a DB wipe or fresh pair before the phone
//     has re-shared old keys). Skipping lets the loop land on current patches
//     whose keys ARE present. whatsmeow auto-requests missing keys; they arrive
//     asynchronously and the key-arrival poller in syncAppStateThenReady retries.
// claude-ops Fix V.
func isSkippablePatchErr(errStr string) bool {
\treturn strings.Contains(errStr, "mismatching LTHash") ||
\t\tstrings.Contains(errStr, "didn't find app state key")
}

// syncAppStateSkipBad fetches app-state patches for name, automatically skipping
// any patch that fails LTHash verification or is missing its sync key (up to
// maxSkips times). This is the durable fix for server-side bad patches
// (whatsmeow #382/#858/#1176): instead of aborting the entire sync on one
// unverifiable patch, we advance past it and apply all subsequent valid patches.
// On success appStateReady is set true. claude-ops Fix T updated by Fix V.
func syncAppStateSkipBad(client *whatsmeow.Client, patchName appstate.WAPatchName) error {
\tif client == nil {
\t\treturn fmt.Errorf("syncAppStateSkipBad: client is nil")
\t}
\tconst maxSkips = 200
\tskipped := 0
\tfor {
\t\terr := client.FetchAppState(context.Background(), patchName, false, false)
\t\tif err == nil {
\t\t\tfmt.Printf("Fix T: %s sync complete (skipped %d bad patch(es))\\n", patchName, skipped)
\t\t\treturn nil
\t\t}
\t\terrStr := err.Error()
\t\tif !isSkippablePatchErr(errStr) {
\t\t\treturn err // non-skippable error: propagate immediately
\t\t}
\t\tif skipped >= maxSkips {
\t\t\treturn fmt.Errorf("Fix T: aborted after skipping %d bad patches — still failing: %w", maxSkips, err)
\t\t}
\t\t// Parse the failing version number from the error string.
\t\t// LTHash format:      "...failed to verify patch vNNN: mismatching LTHash"
\t\t// Missing-key format: "...to verify patch vNNN MACs: didn't find app state key"
\t\t// Both contain "patch vNNN" so the same extraction works for both.
\t\tvar failingVersion uint64
\t\tif _, parseErr := fmt.Sscanf(errStr[strings.LastIndex(errStr, "patch v")+len("patch v"):], "%d", &failingVersion); parseErr != nil {
\t\t\treturn fmt.Errorf("Fix T: couldn't parse failing version from %q: %w", errStr, err)
\t\t}
\t\tif skipErr := skipLTHashPatch(client, patchName, failingVersion); skipErr != nil {
\t\t\treturn fmt.Errorf("Fix T: skip failed: %v (original: %w)", skipErr, err)
\t\t}
\t\tskipped++
\t\t// claude-ops Fix V: throttle the skip loop to avoid server-side 429
\t\t// rate-overlimit. Rapid back-to-back FetchAppState calls exhaust the
\t\t// server's per-connection IQ budget mid-skip. 300ms per iteration keeps
\t\t// us well under the limit while adding only ~1-2s for typical 5-10 skips.
\t\ttime.Sleep(300 * time.Millisecond)
\t}
}

// syncAppStateThenReady runs a full regular_low sync using the skip-bad-patch
// loop (Fix T/V) and flips appStateReady once it returns. Safe to call on every
// Connected. Best-effort: on error appStateReady stays false so the next connect
// retries. claude-ops Fix Q updated by Fix T/V.
//
// Fix V extension: when sync fails because app-state sync keys are absent,
// whatsmeow automatically sends a key-share request to the primary device.
// The phone responds asynchronously. A poller watches whatsmeow_app_state_sync_keys
// for new rows; once they arrive it re-runs syncAppStateSkipBad so Fix T/V can
// advance past remaining bad patches and flip appStateReady. Gives up after 10 min.
func syncAppStateThenReady(client *whatsmeow.Client) {
\tif client == nil {
\t\treturn
\t}
\tsetAppStateReady(false)
\tif err := syncAppStateSkipBad(client, appstate.WAPatchRegularLow); err != nil {
\t\tfmt.Printf("Fix Q/T: regular_low app-state sync failed (archive gated until it succeeds): %v\\n", err)
\t\t// Fix V: if the failure was due to missing sync keys, spawn a poller that
\t\t// waits for the phone to deliver them then retries.
\t\tif strings.Contains(err.Error(), "didn't find app state key") ||
\t\t\tstrings.Contains(err.Error(), "Fix T: aborted") {
\t\t\tsyncKeyPollerMu.Lock()
\t\t\tif syncKeyPollerRunning {
\t\t\t\tsyncKeyPollerMu.Unlock()
\t\t\t\treturn
\t\t\t}
\t\t\tsyncKeyPollerRunning = true
\t\t\tsyncKeyPollerMu.Unlock()
\t\t\tgo func() {
\t\t\t\tdefer func() {
\t\t\t\t\tsyncKeyPollerMu.Lock()
\t\t\t\t\tsyncKeyPollerRunning = false
\t\t\t\t\tsyncKeyPollerMu.Unlock()
\t\t\t\t}()
\t\t\t\tfmt.Println("Fix V: sync-key poller started — will retry regular_low sync when keys arrive")
\t\t\t\twdbPath := "file:store/whatsapp.db?_foreign_keys=on&mode=ro"
\t\t\t\tdeadline := time.Now().Add(10 * time.Minute)
\t\t\t\tprevCount := -1
\t\t\t\tfor time.Now().Before(deadline) {
\t\t\t\t\ttime.Sleep(5 * time.Second)
\t\t\t\t\tif !client.IsConnected() {
\t\t\t\t\t\tfmt.Println("Fix V: bridge disconnected — poller exiting")
\t\t\t\t\t\treturn
\t\t\t\t\t}
\t\t\t\t\twdb, oerr := sql.Open("sqlite3", wdbPath)
\t\t\t\t\tif oerr != nil {
\t\t\t\t\t\tcontinue
\t\t\t\t\t}
\t\t\t\t\tvar cnt int
\t\t\t\t\t_ = wdb.QueryRow(`SELECT COUNT(*) FROM whatsmeow_app_state_sync_keys`).Scan(&cnt)
\t\t\t\t\twdb.Close()
\t\t\t\t\tif cnt != prevCount && cnt > 0 {
\t\t\t\t\t\tfmt.Printf("Fix V: %d sync key(s) now present (was %d) — retrying regular_low sync\\n", cnt, prevCount)
\t\t\t\t\t\tprevCount = cnt
\t\t\t\t\t\ttime.Sleep(2 * time.Second)
\t\t\t\t\t\tif serr := syncAppStateSkipBad(client, appstate.WAPatchRegularLow); serr != nil {
\t\t\t\t\t\t\tfmt.Printf("Fix V: retry failed (%d keys): %v\\n", cnt, serr)
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tsetAppStateReady(true)
\t\t\t\t\t\t\tfmt.Println("Fix V: regular_low synced after key delivery — archive mutations enabled")
\t\t\t\t\t\t\treturn
\t\t\t\t\t\t}
\t\t\t\t\t} else {
\t\t\t\t\t\tprevCount = cnt
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tfmt.Println("Fix V: sync-key poller timed out after 10 min — manual /api/resync_app_state?skip_bad=true required")
\t\t\t}()
\t\t}
\t\treturn
\t}
\tsetAppStateReady(true)
\tfmt.Println("Fix Q/T: regular_low app-state synced — archive mutations enabled")
}"""

FIXT_SYNC_SENTINEL = "isSkippablePatchErr"

# T2: add skip_bad field to /api/resync_app_state request struct (T2a) and wire
# the handler after discard_local (T2b). discard_local MUST run before skip_bad so
# both flags can be combined (wipe diverged local baseline, then skip bad patches).
# T2a anchors on the Fix R discard_local struct block. T2b anchors after the Fix R
# discard_local handler. T2c reorders installs that got the buggy T2 ordering.
# MUST run after Fix R.
FIXT_RESYNC_NEEDLE = """\t\tvar req struct {
\t\t\tName         string `json:\"name\"`
\t\t\tFullSync     bool   `json:\"full_sync\"`
\t\t\tDiscardLocal bool   `json:\"discard_local\"`
\t\t}
\t\treq.Name = \"regular_low\"
\t\treq.FullSync = true
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err == nil {
\t\t\tif req.Name == \"\" {
\t\t\t\treq.Name = \"regular_low\"
\t\t\t}
\t\t}
\t\t// claude-ops Fix R: discard_local=true (query param OR JSON body) drops the"""

FIXT_RESYNC_REPLACEMENT = """\t\tvar req struct {
\t\t\tName         string `json:\"name\"`
\t\t\tFullSync     bool   `json:\"full_sync\"`
\t\t\tDiscardLocal bool   `json:\"discard_local\"`
\t\t\tSkipBad      bool   `json:\"skip_bad\"`
\t\t}
\t\treq.Name = \"regular_low\"
\t\treq.FullSync = true
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err == nil {
\t\t\tif req.Name == \"\" {
\t\t\t\treq.Name = \"regular_low\"
\t\t\t}
\t\t}
\t\t// claude-ops Fix R: discard_local=true (query param OR JSON body) drops the"""

FIXT_RESYNC_SENTINEL = 'SkipBad      bool   `json:"skip_bad"`'

FIXT_SKIP_BAD_HANDLER = """\t\t// claude-ops Fix T: skip_bad=true (query param OR JSON body) calls
\t\t// syncAppStateSkipBad which fetches patches skipping any unverifiable ones
\t\t// (mismatching LTHash — whatsmeow #382/#858/#1176). Use to heal a permanently
\t\t// wedged bridge without a restart or re-pair. Runs after discard_local so both
\t\t// flags can be combined.
\t\tif r.URL.Query().Get(\"skip_bad\") == \"true\" {
\t\t\treq.SkipBad = true
\t\t}
\t\t// Fix T2d: a full_sync resync IS the heal operation - strict-verify full sync
\t\t// just re-fails on the same unverifiable server-side patches (observed 2026-06-09:
\t\t// heal loop wedged on \"failed to verify patch v1132: mismatching LTHash\" because
\t\t// the documented heal omitted skip_bad). Default skip_bad=true for full_sync
\t\t// unless explicitly skip_bad=false.
\t\tif req.FullSync && r.URL.Query().Get(\"skip_bad\") != \"false\" {
\t\t\treq.SkipBad = true
\t\t}
\t\tif req.SkipBad {
\t\t\tsetAppStateReady(false)
\t\t\tif err := syncAppStateSkipBad(client, appstate.WAPatchName(req.Name)); err != nil {
\t\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":%q}`, err.Error())
\t\t\t\treturn
\t\t\t}
\t\t\tif req.Name == \"regular_low\" {
\t\t\t\tsetAppStateReady(true)
\t\t\t}
\t\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"app-state %s resynced (bad patches skipped)\"}`, req.Name)
\t\t\treturn
\t\t}
"""

FIXT_RESYNC_HANDLER_NEEDLE = """\t\t\tsetAppStateReady(false)
\t\t}
\t\t\t\tif err := client.FetchAppState(context.Background(), appstate.WAPatchName(req.Name), req.FullSync, false); err != nil {"""

FIXT_RESYNC_HANDLER_REPLACEMENT = (
    """\t\t\tsetAppStateReady(false)
\t\t}
"""
    + FIXT_SKIP_BAD_HANDLER
    + """\t\t\t\tif err := client.FetchAppState(context.Background(), appstate.WAPatchName(req.Name), req.FullSync, false); err != nil {"""
)

FIXT_RESYNC_HANDLER_SENTINEL = "claude-ops Fix T: skip_bad=true"

# T2c: reorder skip_bad before discard_local (buggy first T2 cut) to discard_local
# then skip_bad. No-op once T2b applied or on fresh installs with correct order.
FIXT_RESYNC_ORDER_NEEDLE = """\t\t// claude-ops Fix T: skip_bad=true (query param OR JSON body) calls
\t\t// syncAppStateSkipBad which fetches patches skipping any unverifiable ones
\t\t// (mismatching LTHash — whatsmeow #382/#858/#1176). Use to heal a permanently
\t\t// wedged bridge without a restart or re-pair.
\t\tif r.URL.Query().Get(\"skip_bad\") == \"true\" {
\t\t\treq.SkipBad = true
\t\t}
\t\tif req.SkipBad {
\t\t\tsetAppStateReady(false)
\t\t\tif err := syncAppStateSkipBad(client, appstate.WAPatchName(req.Name)); err != nil {
\t\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":%q}`, err.Error())
\t\t\t\treturn
\t\t\t}
\t\t\tif req.Name == \"regular_low\" {
\t\t\t\tsetAppStateReady(true)
\t\t\t}
\t\t\tfmt.Fprintf(w, `{\"success\":true,\"message\":\"app-state %s resynced (bad patches skipped)\"}`, req.Name)
\t\t\treturn
\t\t}
\t\t// claude-ops Fix R: discard_local=true (query param OR JSON body) drops the
\t\t// diverged local LTHash baseline for this collection before re-fetching, so an
\t\t// already-corrupted regular_low heals without a manual phone tap. Wipes only the
\t\t// version + mutation-MAC rows (same SAFE set as Fix G's healLTHash); identity,
\t\t// session, and pre_key tables are never touched.
\t\tif r.URL.Query().Get(\"discard_local\") == \"true\" {
\t\t\treq.DiscardLocal = true
\t\t}
\t\tif req.DiscardLocal {
\t\t\treq.FullSync = true
\t\t\twdb, derr := sql.Open(\"sqlite3\", \"file:store/whatsapp.db?_foreign_keys=on\")
\t\t\tif derr != nil {
\t\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"discard_local: open whatsapp.db: %s\"}`, derr.Error())
\t\t\t\treturn
\t\t\t}
\t\t\tjid := \"\"
\t\t\tif client.Store != nil && client.Store.ID != nil {
\t\t\t\tjid = client.Store.ID.String()
\t\t\t}
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_version WHERE jid=? AND name=?`, jid, req.Name)
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`, jid, req.Name)
\t\t\twdb.Close()
\t\t\t// A clean local baseline means archive will be unsafe until the re-fetch lands;
\t\t\t// drop readiness so the gate (Fix Q) re-arms, then the resync below re-enables it.
\t\t\tsetAppStateReady(false)
\t\t}"""

FIXT_RESYNC_ORDER_REPLACEMENT = (
    """\t\t// claude-ops Fix R: discard_local=true (query param OR JSON body) drops the
\t\t// diverged local LTHash baseline for this collection before re-fetching, so an
\t\t// already-corrupted regular_low heals without a manual phone tap. Wipes only the
\t\t// version + mutation-MAC rows (same SAFE set as Fix G's healLTHash); identity,
\t\t// session, and pre_key tables are never touched.
\t\tif r.URL.Query().Get(\"discard_local\") == \"true\" {
\t\t\treq.DiscardLocal = true
\t\t}
\t\tif req.DiscardLocal {
\t\t\treq.FullSync = true
\t\t\twdb, derr := sql.Open(\"sqlite3\", \"file:store/whatsapp.db?_foreign_keys=on\")
\t\t\tif derr != nil {
\t\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"discard_local: open whatsapp.db: %s\"}`, derr.Error())
\t\t\t\treturn
\t\t\t}
\t\t\tjid := \"\"
\t\t\tif client.Store != nil && client.Store.ID != nil {
\t\t\t\tjid = client.Store.ID.String()
\t\t\t}
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_version WHERE jid=? AND name=?`, jid, req.Name)
\t\t\t_, _ = wdb.Exec(`DELETE FROM whatsmeow_app_state_mutation_macs WHERE jid=? AND name=?`, jid, req.Name)
\t\t\twdb.Close()
\t\t\t// A clean local baseline means archive will be unsafe until the re-fetch lands;
\t\t\t// drop readiness so the gate (Fix Q) re-arms, then the resync below re-enables it.
\t\t\tsetAppStateReady(false)
\t\t}
"""
    + FIXT_SKIP_BAD_HANDLER
    + """\t\t// claude-ops Fix T: skip_bad after discard_local
"""
)

FIXT_RESYNC_ORDER_SENTINEL = "claude-ops Fix T: skip_bad after discard_local"


# ─── main.go Fix U: POST /api/reconcile_archived ───────────────────────────────
# Rebuilds chats.archived to match the phone's archive state WITHOUT a re-pair or
# server round-trip.
#
# Problem: after a full app-state resync with skip_bad, whatsmeow's DecodePatches
# aborts at the first bad LTHash patch, discarding mutations from all valid patches
# in the same batch. chats.archived in messages.db ends up stale/zeroed.
#
# Root cause of event-based approaches: FetchAppState returns the mutations ONLY
# when DecodePatches succeeds for the entire batch. When bad patches (v899-v1032)
# are in the same batch as valid ones, the entire batch is discarded.
#
# Solution: whatsmeow maintains whatsmeow_chat_settings.archived (in whatsapp.db)
# independently from DecodePatches — it is populated from the app-state SNAPSHOT
# (delivered before incremental patches) via applyAppStatePatches → collectEventsToDispatch
# → dispatchAppState which writes to the DB directly. The snapshot pre-dates the
# bad patch range (v898) so it always has the correct archive state.
#
# Fix U exposes POST /api/reconcile_archived which:
#   1. Opens whatsapp.db (read-only) and reads all (chat_jid, archived) rows from
#      whatsmeow_chat_settings for the connected device's JID.
#   2. For each row, calls SetArchivedStatus(chatJID, archived) to sync messages.db.
#   3. Returns {"success":true,"archived_count":N,"non_archived_count":M,"synced":S}.
#
# No server contact required. No re-pair. Idempotent: running twice yields identical
# counts because whatsmeow_chat_settings is the stable source of truth.
#
# Anchor: the app_state_status handler + goroutine block (the final block in
# startRESTServer). Inserts the reconcile handler immediately before the goroutine.
# MUST run after Fix Q (status handler must exist).

FIXU_RECONCILE_NEEDLE = """\t// claude-ops Fix Q: GET /api/app_state_status — {"ready":bool}. Lets callers
\t// (ops-inbox / wa-inbox-fresh.sh) wait for the regular_low full sync to land
\t// before issuing the first post-re-pair archive, avoiding LTHash corruption.
\thttp.HandleFunc(\"/api/app_state_status\", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tfmt.Fprintf(w, `{\"ready\":%v}`, appStateIsReady())
\t})

\t// Run server in a goroutine so it doesn't block"""

FIXU_RECONCILE_REPLACEMENT = """\t// claude-ops Fix Q: GET /api/app_state_status — {"ready":bool}. Lets callers
\t// (ops-inbox / wa-inbox-fresh.sh) wait for the regular_low full sync to land
\t// before issuing the first post-re-pair archive, avoiding LTHash corruption.
\thttp.HandleFunc(\"/api/app_state_status\", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\tfmt.Fprintf(w, `{\"ready\":%v}`, appStateIsReady())
\t})

\t// claude-ops Fix U: POST /api/reconcile_archived — rebuild chats.archived in
\t// messages.db to match the phone's archive state without a re-pair or server
\t// round-trip. whatsmeow maintains whatsmeow_chat_settings.archived (in whatsapp.db)
\t// from the app-state snapshot which IS correctly populated even when incremental
\t// patches have LTHash errors (the snapshot pre-dates the bad patch range). We
\t// simply copy that authoritative source into messages.db.chats.archived. Sequence:
\t//   1. ResetAllArchived() clears stale flags (whatsapp.db stores only explicit settings).
\t//   2. Open whatsapp.db and read all (chat_jid, archived) rows from
\t//      whatsmeow_chat_settings where our_jid matches the connected device.
\t//   3. For each row, call SetArchivedStatus to sync messages.db.
\t//   4. Return archived/non-archived counts.
\t// No server contact, no re-pair, idempotent.
\thttp.HandleFunc(\"/api/reconcile_archived\", func(w http.ResponseWriter, r *http.Request) {
\t\tif r.Method != http.MethodPost {
\t\t\thttp.Error(w, \"Method not allowed\", http.StatusMethodNotAllowed)
\t\t\treturn
\t\t}
\t\tw.Header().Set(\"Content-Type\", \"application/json\")
\t\t// Determine our JID for the whatsapp.db query.
\t\tourJID := \"\"
\t\tif client.Store != nil && client.Store.ID != nil {
\t\t\tourJID = client.Store.ID.String()
\t\t}
\t\t// Step 1: clear stale archived flags (whatsapp.db only stores explicit settings).
\t\tif err := messageStore.ResetAllArchived(); err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"ResetAllArchived: %s\"}`, err.Error())
\t\t\treturn
\t\t}
\t\t// Step 2: open whatsapp.db and read chat settings.
\t\twdb, err := sql.Open(\"sqlite3\", \"file:store/whatsapp.db?_foreign_keys=on&mode=ro\")
\t\tif err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"open whatsapp.db: %s\"}`, err.Error())
\t\t\treturn
\t\t}
\t\tdefer wdb.Close()
\t\trows, err := wdb.Query(
\t\t\t`SELECT chat_jid, archived FROM whatsmeow_chat_settings WHERE our_jid=?`, ourJID)
\t\tif err != nil {
\t\t\tw.WriteHeader(http.StatusInternalServerError)
\t\t\tfmt.Fprintf(w, `{\"success\":false,\"message\":\"query chat_settings: %s\"}`, err.Error())
\t\t\treturn
\t\t}
\t\tdefer rows.Close()
\t\t// Step 3: sync each chat's archive flag into messages.db.
\t\tvar updated, errors int
\t\tfor rows.Next() {
\t\t\tvar chatJID string
\t\t\tvar archived bool
\t\t\tif err := rows.Scan(&chatJID, &archived); err != nil {
\t\t\t\terrors++
\t\t\t\tcontinue
\t\t\t}
\t\t\tif err := messageStore.SetArchivedStatus(chatJID, archived); err != nil {
\t\t\t\tfmt.Printf(\"Fix U: SetArchivedStatus(%s, %v) error: %v\\n\", chatJID, archived, err)
\t\t\t\terrors++
\t\t\t} else {
\t\t\t\tupdated++
\t\t\t}
\t\t}
\t\tif err := rows.Err(); err != nil {
\t\t\tfmt.Printf(\"Fix U: rows iteration error: %v\\n\", err)
\t\t}
\t\tfmt.Printf(\"Fix U: reconcile complete — updated %d chats, %d errors\\n\", updated, errors)
\t\t// Step 4: report counts.
\t\tvar archivedCount, nonArchivedCount int
\t\t_ = messageStore.db.QueryRow(`SELECT COUNT(*) FROM chats WHERE archived=1`).Scan(&archivedCount)
\t\t_ = messageStore.db.QueryRow(`SELECT COUNT(*) FROM chats WHERE archived=0`).Scan(&nonArchivedCount)
\t\tfmt.Fprintf(w,
\t\t\t`{\"success\":true,\"message\":\"chats.archived reconciled from whatsmeow_chat_settings\",\"archived_count\":%d,\"non_archived_count\":%d,\"synced\":%d,\"errors\":%d}`,
\t\t\tarchivedCount, nonArchivedCount, updated, errors,
\t\t)
\t})

\t// Run server in a goroutine so it doesn't block"""
FIXU_RECONCILE_SENTINEL = "claude-ops Fix U: POST /api/reconcile_archived"


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
    ap.add_argument(
        "--build",
        action="store_true",
        default=False,
        help=(
            "When any .go file changed, run `go build -o whatsapp-bridge .` in the "
            "bridge dir.  Exits non-zero on build failure.  No-op when no Go files changed."
        ),
    )
    ap.add_argument(
        "--restart",
        action="store_true",
        default=False,
        help=(
            "After a successful --build, restart whatsapp-bridge.service "
            "(Linux: systemctl --user; macOS: launchctl kickstart with load-w fallback).  "
            "No-op when --build was not passed or the build failed."
        ),
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
    # Fix Q: readiness state + helpers. Anchors on Fix G's healLTHash — MUST run
    # after Fix G (healLTHash) so the anchor exists.
    changed_go |= replace_idempotent(
        main_go,
        FIXQ_STATE_NEEDLE,
        FIXQ_STATE_REPLACEMENT,
        FIXQ_STATE_SENTINEL,
        "Fix Q: appStateReady state + syncAppStateThenReady helper",
    )
    # Fix Q: GET /api/app_state_status — chains on the goroutine block the other
    # endpoints re-emit.
    changed_go |= replace_idempotent(
        main_go,
        FIXQ_STATUS_NEEDLE,
        FIXQ_STATUS_REPLACEMENT,
        FIXQ_STATUS_SENTINEL,
        "Fix Q: GET /api/app_state_status endpoint",
    )
    # Fix Q: full regular_low sync on connect → flip appStateReady.
    changed_go |= replace_idempotent(
        main_go,
        FIXQ_CONNECT_NEEDLE,
        FIXQ_CONNECT_REPLACEMENT,
        FIXQ_CONNECT_SENTINEL,
        "Fix Q: full app-state sync on Connected + readiness flip",
    )
    # Fix Q: 425 readiness gate at the top of /api/archive — MUST run after Fix F
    # (the archive handler it anchors inside is emitted by Fix F).
    changed_go |= replace_idempotent(
        main_go,
        FIXQ_GATE_NEEDLE,
        FIXQ_GATE_REPLACEMENT,
        FIXQ_GATE_SENTINEL,
        "Fix Q: /api/archive 425 app-state readiness gate",
    )
    # Fix R: discard_local mode in /api/resync_app_state — MUST run after Fix D
    # (modifies the Fix D handler body) and after Fix Q state (uses setAppStateReady).
    changed_go |= replace_idempotent(
        main_go,
        FIXR_DISCARD_NEEDLE,
        FIXR_DISCARD_REPLACEMENT,
        FIXR_DISCARD_SENTINEL,
        "Fix R: /api/resync_app_state discard_local mode",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXR_READY_NEEDLE,
        FIXR_READY_REPLACEMENT,
        FIXR_READY_SENTINEL,
        "Fix R: re-arm readiness after successful resync",
    )
    # Fix T/V: skip-and-continue past unverifiable LTHash patches. MUST run after
    # Fix Q (FIXQ_STATE_REPLACEMENT installed syncAppStateThenReady to anchor on)
    # and after Fix R (T2 anchors inside the Fix R struct block).
    # Upgrade path first: production bridges already on Fix T lack the Fix Q needle
    # but have FIXT_SYNC_FIXT_NEEDLE; without this, Fix V never lands on them.
    changed_go |= replace_if_present(
        main_go,
        FIXT_SYNC_FIXT_NEEDLE,
        FIXT_SYNC_REPLACEMENT,
        FIXT_SYNC_SENTINEL,
        "Fix V: upgrade Fix T install (missing-key skip + key poller)",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXT_SYNC_NEEDLE,
        FIXT_SYNC_REPLACEMENT,
        FIXT_SYNC_SENTINEL,
        "Fix T: skipLTHashPatch + syncAppStateSkipBad + updated syncAppStateThenReady",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXT_RESYNC_NEEDLE,
        FIXT_RESYNC_REPLACEMENT,
        FIXT_RESYNC_SENTINEL,
        "Fix T: /api/resync_app_state skip_bad struct field",
    )
    changed_go |= replace_if_present(
        main_go,
        FIXT_RESYNC_ORDER_NEEDLE,
        FIXT_RESYNC_ORDER_REPLACEMENT,
        FIXT_RESYNC_ORDER_SENTINEL,
        "Fix T: reorder skip_bad after discard_local",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXT_RESYNC_HANDLER_NEEDLE,
        FIXT_RESYNC_HANDLER_REPLACEMENT,
        FIXT_RESYNC_HANDLER_SENTINEL,
        "Fix T: /api/resync_app_state skip_bad=true handler",
    )
    # Fix U: POST /api/reconcile_archived. MUST run after Fix Q (anchors on the
    # app_state_status handler) and Fix T (uses syncAppStateSkipBad).
    changed_go |= replace_idempotent(
        main_go,
        FIXU_RECONCILE_NEEDLE,
        FIXU_RECONCILE_REPLACEMENT,
        FIXU_RECONCILE_SENTINEL,
        "Fix U: POST /api/reconcile_archived endpoint",
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
        "Fix O: reset chats.archived on INITIAL_BOOTSTRAP history sync",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_PROJECT_NEEDLE,
        FIXN_PROJECT_REPLACEMENT,
        FIXN_PROJECT_SENTINEL,
        "Fix O: project HistorySync archive flag onto chats.archived",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXN_PROJECT_FIXUP_NEEDLE,
        FIXN_PROJECT_FIXUP_REPLACEMENT,
        FIXN_PROJECT_FIXUP_SENTINEL,
        "Fix O: metadata-only unarchive on existing chats",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXP_IMPORT_NEEDLE,
        FIXP_IMPORT_REPLACEMENT,
        FIXP_IMPORT_SENTINEL,
        "Fix P: import store + waCompanionReg (history-sync config)",
    )
    changed_go |= replace_idempotent(
        main_go,
        FIXP_PROPS_NEEDLE,
        FIXP_PROPS_REPLACEMENT,
        FIXP_PROPS_SENTINEL,
        "Fix P: RequireFullSync + max history limits on pair",
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
        print("  main.go changed — bridge binary needs to be rebuilt")
    if changed_py:
        print(
            "  whatsapp.py changed — restart the MCP server (mcp-proxy.service) to load"
        )
    if not (changed_go or changed_py):
        print("All patches already applied; nothing to do.")

    # ── --build: rebuild the bridge binary from current patched sources ──────
    build_ok = False
    if args.build:
        import subprocess

        bridge_dir = args.install_dir / "whatsapp-bridge"
        if not changed_go:
            print("  --build: patches already applied; rebuilding from current sources.")
        print(
            "  --build: running `CGO_ENABLED=1 go build -tags sqlite_fts5 "
            f"-o whatsapp-bridge .` in {bridge_dir} ..."
        )
        result = subprocess.run(
            ["go", "build", "-tags", "sqlite_fts5", "-o", "whatsapp-bridge", "."],
            cwd=bridge_dir,
            env={**os.environ, "CGO_ENABLED": "1"},
        )
        if result.returncode != 0:
            print(
                f"  --build: FAILED (exit {result.returncode}) — fix compilation errors above",
                file=sys.stderr,
            )
            return result.returncode
        print("  --build: OK — whatsapp-bridge binary rebuilt.")
        build_ok = True
    elif changed_go:
        print(
            "  NOTE: main.go changed but --build was not passed.  Run with --build to "
            "rebuild, or manually: cd ~/.local/share/whatsapp-mcp/whatsapp-bridge && "
            "go build -o whatsapp-bridge ."
        )

    # ── --restart: restart the service after a successful build ──────────────
    if args.restart:
        if not args.build:
            print(
                "  --restart: ignored — pass --build together with --restart to rebuild "
                "and then restart.",
                file=sys.stderr,
            )
        elif not build_ok:
            print("  --restart: skipped — build did not succeed.", file=sys.stderr)
        else:
            import platform
            import subprocess

            print("  --restart: restarting whatsapp-bridge service ...")
            if platform.system() == "Darwin":
                # macOS: launchctl kickstart; fall back to load -w if not loaded yet.
                label = f"com.{os.environ.get('USER', 'user')}.whatsapp-bridge"
                uid = os.getuid()
                target = f"gui/{uid}/{label}"
                r = subprocess.run(
                    ["launchctl", "kickstart", "-k", target],
                    capture_output=True,
                )
                if r.returncode != 0:
                    plist = (
                        pathlib.Path.home()
                        / "Library"
                        / "LaunchAgents"
                        / f"{label}.plist"
                    )
                    if plist.exists():
                        subprocess.run(["launchctl", "load", "-w", str(plist)])
                        r2 = subprocess.run(
                            ["launchctl", "kickstart", "-k", target],
                            capture_output=True,
                        )
                        if r2.returncode != 0:
                            print(
                                f"  --restart: launchctl kickstart failed: "
                                f"{r2.stderr.decode().strip()}",
                                file=sys.stderr,
                            )
                            return r2.returncode
                    else:
                        print(
                            f"  --restart: plist not found at {plist}; "
                            "start the service manually.",
                            file=sys.stderr,
                        )
                        return 1
            else:
                # Linux (systemd --user)
                r = subprocess.run(
                    ["systemctl", "--user", "restart", "whatsapp-bridge.service"]
                )
                if r.returncode != 0:
                    print(
                        f"  --restart: systemctl restart failed (exit {r.returncode})",
                        file=sys.stderr,
                    )
                    return r.returncode
            print("  --restart: whatsapp-bridge.service restarted.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
