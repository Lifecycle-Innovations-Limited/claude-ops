#!/usr/bin/env bash
# test-ops-inbox-forgotten-debt.sh — archived/read unanswered asks still surface.
#
# The owner asked (2026-09-11): capture everyone that still deserves a response,
# including forgotten threads, read or unread, inbox or not. Unread is a display
# state. Archive means "dealt with as of now", not "never owed a reply".
#
# Narrow: last inbound is a real question, we never answered (or they asked
# again after us), inside --debt-days. Courtesy tails and ancient history stay
# shut (the 316-chat blowout).
#
# Mutation-proof: drop the debt scan, or ignore ASK_RE, and this goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-forgotten.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

STORE="$TMP/whatsapp-bridge/store"
mkdir -p "$STORE"

python3 - "$STORE/messages.db" <<'PY'
import sqlite3, sys
from datetime import datetime, timedelta, timezone

con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, "
            "last_message_time TIMESTAMP, archived INTEGER NOT NULL DEFAULT 0, "
            "unread_count INTEGER DEFAULT 0)")
con.execute("CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, "
            "content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, "
            "media_type TEXT, filename TEXT, PRIMARY KEY (id, chat_jid))")
con.execute("CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, "
            "phone TEXT, source TEXT, updated_at INTEGER)")

now = datetime.now(timezone.utc)
def ts(**kw):
    return (now - timedelta(**kw)).strftime("%Y-%m-%d %H:%M:%S+00:00")

def chat(jid, name, last, archived, unread=0):
    con.execute("INSERT INTO chats VALUES (?,?,?,?,?)",
                (jid, name, last, archived, unread))
    con.execute("INSERT INTO contacts VALUES (?,?,?,'test',0)",
                (jid, name, jid.split("@")[0]))

def msg(mid, jid, body, when, from_me):
    con.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,'','')",
                (mid, jid, jid.split("@")[0], body, when, 1 if from_me else 0))

# 1. Forgotten: archived, already read (unread=0), still their question.
chat("111@lid", "Forgotten", ts(days=20), 1, 0)
msg("a1", "111@lid", "kun je even kijken of de factuur klopt?", ts(days=20), False)

# 2. Courtesy tail, archived. MUST stay shut.
chat("222@lid", "Thanks", ts(days=10), 1, 0)
msg("b1", "222@lid", "thanks!", ts(days=10), False)

# 3. Ancient unanswered ask. MUST stay shut (316-chat blowout).
chat("333@lid", "Ancient", ts(days=400), 1, 0)
msg("c1", "333@lid", "hey are you around?", ts(days=400), False)

# 4. We already answered, then archived. MUST stay shut.
chat("444@lid", "Answered", ts(days=15), 1, 0)
msg("d1", "444@lid", "can you send the file?", ts(days=16), False)
msg("d2", "444@lid", "sent it just now", ts(days=15), True)

# 5. Open inbox, unread=0, still a question. Working set, not forgotten.
chat("555@lid", "Open", ts(hours=3), 0, 0)
msg("e1", "555@lid", "wanneer kunnen we bellen?", ts(hours=3), False)

con.commit(); con.close()
PY

scan_json() {
  "$SCAN" --whatsapp-only --no-peer-stores --debt-days 90 \
    --wa-store "$STORE/messages.db" --bridge-port 8099 2>/dev/null
}

bucket_of() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "{}")
wa = d.get("whatsapp", {})
who = sys.argv[1]
for b in ("needs_reply", "waiting", "groups", "fyi"):
    for row in wa.get(b, []):
        if row.get("who") == who:
            flag = "forgotten" if row.get("forgotten") else "live"
            print(b + ":" + flag); sys.exit(0)
print("ABSENT")' "$2" <<<"$1"
}

echo "forgotten debt window 90d"
OUT="$(scan_json)"
if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(bucket_of "$OUT" Forgotten)"
  [ "$b" = "needs_reply:forgotten" ] && ok "archived unread=0 question comes back as forgotten" \
                                    || bad "Forgotten landed in '$b'"

  b="$(bucket_of "$OUT" Thanks)"
  [ "$b" = "ABSENT" ] && ok "courtesy tail stays archived" \
                      || bad "Thanks came back as '$b'"

  b="$(bucket_of "$OUT" Ancient)"
  [ "$b" = "ABSENT" ] && ok "ancient history stays shut" \
                      || bad "Ancient came back as '$b'"

  b="$(bucket_of "$OUT" Answered)"
  [ "$b" = "ABSENT" ] && ok "we-answered-then-archived stays shut" \
                      || bad "Answered came back as '$b'"

  b="$(bucket_of "$OUT" Open)"
  [ "$b" = "needs_reply:live" ] && ok "open inbox question is live, not forgotten" \
                               || bad "Open landed in '$b'"

  grep -q "forgotten unanswered" <<<"$OUT" \
    && ok "scan states that it reopened forgotten asks" \
    || bad "no note explaining forgotten reopen"
fi

echo "debt window bounds the reopen"
OUT7="$("$SCAN" --whatsapp-only --no-peer-stores --debt-days 7 \
  --wa-store "$STORE/messages.db" --bridge-port 8099 2>/dev/null)"
b="$(bucket_of "$OUT7" Forgotten)"
[ "$b" = "ABSENT" ] && ok "20-day ask stays shut when --debt-days is 7" \
                    || bad "Forgotten came back as '$b' inside a 7-day window"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
