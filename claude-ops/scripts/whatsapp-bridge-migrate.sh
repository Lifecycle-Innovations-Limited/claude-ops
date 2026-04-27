#!/usr/bin/env bash
# whatsapp-bridge-migrate.sh — Idempotent schema migration for the Baileys whatsapp-bridge SQLite store.
#
# Adds:
#   1. FTS5 virtual table `messages_fts` on messages.db (content=messages, content_rowid=rowid)
#      with INSERT/UPDATE/DELETE triggers to keep it in sync.
#   2. `contacts` table (jid, name, phone, source, updated_at) populated from
#      macOS Contacts.app via osascript — falls back to empty table when unavailable.
#
# Idempotent: re-running is a no-op. Safe to run multiple times.
#
# Usage:
#   ./whatsapp-bridge-migrate.sh [--dry-run] [--verbose]
#   WHATSAPP_BRIDGE_DB=/custom/path/messages.db ./whatsapp-bridge-migrate.sh
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
BRIDGE_DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
DRY_RUN=0
VERBOSE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --verbose)  VERBOSE=1 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

log()  { printf '[whatsapp-bridge-migrate] %s\n' "$1"; }
vlog() { [[ $VERBOSE -eq 1 ]] && printf '[whatsapp-bridge-migrate] %s\n' "$1" || true; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if [[ ! -f "$BRIDGE_DB" ]]; then
  log "ERROR: bridge DB not found at $BRIDGE_DB"
  log "Set WHATSAPP_BRIDGE_DB=/path/to/messages.db or ensure the bridge has run at least once."
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  log "ERROR: sqlite3 not found — install it (brew install sqlite / apt-get install sqlite3)"
  exit 1
fi

log "Bridge DB: $BRIDGE_DB"
[[ $DRY_RUN -eq 1 ]] && log "DRY RUN — no changes will be written"

# ── Helper: run SQL ───────────────────────────────────────────────────────────
run_sql() {
  local sql="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    vlog "DRY: $sql"
    return 0
  fi
  sqlite3 "$BRIDGE_DB" "$sql"
}

query_sql() {
  sqlite3 "$BRIDGE_DB" "$1"
}

# ── Step 1: FTS5 virtual table ────────────────────────────────────────────────
log "Step 1: Checking FTS5 index..."

FTS_EXISTS=$(query_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages_fts';" 2>/dev/null || echo "0")
if [[ "$FTS_EXISTS" == "1" ]]; then
  log "  messages_fts already exists — skipping table creation."
else
  log "  Creating messages_fts FTS5 virtual table..."
  run_sql "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  );"

  log "  Backfilling FTS index from existing messages..."
  run_sql "INSERT INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages WHERE content IS NOT NULL AND content != '';"
fi

FTS_EXISTS=$(query_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages_fts';" 2>/dev/null || echo "0")
if [[ "$FTS_EXISTS" == "1" ]]; then
  log "  Ensuring FTS sync triggers..."
  run_sql "CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;"

  run_sql "CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;"

  run_sql "CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;"
fi

# ── Step 2: contacts table ────────────────────────────────────────────────────
log "Step 2: Checking contacts table..."

CONTACTS_EXISTS=$(query_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='contacts';" 2>/dev/null || echo "0")
if [[ "$CONTACTS_EXISTS" == "1" ]]; then
  log "  contacts table already exists — skipping creation."
else
  log "  Creating contacts table..."
  run_sql "CREATE TABLE IF NOT EXISTS contacts (
    jid       TEXT PRIMARY KEY,
    name      TEXT,
    phone     TEXT,
    source    TEXT DEFAULT 'unknown',
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );"
  log "  contacts table created."
fi

# ── Step 3: Seed contacts from macOS Contacts.app ────────────────────────────
log "Step 3: Seeding contacts..."

if [[ $DRY_RUN -eq 1 ]]; then
  log "  DRY RUN — skipping contact seed entirely."
else

CONTACT_COUNT=$(query_sql "SELECT COUNT(*) FROM contacts;" 2>/dev/null || echo "0")
if [[ "$CONTACT_COUNT" -gt 0 ]]; then
  log "  contacts already has $CONTACT_COUNT rows — skipping seed."
else
  if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript &>/dev/null; then
    log "  Extracting from macOS Contacts.app via osascript..."
    CONTACTS_JSON=$(osascript -l JavaScript <<'OSASCRIPT' 2>/dev/null || echo "[]"
var app = Application("Contacts");
var contacts = [];
app.people().forEach(function(p) {
  var name = p.name() || "";
  var phones = p.phones();
  phones.forEach(function(ph) {
    var num = ph.value();
    if (num && name) {
      // Normalize: strip non-digits for the phone field, keep original too
      contacts.push({name: name, phone: num});
    }
  });
});
JSON.stringify(contacts);
OSASCRIPT
    )

    if [[ "$CONTACTS_JSON" == "[]" ]] || [[ -z "$CONTACTS_JSON" ]]; then
      log "  Contacts.app returned 0 contacts (permissions or empty) — leaving contacts table empty."
      log "  Re-run with WHATSAPP_BRIDGE_DB set after granting Contacts access to run a refresh."
    else
      INSERTED=$(CONTACTS_JSON_DATA="$CONTACTS_JSON" python3 - "$BRIDGE_DB" <<'PYEOF' 2>/dev/null || echo "0"
import json, os, sqlite3, sys, re, time

db_path = sys.argv[1]
contacts = json.loads(os.environ["CONTACTS_JSON_DATA"])

def normalize_phone(p):
    digits = re.sub(r'[^\d+]', '', p)
    return digits

conn = sqlite3.connect(db_path)
cur = conn.cursor()
now = int(time.time())
inserted = 0

for c in contacts:
    name = c.get('name', '').strip()
    phone = normalize_phone(c.get('phone', ''))
    if not name or not phone:
        continue
    # JID format: strip leading + and append @s.whatsapp.net
    jid_phone = phone.lstrip('+')
    jid = f"{jid_phone}@s.whatsapp.net"
    cur.execute(
        "INSERT OR IGNORE INTO contacts (jid, name, phone, source, updated_at) VALUES (?,?,?,?,?)",
        (jid, name, phone, 'contacts_app', now)
    )
    inserted += cur.rowcount

conn.commit()
conn.close()
print(inserted)
PYEOF
      )
      log "  Inserted $INSERTED contacts from Contacts.app."
    fi
  else
    log "  Not macOS or osascript unavailable — leaving contacts table empty."
    log "  Populate manually: INSERT INTO contacts (jid, name, phone, source) VALUES (...)"
  fi
fi

fi  # end DRY_RUN guard for contact seed

# ── Done ──────────────────────────────────────────────────────────────────────
log "Migration complete."
[[ $DRY_RUN -eq 1 ]] && log "(DRY RUN — no changes written)"

# Summary
if [[ $DRY_RUN -eq 0 ]]; then
  MSG_COUNT=$(query_sql "SELECT COUNT(*) FROM messages;" 2>/dev/null || echo "?")
  FTS_COUNT=$(query_sql "SELECT COUNT(*) FROM messages_fts;" 2>/dev/null || echo "?")
  CON_COUNT=$(query_sql "SELECT COUNT(*) FROM contacts;" 2>/dev/null || echo "?")
  log "DB stats: messages=$MSG_COUNT  messages_fts=$FTS_COUNT  contacts=$CON_COUNT"
fi
