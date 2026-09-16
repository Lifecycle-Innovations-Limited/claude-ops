#!/usr/bin/env bash
# test-ops-inbox-email-watermark.sh — a sweep we ran ourselves must stay swept.
#
# 2026-09-16: the mailbox was genuinely at zero after a clean-up, and the very
# next scan reported 47 items needing a reply. Every one of them was mail
# archived minutes earlier: the forgotten-debt pass reopens "archived AND they
# spoke last", which is true for basically everything you ever close out.
#
# WhatsApp already solved this with ops-sweep-watermarks.json. Email now has the
# same thing: ops-inbox-archive-set stamps each thread it archives, and the scan
# only reopens a swept thread when they wrote again AFTER that stamp.
#
# Mutation-proof: drop the watermark check and the first case goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-wm.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/state"

# ------------------------------------------------------------------ fixtures --
# Three archived threads, all "they spoke last". Only one is real debt.
#   t-swept   : we archived it at 12:05, they last wrote at 12:00. Handled.
#   t-reopen  : we archived it at 12:05, they wrote AGAIN at 12:30. Real debt.
#   t-filtered: no watermark at all — Gmail filed it away itself. Real debt.
python3 - "$TMP" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone

tmp = sys.argv[1]
now = datetime.now(timezone.utc)
def ts(**kw):
    return (now - timedelta(**kw)).isoformat()
def stamp(**kw):
    return (now - timedelta(**kw)).strftime("%Y-%m-%d %H:%M:%S+00:00")

def msg(mid, tid, frm, subj, when, labels):
    return {"id": mid, "threadId": tid, "from": frm, "subject": subj,
            "date": when, "internalDateIso": when, "labels": labels}

inbox = []          # inbox label is empty: the whole point
debt_in = [
    msg("m1", "t-swept", "Anna <anna@example.com>", "Swept thread",
        ts(hours=3), []),
    msg("m2", "t-reopen", "Bo <bo@example.com>", "Reopened thread",
        ts(minutes=30), []),
    msg("m3", "t-filtered", "Cas <cas@example.com>", "Filtered thread",
        ts(days=2), []),
]
sent = []           # we never replied in any of them

# Watermarks: we swept two of the three, two hours ago.
marks = {"t-swept": stamp(hours=2), "t-reopen": stamp(hours=2)}

with open(os.path.join(tmp, "inbox.json"), "w") as fh:
    json.dump(inbox, fh)
with open(os.path.join(tmp, "debt-in.json"), "w") as fh:
    json.dump(debt_in, fh)
with open(os.path.join(tmp, "sent.json"), "w") as fh:
    json.dump(sent, fh)
os.makedirs(os.path.join(tmp, "state"), exist_ok=True)
with open(os.path.join(tmp, "state",
                       "ops-email-sweep-watermarks-sam_example.com.json"), "w") as fh:
    json.dump(marks, fh)
PY

# ------------------------------------------------------------------- run it --
run_scan() {
  HERMES_HOME="$TMP" \
  OIS_DAYS=7 OIS_DEBT_DAYS=90 OIS_DO_WA=0 OIS_DO_EMAIL=1 \
  OIS_GMAIL_ACCOUNT="sam@example.com" \
  OIS_GMAIL_JSON_FILE="$TMP/inbox.json" OIS_GMAIL_OK=1 \
  OIS_GMAIL_DEBT_IN_FILE="$TMP/debt-in.json" \
  OIS_GMAIL_DEBT_OUT_FILE="$TMP/sent.json" \
  python3 - "$SCAN" <<'PY'
import os, re, sys
src = open(sys.argv[1]).read()
body = src.split("python3 <<'PY'", 1)[1].rsplit("PY", 1)[0]
g = {"__name__": "__scan__"}
exec(compile(body, "ops-inbox-scan", "exec"), g)
PY
}

has_subject() {   # has_subject <json> <fragment>
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "{}")
em = d.get("email", {})
frag = sys.argv[1]
for b in ("needs_reply", "waiting", "fyi"):
    for row in em.get(b, []):
        if frag in (row.get("subject") or ""):
            print(b); sys.exit(0)
print("ABSENT")' "$2" <<<"$1"
}

echo "email sweep watermark"
OUT="$(run_scan 2>/dev/null)"
if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(has_subject "$OUT" "Swept thread")"
  [ "$b" = "ABSENT" ] && ok "a thread we swept ourselves stays swept" \
                      || bad "swept thread came back as '$b'"

  b="$(has_subject "$OUT" "Reopened thread")"
  [ "$b" = "needs_reply" ] && ok "they wrote again after the sweep: real debt" \
                           || bad "re-asked thread landed in '$b'"

  b="$(has_subject "$OUT" "Filtered thread")"
  [ "$b" = "needs_reply" ] && ok "no watermark (Gmail filtered it): still debt" \
                           || bad "filtered thread landed in '$b'"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
