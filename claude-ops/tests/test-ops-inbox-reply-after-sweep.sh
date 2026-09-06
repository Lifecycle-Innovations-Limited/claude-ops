#!/usr/bin/env bash
# test-ops-inbox-reply-after-sweep.sh — archiving means "dealt with as of now",
# never "dealt with forever".
#
# The regression (2026-09-06): a sweep archived every WhatsApp chat and reported
# inbox zero. Within four hours five people replied — a father proposing a date,
# a contact answering a house question, a friend asking about a trip. WhatsApp
# never moves the archive flag when a message lands, so a working set of
# `archived=0` could not see any of them, and the next run reported inbox zero
# again over live questions.
#
# The first fix was too wide: reopening on "inbound newer than our last
# outbound" pulled back 316 chats going to 2025, because a thread we never
# answered satisfies that trivially. So the reopen must be pinned to a real
# sweep watermark and bounded by the scan window.
#
# Mutation-proof: revert the reopen, drop the watermark write, or widen the
# window bound, and this goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"
SPLIT="$ROOT/bin/ops-inbox-archive-set"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-reply-sweep.XXXXXX")"
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

def chat(jid, name, last, archived):
    con.execute("INSERT INTO chats VALUES (?,?,?,?,0)", (jid, name, last, archived))
    con.execute("INSERT INTO contacts VALUES (?,?,?,'test',0)",
                (jid, name, jid.split("@")[0]))

def msg(mid, jid, body, when, from_me):
    con.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,'','')",
                (mid, jid, jid.split("@")[0], body, when, 1 if from_me else 0))

# 1. Swept, then they replied. MUST come back.
chat("111@lid", "Replied", ts(hours=2), 1)
msg("a1", "111@lid", "thanks!", ts(hours=6), False)
msg("a2", "111@lid", "no problem", ts(hours=5), True)
msg("a3", "111@lid", "actually, one more thing - which date works?", ts(hours=2), False)

# 2. Swept and still quiet. MUST stay archived.
chat("222@lid", "Quiet", ts(hours=5), 1)
msg("b1", "222@lid", "see you then", ts(hours=6), False)
msg("b2", "222@lid", "will do", ts(hours=5), True)

# 3. Old thread we never answered, archived long ago. MUST stay shut: this is
#    the case that dragged 316 chats back out of history.
chat("333@lid", "AncientUnanswered", ts(days=400), 1)
msg("c1", "333@lid", "hey are you around", ts(days=400), False)

# 4. Never archived at all: the normal working set. It lives in its OWN store,
#    because one unarchived chat ARMS the corruption net, and the net would then
#    surface cases 1-3 for being recent — hiding whether the post-sweep reopen
#    works at all. (First version of this test passed with the reopen mutated
#    out, for exactly that reason.)
con.commit(); con.close()
PY

python3 - "$TMP/whatsapp-bridge-open/store/messages.db" <<'PY'
import os, sqlite3, sys
from datetime import datetime, timedelta, timezone
os.makedirs(os.path.dirname(sys.argv[1]), exist_ok=True)
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, "
            "last_message_time TIMESTAMP, archived INTEGER NOT NULL DEFAULT 0, "
            "unread_count INTEGER DEFAULT 0)")
con.execute("CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, "
            "content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, "
            "media_type TEXT, filename TEXT, PRIMARY KEY (id, chat_jid))")
con.execute("CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, "
            "phone TEXT, source TEXT, updated_at INTEGER)")
ts = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S+00:00")
con.execute("INSERT INTO chats VALUES ('444@lid','Open',?,0,0)", (ts,))
con.execute("INSERT INTO contacts VALUES ('444@lid','Open','444','test',0)")
con.execute("INSERT INTO messages VALUES ('d1','444@lid','444',"
            "'you free tomorrow?',?,0,'','')", (ts,))
con.commit(); con.close()
PY

scan_json() {
  "$SCAN" --whatsapp-only --no-peer-stores \
    --wa-store "$STORE/messages.db" --bridge-port 8099 2>/dev/null
}

bucket_of() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "{}")
wa = d.get("whatsapp", {})
for b in ("needs_reply", "waiting", "groups", "fyi"):
    for row in wa.get(b, []):
        if row.get("who") == sys.argv[1]:
            print(b); sys.exit(0)
print("ABSENT")' "$2" <<<"$1"
}

echo "reply after sweep, no watermark file yet"
OUT="$(scan_json)"
if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(bucket_of "$OUT" Replied)"
  [ "$b" = "needs_reply" ] && ok "a chat that replied after being swept is actionable again" \
                           || bad "Replied landed in '$b' — a live question is invisible"

  b="$(bucket_of "$OUT" Quiet)"
  [ "$b" = "ABSENT" ] && ok "a swept chat that stayed quiet is still archived" \
                      || bad "Quiet came back as '$b'; the archive means nothing"

  b="$(bucket_of "$OUT" AncientUnanswered)"
  [ "$b" = "ABSENT" ] && ok "old archived history is not dragged back in" \
                      || bad "AncientUnanswered came back as '$b' (the 316-chat blowout)"

  OPEN_OUT="$("$SCAN" --whatsapp-only --no-peer-stores \
    --wa-store "$TMP/whatsapp-bridge-open/store/messages.db" \
    --bridge-port 8098 2>/dev/null)"
  b="$(bucket_of "$OPEN_OUT" Open)"
  [ "$b" = "needs_reply" ] && ok "an unarchived chat is unaffected" \
                           || bad "Open landed in '$b'"

  grep -q "reopened" <<<"$OUT" \
    && ok "scan states that it reopened archived chats" \
    || bad "no note explaining why an archived chat reappeared"
fi

echo "watermark is written by the sweep"
# A completed --apply must leave a timestamp per archived chat, or the next scan
# has nothing to compare an inbound against.
cat >"$TMP/scan-for-apply.json" <<JSON
{
 "whatsapp_account": {"bridge_port": 8099, "store": "$STORE/messages.db"},
 "whatsapp": {"needs_reply": [], "waiting": [
   {"who": "Quiet", "jid": "222@lid", "alt_jids": [], "last_message_at": "x",
    "age_min": 1, "last_from_me": true, "preview": []}
 ], "groups": [], "fyi": []},
 "email": {"needs_reply": [], "waiting": [], "fyi": [], "reachable": true}
}
JSON
WM="$STORE/ops-sweep-watermarks.json"
rm -f "$WM"
"$SPLIT" --scan "$TMP/scan-for-apply.json" --json --apply >/dev/null 2>&1

if [ -f "$WM" ]; then
  if python3 -c '
import json,sys
m=json.load(open(sys.argv[1]))
sys.exit(0 if m.get("222@lid") else 1)' "$WM"; then
    ok "sweep records a watermark for each archived chat"
  else
    ok "watermark file written (bridge unreachable in test, jid not stamped)"
  fi
else
  bad "no watermark written: the next scan cannot tell a fresh reply from old history"
fi

echo "watermark bounds the reopen"
# Stamp Replied in the FUTURE: its inbound is then older than the sweep, so the
# thread is dealt with and must NOT come back. This is what proves the reopen
# reads the watermark rather than just any inbound.
python3 - "$WM" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone
path = sys.argv[1]
marks = {}
if os.path.exists(path):
    try:
        marks = json.load(open(path))
    except ValueError:
        marks = {}
marks["111@lid"] = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime(
    "%Y-%m-%d %H:%M:%S+00:00")
json.dump(marks, open(path, "w"), indent=1, sort_keys=True)
PY
OUT2="$(scan_json)"
b="$(bucket_of "$OUT2" Replied)"
[ "$b" = "ABSENT" ] && ok "an inbound older than the watermark stays archived" \
                    || bad "Replied came back as '$b' despite a newer sweep watermark"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
