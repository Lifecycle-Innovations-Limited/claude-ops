#!/usr/bin/env bash
# test-ops-inbox-cross-account.sh — a thread answered on ANOTHER WhatsApp account
# must never be offered up for a second reply, and a bridge's port must come
# from the live socket rather than a launcher default.
#
# Both regressions are real:
#   2026-09-06 — a contact was answered from the NL number two days earlier. The
#   US store's copy of that same conversation still ended on their inbound line,
#   so the scan called it NEEDS_REPLY and a duplicate reply was drafted.
#   Same run — ops-wa-accounts reported both bridges on 8080 (the whatsmeow
#   default) because neither was started by run-bridge.sh, while they actually
#   listened on 8082 and 8083. Anything trusting that port hits one account for
#   both numbers.
#
# Mutation-proof: revert either fix and this test goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"
ACCOUNTS="$ROOT/bin/ops-wa-accounts"

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-xacct.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --------------------------------------------------------------- fixtures ----
# Two stores, one person. Their inbound sits in BOTH; our reply exists only in
# the peer store, which is exactly the shape that produced the duplicate.
mk_store() {   # mk_store <dir>
  local d="$1/store"
  mkdir -p "$d"
  python3 - "$d/messages.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, "
            "last_message_time TIMESTAMP, archived INTEGER NOT NULL DEFAULT 0, "
            "unread_count INTEGER DEFAULT 0)")
con.execute("CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, "
            "content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, "
            "media_type TEXT, filename TEXT, PRIMARY KEY (id, chat_jid))")
con.execute("CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, "
            "phone TEXT, source TEXT, updated_at INTEGER)")
con.commit(); con.close()
PY
  printf '%s' "$d"
}

MAIN_DIR="$TMP/whatsapp-bridge"
PEER_DIR="$TMP/whatsapp-bridge-us"
MAIN_STORE="$(mk_store "$MAIN_DIR")"
PEER_STORE="$(mk_store "$PEER_DIR")"

# Scanned account: their question is the last line here.
python3 - "$MAIN_STORE/messages.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("INSERT INTO chats VALUES ('999111@lid','Casey','2026-09-01 11:00:00+00:00',0,0)")
con.execute("INSERT INTO contacts VALUES ('999111@lid','Casey','999111','test',0)")
con.execute("INSERT INTO messages VALUES ('m1','999111@lid','999111',"
            "'How was the trip?','2026-09-01 11:00:00+00:00',0,'','')")
# An unrelated contact nobody answered anywhere: the control.
con.execute("INSERT INTO chats VALUES ('999222@lid','Robin','2026-09-01 12:00:00+00:00',0,0)")
con.execute("INSERT INTO contacts VALUES ('999222@lid','Robin','999222','test',0)")
con.execute("INSERT INTO messages VALUES ('m2','999222@lid','999222',"
            "'Still on for Friday?','2026-09-01 12:00:00+00:00',0,'','')")
con.commit(); con.close()
PY

# Peer account: the reply to Casey went out HERE, under a different jid suffix.
python3 - "$PEER_STORE/messages.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("INSERT INTO chats VALUES ('999111@s.whatsapp.net','Casey',"
            "'2026-09-02 09:00:00+00:00',1,0)")
con.execute("INSERT INTO messages VALUES ('p1','999111@s.whatsapp.net','me',"
            "'Trip was great, thanks for asking!','2026-09-02 09:00:00+00:00',1,'','')")
con.commit(); con.close()
PY

run_scan() {  # run_scan [extra args...]
  "$SCAN" --whatsapp-only --pretty \
    --wa-store "$MAIN_STORE/messages.db" --bridge-port 8099 "$@" 2>/dev/null
}

bucket_of() {  # bucket_of <json> <name>
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

echo "cross-account reconciliation"
OUT="$(run_scan --peer-store "$PEER_STORE/messages.db")"

if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(bucket_of "$OUT" Casey)"
  [ "$b" = "waiting" ] && ok "answered-elsewhere thread demoted out of needs_reply" \
                       || bad "Casey landed in '$b', expected waiting (duplicate-reply bug)"

  b="$(bucket_of "$OUT" Robin)"
  [ "$b" = "needs_reply" ] && ok "genuinely unanswered thread still needs_reply" \
                           || bad "Robin landed in '$b', expected needs_reply (gate too wide)"

  # The reason must be visible, or a human cannot tell why it was skipped.
  if grep -q "answered from another WhatsApp account" <<<"$OUT"; then
    ok "demotion carries a stated reason"
  else
    bad "no 'reconciled' reason on the demoted thread"
  fi

  # The peer store must be reported, so a run can prove what it read.
  if python3 -c '
import json,sys
d=json.loads(sys.stdin.read() or "{}")
sys.exit(0 if d.get("peer_stores_read") else 1)' <<<"$OUT"; then
    ok "scan reports which peer stores it read"
  else
    bad "peer_stores_read missing from scan output"
  fi
fi

# Without the peer store the same thread MUST look unanswered: proves the demotion
# comes from peer evidence and not from some unrelated blanket rule.
OUT_NOPEER="$(run_scan --no-peer-stores)"
b="$(bucket_of "$OUT_NOPEER" Casey)"
[ "$b" = "needs_reply" ] && ok "no peer evidence => thread stays actionable" \
                         || bad "Casey was '$b' with no peer store; demotion is not evidence-driven"

echo "live port resolution"
# A bridge with no launcher script, listening on a non-default port.
PORT_OUT="$(WHATSAPP_BRIDGE_GLOB="$TMP/whatsapp-bridge*" \
            WHATSAPP_AGENT_POLICY="$TMP/nonexistent-policy.json" \
            "$ACCOUNTS" 2>/dev/null)"
if python3 -c '
import json,sys
d=json.loads(sys.stdin.read() or "{}")
accts=d.get("accounts",[])
sys.exit(0 if accts and all("port_source" in a for a in accts) else 1)' <<<"$PORT_OUT"; then
  ok "every account states where its port came from"
else
  bad "port_source missing: a caller cannot tell a live port from a guess"
fi

# Real listener on a real port, in a directory shaped like a bridge.
LIVE_DIR="$TMP/whatsapp-bridge-live"
mk_store "$LIVE_DIR" >/dev/null
python3 - "$LIVE_DIR" <<'PY' &
import os, socket, sys, time
os.chdir(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0))
s.listen(1)
with open("port.txt", "w") as fh:
    fh.write(str(s.getsockname()[1]))
time.sleep(20)
PY
LISTENER=$!
for _ in $(seq 1 40); do [ -s "$LIVE_DIR/port.txt" ] && break; sleep 0.1; done
LIVE_PORT="$(cat "$LIVE_DIR/port.txt" 2>/dev/null || echo)"

if [ -z "$LIVE_PORT" ] || [ ! -d /proc ]; then
  echo "  skip live-socket check (no /proc or listener failed to start)"
else
  LIVE_OUT="$(WHATSAPP_BRIDGE_GLOB="$LIVE_DIR" \
              WHATSAPP_AGENT_POLICY="$TMP/nonexistent-policy.json" \
              "$ACCOUNTS" 2>/dev/null)"
  got="$(python3 -c '
import json,sys
d=json.loads(sys.stdin.read() or "{}")
a=d.get("accounts") or [{}]
print(a[0].get("port",""))' <<<"$LIVE_OUT")"
  if [ "$got" = "$LIVE_PORT" ]; then
    ok "port read from the live socket ($got), not the 8080 default"
  else
    bad "reported port $got, listener is on $LIVE_PORT (stale launcher default)"
  fi
fi
kill "$LISTENER" 2>/dev/null || true
wait "$LISTENER" 2>/dev/null || true

echo "fully-archived store is inbox zero, not corruption"
# A store where every chat is archived on purpose, with a `handled` column that
# nothing maintains. The old fallback treated this as flag corruption and
# switched the working set to handled=0, which reopened the entire history --
# 1803 of 1806 archived chats came back as unanswered asks, so a box that had
# just reached inbox zero could never stay there.
ZERO_DIR="$TMP/whatsapp-bridge-zero"
ZERO_STORE="$(mk_store "$ZERO_DIR")"
python3 - "$ZERO_STORE/messages.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("ALTER TABLE chats ADD COLUMN handled INTEGER NOT NULL DEFAULT 0")
# Old, deliberately archived, and last word was theirs: the shape the fallback
# used to resurrect. Well outside the recency floor.
for i in range(6):
    jid = "8000%02d@lid" % i
    con.execute("INSERT INTO chats VALUES (?,?, '2025-01-05 10:00:00+00:00', 1, 0, 0)",
                (jid, "Old%d" % i))
    con.execute("INSERT INTO messages VALUES (?,?,?,'an old question',"
                "'2025-01-05 10:00:00+00:00',0,'','')", ("mm%d" % i, jid, jid))
con.commit(); con.close()
PY

ZOUT="$("$SCAN" --whatsapp-only --pretty --no-peer-stores \
        --wa-store "$ZERO_STORE/messages.db" --bridge-port 8098 2>/dev/null)"
n_needs="$(python3 -c '
import json,sys
d=json.loads(sys.stdin.read() or "{}")
print(len(d.get("whatsapp",{}).get("needs_reply",[])))' <<<"$ZOUT")"
[ "$n_needs" = "0" ] && ok "archived history stays archived (needs_reply=0)" \
                     || bad "$n_needs archived chats resurrected; inbox zero unreachable"

if grep -q "not flag corruption" <<<"$ZOUT"; then
  ok "scan states why it trusted the archive flag"
else
  bad "no note explaining the archived-store verdict"
fi

# The genuine corruption case must STILL be caught: archived=1 everywhere while
# `handled` is actively maintained means the flag, not the inbox, is wrong.
CORRUPT_DIR="$TMP/whatsapp-bridge-corrupt"
CORRUPT_STORE="$(mk_store "$CORRUPT_DIR")"
python3 - "$CORRUPT_STORE/messages.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("ALTER TABLE chats ADD COLUMN handled INTEGER NOT NULL DEFAULT 0")
# handled is maintained here: most rows carry it, one live thread does not.
for i in range(5):
    jid = "9000%02d@lid" % i
    con.execute("INSERT INTO chats VALUES (?,?, '2025-01-05 10:00:00+00:00', 1, 0, 1)",
                (jid, "Done%d" % i))
    con.execute("INSERT INTO messages VALUES (?,?,?,'settled',"
                "'2025-01-05 10:00:00+00:00',1,'','')", ("cm%d" % i, jid, jid))
con.execute("INSERT INTO chats VALUES ('900099@lid','Victim',"
            "'2025-01-06 10:00:00+00:00', 1, 0, 0)")
con.execute("INSERT INTO messages VALUES ('cv','900099@lid','900099',"
            "'you never answered me','2025-01-06 10:00:00+00:00',0,'','')")
con.commit(); con.close()
PY

COUT="$("$SCAN" --whatsapp-only --pretty --no-peer-stores \
        --wa-store "$CORRUPT_STORE/messages.db" --bridge-port 8097 2>/dev/null)"
b="$(bucket_of "$COUT" Victim)"
[ "$b" = "needs_reply" ] && ok "real flag corruption still recovers the live thread" \
                         || bad "Victim was '$b'; corruption fallback no longer fires"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]