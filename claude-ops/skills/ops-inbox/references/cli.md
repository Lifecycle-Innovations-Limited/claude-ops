# Inbox CLI/API reference

## CLI/API Reference

### whatsapp-bridge (WhatsApp — mcp**whatsapp**\*)

**Bridge health** — check bridge is running before any WhatsApp operation. Same `lsof` probe across platforms; supervisor command differs:

```bash
lsof -i :8080 | grep LISTEN   # bridge listens on :8080 (same on macOS + Linux)

# macOS — launchd:
launchctl print "gui/$(id -u)/com.${USER}.whatsapp-bridge" 2>&1 | head -3   # use print, NOT list — list only shows already-loaded services

# Linux — systemd-user (installed by scripts/install-whatsapp-bridge-linux.sh):
systemctl --user is-active whatsapp-bridge.service
journalctl --user -u whatsapp-bridge.service -n 10 --no-pager
```

**One-line cross-platform restart** — use the in-repo wrapper when you don't want to branch on uname yourself:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/lib/whatsapp-bridge-up.sh"
```

It restarts via launchctl on Darwin and `systemctl --user` on Linux, then waits up to 5s for `:8080` to come up.

If you need the raw recipes:

**macOS** (handles the "service not loaded" case that breaks bare `kickstart`):

```bash
LABEL="com.${USER}.whatsapp-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
TARGET="gui/$(id -u)/${LABEL}"
if ! launchctl kickstart -k "$TARGET" 2>/dev/null; then
  [ -f "$PLIST" ] && launchctl load -w "$PLIST"
  sleep 2
  launchctl kickstart -k "$TARGET" 2>/dev/null || true
fi
sleep 5
lsof -i :8080 | grep -q LISTEN && echo "bridge up" || echo "bridge FAILED — check ~/.local/share/whatsapp-mcp/whatsapp-bridge/logs/bridge.err.log"
```

**Linux** (systemd-user — the install script's standard path):

```bash
systemctl --user daemon-reload
systemctl --user restart whatsapp-bridge.service
sleep 5
lsof -i :8080 | grep -q LISTEN && echo "bridge up" || journalctl --user -u whatsapp-bridge.service -n 30 --no-pager
```

**Why the macOS recipe matters:** bare `launchctl kickstart -k gui/$UID/<label>` exits with `Could not find service` if the LaunchAgent isn't loaded (common after reboot, plist edits, or when the daemon hasn't auto-registered). Always quote the target string and fall back to `launchctl load -w` before retrying.

**First-time Linux install** — if the bridge isn't installed yet on a Linux host:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/install-whatsapp-bridge-linux.sh" --wa-phone <E.164>
```

This clones lharries/whatsapp-mcp into `~/.local/share/whatsapp-mcp`, applies the in-repo claude-ops patches (Fix A/B pair-phone hardening, auto-backfill on Connected, `POST /api/backfill` REST endpoint, crash-safe `requestHistorySync`, Python LID↔phone↔contact resolver), drops the systemd-user units (`whatsapp-bridge.service`, `whatsapp-backfill.{service,timer}`, `whatsapp-transcribe.{service,timer}`), installs the voice-note transcriber (`transcriber/transcribe_voice_notes.py`), the media enricher (`transcriber/enrich_media.py`, with `whatsapp-enrich.{service,timer}`) and the pre-scan freshness gate (`~/bin/wa-inbox-fresh.sh`), enables linger, and emits the pairing code via `journalctl --user -u whatsapp-bridge -f`. Idempotent: re-running is safe and updates patches in place. Pass `--no-transcribe-timer` to skip voice-note transcription, `--no-enrich-timer` to skip video/image/document enrichment. The transcribe and enrich services read `OPENAI_API_KEY` from `~/.config/systemd/env/mcp-secrets.env`. The media-retry self-heal (Fix M) is part of the bridge patch set, no extra flag.

**MCP tools** (use these instead of any wacli CLI command):

| Tool                                 | Usage                                                    | Output                                                                                            |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `mcp__whatsapp__list_chats`          | `{sort_by: "last_active"}`                               | Array of chats with jid, name, last_message_time                                                  |
| `mcp__whatsapp__list_messages`       | `{chat_jid, limit, query}`                               | Array of messages with id, sender, content, timestamp, is_from_me                                 |
| `mcp__whatsapp__search_contacts`     | `{query}`                                                | Contacts matching name or phone                                                                   |
| `mcp__whatsapp__send_message`        | `{recipient, message}`                                   | Send result                                                                                       |
| `mcp__whatsapp__get_chat`            | `{chat_jid}`                                             | Chat metadata                                                                                     |
| `mcp__whatsapp__get_message_context` | `{chat_jid, message_id}`                                 | Message context window                                                                            |
| `mcp__whatsapp__archive_chat`        | `{chat_jid, archive: true}`                              | Archive (or unarchive with `archive: false`) a chat — sends app-state mutation via whatsmeow      |
| `mcp__whatsapp__resync_app_state`    | `{name: "regular_low", full_sync: true, skip_bad: true}` | Force full app-state resync — run when archive fails with `LTHash mismatch` (server/local desync) |

**Bulk archive non-actionable WA chats** — for newsletters, dead group chats, one-word reactions, etc.:

```bash
DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
WA_API="http://127.0.0.1:$("$CLAUDE_PLUGIN_ROOT/bin/ops-wa-accounts" --port)"   # resolve, never assume
for jid in "<NEWSLETTER_JID>@newsletter" "<GROUP_JID>@g.us" "<CONTACT_PHONE>@s.whatsapp.net"; do
  curl -s -X POST "$WA_API/api/archive" \
    -H 'Content-Type: application/json' \
    -d "{\"chat_jid\":\"$jid\",\"archive\":true}"
done
# The /api/archive endpoint auto-heals LTHash corruption internally (Fix G) and
# immediately UPSERTs archived=1 into messages.db so the inbox query reflects it.
# If you still get HTTP 409, the heal failed — run resync manually as a last resort:
# curl -s -X POST "$WA_API/api/resync_app_state" -d '{"name":"regular_low","full_sync":true,"skip_bad":true}'
```

**Archive state is locally queryable** (Fix H — bridge persists `archived` flag in `chats` table):

```bash
# Inbox = all non-archived chats:
sqlite3 "$DB" "SELECT jid, name, last_message_time FROM chats WHERE archived=0 ORDER BY last_message_time DESC;"
# Confirm a specific chat was archived:
sqlite3 "$DB" "SELECT jid, archived FROM chats WHERE jid='<JID>';"
```

**Full-text search** — use `mcp__whatsapp__list_messages` with a `query` param (backed by FTS5 after running `scripts/whatsapp-bridge-migrate.sh`):

```bash
# Direct sqlite3 FTS query (fallback when MCP unavailable):
DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
sqlite3 "$DB" "SELECT chat_jid, sender, content, timestamp FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '<query>') ORDER BY timestamp DESC LIMIT 20;"
```

**Contact lookup** — use `mcp__whatsapp__search_contacts` or query contacts table directly:

```bash
sqlite3 "$DB" "SELECT jid, name, phone FROM contacts WHERE name LIKE '%<name>%' COLLATE NOCASE LIMIT 10;"
```

**History backfill** — the whatsmeow bridge automatically syncs history on connection. No manual backfill command exists; if messages are missing, restart the bridge using the robust recipe above (load-then-kickstart).

### gog CLI (Gmail/Calendar)

| Command                                                                    | Usage                                                                                                                   | Output                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `gog gmail search "in:inbox" --max 50 -j --results-only --no-input`        | Full inbox scan                                                                                                         | JSON array of threads     |
| `gog gmail thread get <threadId> -j`                                       | Get full thread with all messages                                                                                       | Full message JSON         |
| `gog gmail get <messageId> -j`                                             | Get single message                                                                                                      | Message JSON              |
| `gog gmail raw <messageId>`                                                | Dump lossless raw Gmail API JSON — includes authoritative `labelIds`                                                    | Raw message JSON          |
| `gog gmail archive <messageId> [<messageId>...] --force`                   | **Archive** — removes the INBOX label (dedicated archive action; `--force`/`-y` skips confirm; add `--no-input` for CI) | Archive result            |
| `gog gmail archive --query "<gmail-query>" --max N --force`                | Archive by query                                                                                                        | Archive result            |
| `gog gmail messages modify <messageId> --add <LABEL> --remove <LABEL>`     | Edit labels only (NOT archive — use the `archive` subcommand above for that)                                            | Labels result             |
| `gog gmail send --to "<email>" --subject "<subj>" --body "<body>"`         | Send email                                                                                                              | Send result               |
| `gog gmail send --reply-to-message-id <msgId> --reply-all --body "text"`   | Reply all                                                                                                               | Send result               |
| `gog gmail send --to "<email>" --subject "<subj>" --body "<body>" --track` | Send with open-tracking pixel (requires tracking setup — see Open Tracking section)                                     | Send result + tracking-id |
| `gog gmail track status`                                                   | Show tracking configuration status                                                                                      | configured: true/false    |
| `gog gmail track opens [<tracking-id>] --since <duration> --to <email> -j` | Query email opens for a tracking-id (or all recent opens)                                                               | JSON array of open events |
| `gog gmail mark-read <messageId> ... --no-input`                           | Mark as read                                                                                                            | Result                    |
| `gog gmail labels list -j`                                                 | List all labels                                                                                                         | Labels JSON               |

**Known trap — archive verification:** do NOT verify an archive with `gog gmail search "in:inbox"`. That search result is **cached/stale** and keeps returning already-archived messages, making archive look like it failed when it succeeded. Verify the live label state instead:

```bash
gog gmail raw <messageId> | python3 -c "import json,sys; d=json.load(sys.stdin); print('INBOX' in d.get('labelIds',[]))"
# False = archived successfully. gog gmail get -j does NOT reliably populate labelIds; use raw.
```

---

