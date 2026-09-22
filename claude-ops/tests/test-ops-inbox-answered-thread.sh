#!/usr/bin/env bash
# test-ops-inbox-answered-thread.sh — a thread the operator already answered is not debt.
#
# 2026-09-16: the scan listed a thread as needing a reply after the operator had
# already answered it that morning from another client. Gmail keeps the INBOX
# label on the thread after such a reply, and the envelope pass only reads the
# last INBOUND message, so it read as debt.
#
# Debt is direction, not label state. If our newest message in a thread is
# newer than theirs, the ball is with them: it belongs in waiting, never in
# needs_reply.
#
# Mutation-proof: remove the _answered_threads() lookup from the inbox pass and
# the first check goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-answered.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ------------------------------------------------------------------ fixtures --
# Three Gmail threads, written straight into the files the scan reads. The
# shapes are the ones that actually occur:
#   t-answered : they wrote, WE replied later. Same shape as a thread the
#                operator answered from another client. Must NOT be needs_reply.
#   t-open     : they wrote, we never replied. Must stay needs_reply.
#   t-stale    : we replied, THEN they wrote again. Ball is back with us.
python3 - "$TMP" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone

tmp = sys.argv[1]
now = datetime.now(timezone.utc)
def ts(**kw):
    return (now - timedelta(**kw)).isoformat()

def msg(mid, tid, frm, subj, when, labels):
    return {"id": mid, "threadId": tid, "from": frm, "subject": subj,
            "date": when, "internalDateIso": when, "labels": labels}

# What the INBOX query returns: the last INBOUND message of each thread.
# All three still carry INBOX, which is exactly why label state cannot decide.
inbox = [
    msg("m1", "t-answered", "Alex <alex@example.com>", "Re: First version",
        ts(days=1), ["INBOX"]),
    msg("m2", "t-open", "Blake <blake@example.com>", "Quote for the project",
        ts(days=2), ["INBOX"]),
    msg("m3", "t-stale", "Casey <casey@example.com>", "Re: Contract",
        ts(hours=2), ["INBOX"]),
]

# Archived inbound over the debt window (the forgotten-debt pass).
debt_in = list(inbox)

# Our own sent mail over the debt window.
sent = [
    # Answered AFTER Alex wrote: this is the fix under test.
    msg("s1", "t-answered", "User <user@example.com>", "Re: First version",
        ts(hours=3), ["SENT"]),
    # Answered BEFORE Casey wrote again: still our turn.
    msg("s2", "t-stale", "User <user@example.com>", "Re: Contract",
        ts(days=3), ["SENT"]),
]

for name, rows in (("inbox.json", inbox), ("debt-in.json", debt_in),
                   ("sent.json", sent)):
    with open(os.path.join(tmp, name), "w") as fh:
        json.dump(rows, fh)
PY

# ------------------------------------------------------------------- run it --
# Drive the scan's own python block with the fixture files, so the test
# exercises the shipped classifier and not a copy of it.
run_scan() {
  OIS_DAYS=7 OIS_DEBT_DAYS=90 OIS_DO_WA=0 OIS_DO_EMAIL=1 \
  OIS_GMAIL_ACCOUNT="user@example.com" \
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

bucket_of() {   # bucket_of <json> <subject-fragment>
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

echo "a thread we already answered is not debt"
OUT="$(run_scan 2>/dev/null)"
if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(bucket_of "$OUT" "First version")"
  [ "$b" = "waiting" ] && ok "answered-from-another-client thread lands in waiting" \
                       || bad "answered thread landed in '$b', expected waiting"

  b="$(bucket_of "$OUT" "Quote for the project")"
  [ "$b" = "needs_reply" ] && ok "genuinely unanswered thread stays needs_reply" \
                           || bad "unanswered thread landed in '$b'"

  b="$(bucket_of "$OUT" "Re: Contract")"
  [ "$b" = "needs_reply" ] && ok "they wrote again after our reply: still our turn" \
                           || bad "re-asked thread landed in '$b', expected needs_reply"

  grep -q "already replied in this thread" <<<"$OUT" \
    && ok "scan says why it demoted the thread" \
    || bad "no explanation on the demoted thread"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
