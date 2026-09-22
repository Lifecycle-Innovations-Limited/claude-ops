#!/usr/bin/env bash
# test-ops-inbox-email-forgotten-debt.sh — archived/filtered mail that still
# owes a reply must surface.
#
# WHY (real miss, 2026-09-16): a counterparty sent finished assets on a project
# thread. Gmail had that thread filed out of
# the inbox, so the email half of ops-inbox-scan — which queried `in:inbox` and
# nothing else — never saw it. Three consecutive scans reported the mailbox as
# handled while a counterparty waited. Label state is not conversation state.
#
# The rule this pins: debt is DIRECTION, not label. If their message is the last
# one in a thread and we never answered inside --debt-days, it is open, whether
# or not Gmail still calls it INBOX. Promotions/social/updates/forums categories
# and no-reply senders stay shut, and a thread we already answered stays shut.
#
# Mutation-proof: delete the debt queries in bin/ops-inbox-scan, drop the
# _merge_forgotten call, or stop filtering on direction, and this goes red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCAN="$ROOT/bin/ops-inbox-scan"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-email-debt.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- gog stub --
# Offline stand-in for the real CLI. Three shapes matter:
#   gog auth list                     -> account resolution
#   gog gmail search ... <query>      -> the INBOX working set (JSON array)
#   gog gmail messages search ... -- <query> -> debt sweeps (JSON object)
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gog" <<'STUB'
#!/usr/bin/env bash
# Minimal gog stub. Query text decides which fixture is returned.
args="$*"

if [ "${1:-}" = "auth" ]; then
  printf 'user@example.com\tdefault\toauth\n'
  exit 0
fi

# The last argument is always the query string in our call sites.
query="${!#}"

case "$args" in
  *"gmail messages search"*)
    case "$query" in
      *"in:sent"*)        cat "$OPS_TEST_FIXTURES/sent.json" ;;
      *"-in:inbox"*)      cat "$OPS_TEST_FIXTURES/archived.json" ;;
      *)                  printf '{"messages":[]}\n' ;;
    esac
    ;;
  *"gmail search"*)
    cat "$OPS_TEST_FIXTURES/inbox.json"
    ;;
  *)
    printf '[]\n'
    ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/gog"

# ----------------------------------------------------------------- fixtures --
FIX="$TMP/fixtures"
mkdir -p "$FIX"

# INBOX working set: one ordinary live thread, so the scan is not "empty".
cat >"$FIX/inbox.json" <<'JSON'
[
  {
    "id": "live-1",
    "threadId": "t-live",
    "date": "2026-09-16 09:00",
    "internalDateIso": "2026-09-16T09:00:00+02:00",
    "from": "Live Human <live@example.com>",
    "subject": "Still in the inbox",
    "labels": ["IMPORTANT", "CATEGORY_PERSONAL"]
  }
]
JSON

# Archived inbound mail (not from us), i.e. the debt candidates.
cat >"$FIX/archived.json" <<'JSON'
{
  "messages": [
    {
      "id": "believe-1",
      "threadId": "t-counterparty",
      "date": "2026-09-15 14:27",
      "internalDateIso": "2026-09-15T14:27:56+02:00",
      "from": "Alex <alex@example.com>",
      "subject": "Re: Project assets",
      "labels": ["IMPORTANT", "CATEGORY_PERSONAL"]
    },
    {
      "id": "answered-1",
      "threadId": "t-answered",
      "date": "2026-09-10 10:00",
      "internalDateIso": "2026-09-10T10:00:00+02:00",
      "from": "Polite Person <polite@example.com>",
      "subject": "Can you send the file?",
      "labels": ["CATEGORY_PERSONAL"]
    },
    {
      "id": "promo-1",
      "threadId": "t-promo",
      "date": "2026-09-14 08:00",
      "internalDateIso": "2026-09-14T08:00:00+02:00",
      "from": "Shop <hello@shop.example.com>",
      "subject": "50% off everything",
      "labels": ["CATEGORY_PROMOTIONS"]
    },
    {
      "id": "swept-oneway-1",
      "threadId": "t-swept-oneway",
      "date": "2026-09-13 09:00",
      "internalDateIso": "2026-09-13T09:00:00+02:00",
      "from": "Cold Pitch <hi@coldpitch.example.com>",
      "subject": "Quick intro about our platform",
      "labels": ["CATEGORY_PERSONAL"]
    },
    {
      "id": "robot-1",
      "threadId": "t-robot",
      "date": "2026-09-14 09:00",
      "internalDateIso": "2026-09-14T09:00:00+02:00",
      "from": "Build bot <no-reply@ci.example.com>",
      "subject": "Your build finished",
      "labels": ["CATEGORY_PERSONAL"]
    }
  ]
}
JSON

# Our sent mail. We answered t-answered AFTER their message; never t-counterparty.
cat >"$FIX/sent.json" <<'JSON'
{
  "messages": [
    {
      "id": "sent-1",
      "threadId": "t-answered",
      "date": "2026-09-10 11:30",
      "internalDateIso": "2026-09-10T11:30:00+02:00",
      "from": "User <user@example.com>",
      "subject": "Re: Can you send the file?",
      "labels": ["SENT"]
    },
    {
      "id": "sent-2",
      "threadId": "t-counterparty",
      "date": "2026-09-12 10:25",
      "internalDateIso": "2026-09-12T10:25:00+02:00",
      "from": "User <user@example.com>",
      "subject": "Re: Project assets",
      "labels": ["SENT"]
    }
  ]
}
JSON

# A bulk sweep stamps every archived thread in one second. That watermark must
# silence the one-way pitch, and must NOT silence a conversation the operator is in:
# archiving is a filing decision, never proof that a reply was sent. On
# 2026-09-16 a watermark over 1007 threads wiped all 12 genuine two-way threads
# out of the result — this fixture pins that it cannot happen again.
WM_DIR="$TMP/hermes/state"
mkdir -p "$WM_DIR"
cat >"$WM_DIR/ops-email-sweep-watermarks-user_example.com.json" <<'JSON'
{
  "t-counterparty": "2026-09-16 09:00:00+00:00",
  "t-swept-oneway": "2026-09-16 09:00:00+00:00"
}
JSON

run_scan() {
  OPS_TEST_FIXTURES="$FIX" \
  PATH="$TMP/bin:$PATH" \
  GOG_ACCOUNT="user@example.com" \
  GMAIL_ACCOUNT="user@example.com" \
  GOG_KEYRING_PASSWORD="test" \
  HERMES_HOME="$TMP/hermes" \
  "$SCAN" --email-only --debt-days 90 2>/dev/null
}

bucket_of() {
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read() or "{}")
em = d.get("email", {})
subj = sys.argv[1]
for b in ("needs_reply", "waiting", "fyi"):
    for row in em.get(b, []):
        if subj in (row.get("subject") or ""):
            print(b + (":forgotten" if row.get("forgotten") else ":live"))
            sys.exit(0)
print("ABSENT")' "$2" <<<"$1"
}

echo "email forgotten debt"
OUT="$(run_scan)"
if [ -z "$OUT" ]; then
  bad "scan produced no output"
else
  b="$(bucket_of "$OUT" "Project assets")"
  [ "$b" = "needs_reply:forgotten" ] \
    && ok "archived thread where they spoke last comes back as forgotten" \
    || bad "counterparty thread landed in '$b'"

  # Same thread also carries a sweep watermark. A conversation the operator wrote into
  # must survive it; only the direction test may close it.
  [ "$b" = "needs_reply:forgotten" ] \
    && ok "bulk sweep watermark does not bury a two-way conversation" \
    || bad "watermark buried a thread the operator participated in"

  b="$(bucket_of "$OUT" "Still in the inbox")"
  [ "$b" = "needs_reply:live" ] \
    && ok "ordinary inbox thread stays live, not forgotten" \
    || bad "live inbox thread landed in '$b'"

  b="$(bucket_of "$OUT" "Can you send the file?")"
  [ "$b" = "ABSENT" ] \
    && ok "thread we already answered stays shut" \
    || bad "answered thread came back as '$b'"

  b="$(bucket_of "$OUT" "50% off everything")"
  [ "$b" = "ABSENT" ] \
    && ok "promotions category stays shut" \
    || bad "promo came back as '$b'"

  b="$(bucket_of "$OUT" "Your build finished")"
  [ "$b" = "ABSENT" ] \
    && ok "no-reply sender stays shut" \
    || bad "robot mail came back as '$b'"

  b="$(bucket_of "$OUT" "Quick intro about our platform")"
  [ "$b" = "ABSENT" ] \
    && ok "one-way pitch we swept stays filed (watermark honoured)" \
    || bad "swept one-way pitch came back as '$b'"

  grep -q "archived/filtered thread" <<<"$OUT" \
    && ok "scan states that it reopened filtered mail" \
    || bad "no note explaining the email reopen"
fi

echo "debt window bounds the reopen"
OUT1="$(OPS_TEST_FIXTURES="$FIX" PATH="$TMP/bin:$PATH" \
  GOG_ACCOUNT="user@example.com" GOG_KEYRING_PASSWORD="test" \
  "$SCAN" --email-only --debt-days 1 2>/dev/null)"
# The stub ignores newer_than, so a 1-day window must still produce valid JSON
# and must not crash the scan. The real bound is exercised by the query itself.
python3 -c 'import json,sys; json.loads(sys.stdin.read())' <<<"$OUT1" \
  && ok "scan still emits valid JSON with a 1-day debt window" \
  || bad "scan emitted invalid JSON with --debt-days 1"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
