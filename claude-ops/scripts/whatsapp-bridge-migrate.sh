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
# The Go bridge binary whose embedded sqlite must ALSO support fts5 — see Step 1 guard.
BRIDGE_BIN="${WHATSAPP_BRIDGE_BIN:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge}"
DRY_RUN=0
VERBOSE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --verbose)  VERBOSE=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
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

# ── fts5 CAPABILITY GUARD (storage-integrity invariant) ───────────────────────
# The fts triggers below are created via the SYSTEM sqlite3 CLI, which almost
# always has fts5 — so creation SUCCEEDS regardless. But the triggers fire on the
# GO BRIDGE's OWN inserts, using the bridge binary's EMBEDDED sqlite. If that
# binary was built WITHOUT fts5 (e.g. an old binary, a `--skip-build` install, or
# a CGO build that dropped `-tags sqlite_fts5`), every bridge insert fires the
# AFTER INSERT trigger → `no such module: fts5` → the whole INSERT fails →
# messages are SILENTLY DROPPED (live AND backfilled). This guard makes the two
# halves agree: only install fts triggers when the bridge binary can satisfy
# them; otherwise DROP any leftover fts schema so storage is never bricked.
# (mattn/go-sqlite3 built with -DSQLITE_ENABLE_FTS5 links the fts5 C source, so
# `strings` on the binary is a reliable capability probe.)
BRIDGE_HAS_FTS5="unknown"
if command -v strings &>/dev/null && [[ -f "$BRIDGE_BIN" ]]; then
  # NB: use `grep -c` (reads ALL input), NOT `grep -q`. Under `set -o pipefail`,
  # `grep -q` closes the pipe on first match → `strings` dies with SIGPIPE → the
  # pipeline reports failure → false "no fts5". `grep -c` drains strings fully.
  fts5_hits=$(strings "$BRIDGE_BIN" 2>/dev/null | grep -ci 'fts5' || true)
  if [[ "${fts5_hits:-0}" -gt 0 ]]; then
    BRIDGE_HAS_FTS5="yes"
  else
    BRIDGE_HAS_FTS5="no"
  fi
fi

if [[ "$BRIDGE_HAS_FTS5" == "no" ]]; then
  log "  ⚠ Bridge binary at $BRIDGE_BIN was built WITHOUT fts5."
  log "  ⚠ Installing fts triggers would brick ALL message storage (no such module: fts5)."
  log "  → Protecting storage: dropping any existing messages_fts triggers + virtual table."
  log "  → Search will use the LIKE fallback until the bridge is rebuilt with -tags sqlite_fts5"
  log "    (CGO_ENABLED=1 go build -tags sqlite_fts5 -o whatsapp-bridge .)."
  run_sql "DROP TRIGGER IF EXISTS messages_fts_insert;
           DROP TRIGGER IF EXISTS messages_fts_update;
           DROP TRIGGER IF EXISTS messages_fts_delete;
           DROP TABLE   IF EXISTS messages_fts;"
  log "  Step 1 complete (fts disabled — storage protected)."
else
  [[ "$BRIDGE_HAS_FTS5" == "unknown" ]] && log "  (bridge binary not found / strings unavailable — cannot probe fts5; proceeding)"

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

  # Always ensure triggers exist (idempotent — handles partial failure recovery)
  log "  Ensuring FTS triggers exist..."
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

  log "  FTS5 index and triggers verified."
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
      INSERTED=$(python3 - "$BRIDGE_DB" "$CONTACTS_JSON" <<'PYEOF' 2>/dev/null || echo "0"
import json, sqlite3, sys, re, time

db_path = sys.argv[1]
raw = sys.argv[2]
contacts = json.loads(raw)

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
