#!/usr/bin/env bash
# Parallel --all-accounts remote pulls must never share a snapshot path.
# Two client-side accounts snapshot their remote stores at the same time; each
# account's output must contain only its own conversations, and no snapshot may
# be left behind locally or on the (simulated) remote host.
# Uses stub ssh/scp/resolver binaries; no network, no real stores.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ois-snapiso.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
REMOTE="$TMP/remote"
LOCALTMP="$TMP/local-tmp"
mkdir -p "$TMP/plugin/bin" "$TMP/stubs" "$TMP/home" "$REMOTE/tmp" "$REMOTE/stores/a" "$REMOTE/stores/b" "$LOCALTMP"
cp "$ROOT/bin/ops-inbox-scan" "$TMP/plugin/bin/ops-inbox-scan"

mk_store() {  # mk_store <db> <jid> <name> <text>
  python3 - "$@" <<'PY'
import sqlite3, sys
db, jid, name, text = sys.argv[1:]
con = sqlite3.connect(db)
con.execute("CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TIMESTAMP, archived INTEGER NOT NULL DEFAULT 0, unread_count INTEGER DEFAULT 0)")
con.execute("CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_type TEXT, filename TEXT, PRIMARY KEY (id, chat_jid))")
con.execute("CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, phone TEXT, source TEXT, updated_at INTEGER)")
con.execute("INSERT INTO chats VALUES (?,?,'2026-09-01 11:00:00+00:00',0,0)", (jid, name))
con.execute("INSERT INTO contacts VALUES (?,?,?,'test',0)", (jid, name, jid.split('@')[0]))
con.execute("INSERT INTO messages VALUES ('m1',?,?,?,'2026-09-01 11:00:00+00:00',0,'','')", (jid, jid, text))
con.commit(); con.close()
PY
}
mk_store "$REMOTE/stores/a/messages.db" '111001@lid' 'Alpha Contact' 'Can you send the file?'
mk_store "$REMOTE/stores/b/messages.db" '222002@lid' 'Bravo Contact' 'Is Friday still fine?'

# Resolver: two agent-enabled client accounts whose stores live on remote hosts.
cat >"$TMP/plugin/bin/ops-wa-accounts" <<'SH'
#!/usr/bin/env bash
cat <<'JSON'
{"accounts":[
 {"label":"account-a","agent_enabled":true,"port":1,"store":"","remote_store":"/remote/stores/a/messages.db","ssh":"host-a"},
 {"label":"account-b","agent_enabled":true,"port":1,"store":"","remote_store":"/remote/stores/b/messages.db","ssh":"host-b"}
],"notes":[]}
JSON
SH
chmod +x "$TMP/plugin/bin/ops-wa-accounts"

# ssh stub: maps the two aliases' shared remote filesystem into the fixture.
# File barriers force A's snapshot before B's, and B's copy before A's copy:
# correctness must not depend on process scheduling or arbitrary sleep lengths.
cat >"$TMP/stubs/ssh" <<SH
#!/usr/bin/env bash
args=("\$@"); n=\${#args[@]}
host="\${args[\$((n-2))]}"; cmd="\${args[\$((n-1))]}"
cmd="\${cmd//\/tmp\//__OIS_TMP__}"; cmd="\${cmd//\/remote\//__OIS_STORE__}"
cmd="\${cmd//__OIS_TMP__/$REMOTE/tmp/}"; cmd="\${cmd//__OIS_STORE__/$REMOTE/}"
printf '%s\t%s\n' "\$host" "\$cmd" >>"$TMP/ssh.log"
wait_marker() {
  python3 -I -c 'import pathlib,sys,time
p=pathlib.Path(sys.argv[1]); deadline=time.monotonic()+10
while not p.exists() and time.monotonic()<deadline: time.sleep(0.02)
sys.exit(0 if p.exists() else 1)' "\$1"
}
case "\$cmd" in
 *'mktemp -d'*)
  made="\$(bash -c "\$cmd")" || exit \$?
  printf '/tmp/%s\\n' "\${made##*/}"
  exit 0 ;;
 *VACUUM*)
  [ "\$host" != host-b ] || wait_marker "$TMP/a-created" || exit 1
  bash -c "\$cmd" || exit \$?
  if [ "\$host" = host-a ]; then
    touch "$TMP/a-created"
    wait_marker "$TMP/b-copied" || exit 1
  fi
  exit 0 ;;
esac
bash -c "\$cmd"
SH
cat >"$TMP/stubs/scp" <<SH
#!/usr/bin/env bash
args=("\$@"); n=\${#args[@]}
src="\${args[\$((n-2))]}"; dst="\${args[\$((n-1))]}"
path="\${src#*:}"; path="\${path/#\/tmp\//$REMOTE/tmp/}"
cp "\$path" "\$dst" || exit \$?
case "\$src" in host-b:*) touch "$TMP/b-copied" ;; esac
SH
chmod +x "$TMP/stubs/ssh" "$TMP/stubs/scp"

echo "parallel remote snapshot isolation"
OUT="$(HOME="$TMP/home" PATH="$TMP/stubs:$PATH" TMPDIR="$LOCALTMP" OIS_NO_REFRESH=1 \
       "$TMP/plugin/bin/ops-inbox-scan" --whatsapp-only --no-peer-stores 2>"$TMP/stderr")"

who_by_account() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "{}")
for a in d.get("whatsapp_accounts", []):
    names = sorted(r.get("who") or "" for b in ("needs_reply","waiting","groups","fyi") for r in a.get(b) or [])
    print("%s=%s" % (a.get("account"), ",".join(names)))' <<<"$1"
}
SEEN="$(who_by_account "$OUT")"
grep -qx 'account-a=Alpha Contact' <<<"$SEEN" && ok "account-a reads only its own store" \
  || bad "account-a got '$(grep '^account-a=' <<<"$SEEN")' (cross-account snapshot collision)"
grep -qx 'account-b=Bravo Contact' <<<"$SEEN" && ok "account-b reads only its own store" \
  || bad "account-b got '$(grep '^account-b=' <<<"$SEEN")' (cross-account snapshot collision)"

snap_a="$(awk -F'\t' '$1=="host-a" && /VACUUM/' "$TMP/ssh.log" | grep -o "$REMOTE/tmp/[^' \"]*" | head -1)"
snap_b="$(awk -F'\t' '$1=="host-b" && /VACUUM/' "$TMP/ssh.log" | grep -o "$REMOTE/tmp/[^' \"]*" | head -1)"
[ -n "$snap_a" ] && [ "$snap_a" != "$snap_b" ] && ok "each pull uses its own remote snapshot path" \
  || bad "remote snapshot paths shared or missing (a='$snap_a' b='$snap_b')"

left_remote="$(find "$REMOTE/tmp" -mindepth 1 | wc -l | tr -d ' ')"
[ "$left_remote" = 0 ] && ok "no snapshot left on the remote host" \
  || bad "$left_remote snapshot path(s) left on the remote host"
left_local="$(find "$LOCALTMP" -mindepth 1 -name 'ois-wa.*' | wc -l | tr -d ' ')"
[ "$left_local" = 0 ] && ok "no local snapshot copy left after the scan" \
  || bad "$left_local local snapshot dir(s) left in TMPDIR"

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
