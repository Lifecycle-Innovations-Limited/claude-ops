#!/usr/bin/env bash
# Coverage for ops-inbox-archive-set and the full-inbox contract of
# ops-inbox-scan. Hermetic: no bridge, no network, no Gmail. Everything runs
# against a fixture scan JSON, and the script is exercised in its report-only
# default so a test run can never archive anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPLIT="$ROOT/bin/ops-inbox-archive-set"
SCAN="$ROOT/bin/ops-inbox-scan"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Plugin scripts are run by whatever `python3` resolves to, which on macOS is
# Xcode's 3.9. Prefer the oldest interpreter available so a 3.10+ construct
# fails here rather than in a user's hook.
PY=python3
[ -x /usr/bin/python3 ] && PY=/usr/bin/python3

fail() { echo "FAIL: $*" >&2; exit 1; }

# --------------------------------------------------------------------------
# static checks
# --------------------------------------------------------------------------
bash -n "$SCAN"                       || fail "ops-inbox-scan is not valid bash"
"$PY" -c "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)" \
     "$SPLIT"                         || fail "ops-inbox-archive-set must compile on $PY"

# --------------------------------------------------------------------------
# full-inbox contract: the working set is "not archived", never "unread",
# and never a recency slice. Regression guard for the old
# `in:inbox newer_than:7d --max 30` query that aged mail out of the scan.
# --------------------------------------------------------------------------
CODE="$TMP/scan-code.sh"          # comments name the old query on purpose
sed 's/[[:space:]]*#.*$//' "$SCAN" >"$CODE"

grep -q 'EMAIL_QUERY="in:inbox"' "$CODE" \
  || fail "email working set must default to the whole inbox"
grep -q 'newer_than' "$CODE" \
  && fail "email query must not be sliced by a recency window"
grep -q 'WHERE {done_pred} OR last_message_time' "$CODE" \
  || fail "whatsapp working set must be a done-flag predicate, not a recency slice"
grep -q 'done_pred = "archived=0"' "$CODE" \
  || fail "whatsapp must fall back to archived=0 when there is no handled column"
grep -q 'done_pred = "handled=0"' "$CODE" \
  || fail "whatsapp must fall back to handled=0 when every chat is flagged archived"
grep -q 'unread_count' "$CODE" \
  && fail "whatsapp working set must never be driven by unread_count (a display state)"

# gog treats bare args as MESSAGE ids; the scan emits THREAD ids.
grep -q '"--thread"' "$SPLIT" \
  || fail "gmail archive must pass --thread when given thread ids"

# --------------------------------------------------------------------------
# EMPTY IS NOT BROKEN (regression guard, 2026-09-06).
# `gog whoami` prints name/email/photo on separate lines and the address is not
# on the first one, so `head -1 | grep` threw the account away. Every gog call
# then ran without --account, gog refused with "missing --account", and the scan
# reported an unreachable mailbox that was perfectly reachable — a real inbox
# read as inbox zero. Two invariants: resolve the account from ANY line, and
# keep "empty result" distinguishable from "call failed".
# --------------------------------------------------------------------------
grep -q 'head -1 | grep' "$CODE" \
  && fail "gmail account must not be parsed from only the first whoami line"
grep -q 'OIS_GMAIL_OK' "$CODE" \
  || fail "a successful-but-empty gmail search must be distinguishable from a failure"

FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/gog" <<'SH'
#!/usr/bin/env bash
# whoami puts the address on line 2, exactly like the real CLI.
if [ "$1" = "whoami" ]; then
  printf 'name\tTest User\nemail\towner@example.com\nphoto\thttps://example.com/a.png\n'
  exit 0
fi
# refuse unless an account was passed, exactly like a multi-token box.
case " $* " in
  *" -a "*) echo '[]'; exit 0 ;;
  *) echo 'missing --account' >&2; exit 2 ;;
esac
SH
chmod +x "$FAKEBIN/gog"

PATH="$FAKEBIN:$PATH" OIS_NO_REFRESH=1 "$SCAN" --email-only >"$TMP/empty.json" 2>/dev/null \
  || fail "email-only scan must not fail on an empty inbox"
"$PY" - "$TMP/empty.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
e = d["email"]
assert e["account"] == "owner@example.com", \
    "account must be read from the email line, got %r" % e["account"]
assert e["reachable"] is True, "an empty inbox is reachable, not broken: %r" % e
assert e.get("empty") is True, "an empty inbox must say so explicitly"
print("empty-inbox vs unreachable: PASS")
PY

# --------------------------------------------------------------------------
# A MISSING STORE IS A FAILED SCAN, NOT AN EMPTY INBOX (guard, 2026-09-06).
# On a client box the bridge lives on another host and there is no local
# messages.db. The scan used to answer with empty buckets plus a soft note, and
# an agent reading only those buckets reported inbox zero over a full inbox.
# --------------------------------------------------------------------------
OIS_NO_REFRESH=1 OIS_SSH= OIS_SSH_FALLBACK= "$SCAN" --whatsapp-only \
  --wa-store "$TMP/does-not-exist.db" --bridge-port 9 >"$TMP/nostore.json" 2>/dev/null \
  || fail "missing-store scan must still emit valid JSON"
"$PY" - "$TMP/nostore.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
w = d["whatsapp"]
assert w["reachable"] is False, "a missing store is not reachable"
assert w.get("blocked") is True, "a missing store must be marked as a blocked scan"
note = " ".join(d["notes"]).lower()
assert "failed scan" in note, "the note must say the scan failed, not that it is empty"
assert "do not report inbox zero" in note, "the note must forbid claiming inbox zero"
print("missing-store is a blocker: PASS")
PY

# The remote pull must use a consistent sqlite snapshot, never a hot-file copy.
grep -q 'VACUUM INTO' "$CODE" \
  || fail "remote store pull must use VACUUM INTO, not a raw copy of a live db"

# --------------------------------------------------------------------------
# fixture
# --------------------------------------------------------------------------
cat >"$TMP/scan.json" <<'JSON'
{
 "whatsapp": {
  "needs_reply": [
   {"who":"Asker","jid":"1@s.whatsapp.net","alt_jids":["9@lid"],"age_min":60,
    "preview":[{"from_me":true,"text":"sent you the file"},
               {"from_me":false,"text":"Can you resend it? I never got the attachment."}]},
   {"who":"Tail","jid":"2@s.whatsapp.net","alt_jids":[],"age_min":60,
    "preview":[{"from_me":false,"text":"Thanks bro!"}]},
   {"who":"BareMedia","jid":"3@s.whatsapp.net","alt_jids":[],"age_min":60,
    "preview":[{"from_me":false,"text":"[image]"}]},
   {"who":"Stale","jid":"4@s.whatsapp.net","alt_jids":[],"age_min":100000,
    "preview":[{"from_me":false,"text":"Are we still on for the show?"}]},
   {"who":"ShortAsk","jid":"5@s.whatsapp.net","alt_jids":[],"age_min":60,
    "preview":[{"from_me":false,"text":"Hoe was Ibiza?"}]}
  ],
  "waiting": [{"who":"Waiter","jid":"6@s.whatsapp.net","alt_jids":[]}],
  "fyi":     [{"who":"News","jid":"7@newsletter","reason":"newsletter/broadcast"}],
  "groups":  [{"who":"LiveGroup","jid":"8@g.us","age_min":60},
              {"who":"DeadGroup","jid":"9@g.us","age_min":100000}]
 },
 "email": {
  "needs_reply": [], "waiting": [],
  "fyi": [
   {"who":"n@x.com","subject":"Plain newsletter","threadId":"t1","labels":["INBOX","CATEGORY_UPDATES"]},
   {"who":"r@x.com","subject":"Held by todo label","threadId":"t2","labels":["INBOX","Respond"]},
   {"who":"a@x.com","subject":"Awaiting reply label","threadId":"t3","labels":["INBOX","AWAITING REPLY"]},
   {"who":"d@x.com","subject":"Already actioned","threadId":"t4","labels":["INBOX","Actioned"]},
   {"who":"u@x.com","subject":"Urgent flag","threadId":"t5","labels":["INBOX","URGENT"]}
  ]
 },
 "counts": {}, "notes": []
}
JSON

run_json() { "$PY" "$SPLIT" --scan "$TMP/scan.json" --json "$@"; }

# --------------------------------------------------------------------------
# --scan must actually be honoured.
# Regression guard: a positional `scan` sharing its dest with --scan used to
# overwrite it with None, so the tool silently ran a LIVE scan instead of the
# file it was handed. On a machine with no bridge that looked like an empty
# inbox; on a real one it archived against freshly-scanned data nobody reviewed.
# --------------------------------------------------------------------------
run_json >"$TMP/out.json" 2>"$TMP/err.txt" || fail "run failed: $(cat "$TMP/err.txt")"
"$PY" - "$TMP/out.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
c = d["counts"]

# The fixture has exactly 5 email FYI rows; a live scan would not.
review = {r["threadId"] for r in d["review_fyi"]["email"]}
protected = {r["threadId"] for r in d["keep"]["email_protected"]}
assert review | protected == {"t1", "t2", "t3", "t4", "t5"}, \
    "--scan was ignored; the tool re-scanned instead of reading the file"

# Guardrail: todo/action labels are never archived. "Actioned" is completion,
# so it is ordinary FYI; "URGENT" is protected.
assert protected == {"t2", "t3", "t5"}, "wrong protected set: %s" % protected
assert review == {"t1", "t4"}, "wrong FYI review set: %s" % review

# FYI is NEVER part of the default sweep - it gets briefed, then the user
# decides. A default run must archive no mail at all.
assert d["archive"]["email"] == [], "FYI must never be auto-archived"
assert d["counts"]["archive_email"] == 0
assert {r["jid"] for r in d["review_fyi"]["whatsapp"]} == {"7@newsletter"}
assert "7@newsletter" not in {r["jid"] for r in d["archive"]["whatsapp_default"]}, \
    "whatsapp newsletters are FYI and must not be auto-archived"

# WhatsApp split.
keep = {r["who"] for r in d["keep"]["whatsapp_default"]}
arch = {r["who"] for r in d["archive"]["whatsapp_default"]}
assert keep == {"Asker", "ShortAsk", "BareMedia"}, "wrong keep set: %s" % keep
for who in ("Tail", "Stale", "Waiter", "DeadGroup"):
    assert who in arch, "%s should be archived" % who
assert "News" not in arch, "newsletters are FYI: brief them, never auto-archive"
assert "BareMedia" not in arch, "undescribed media must never be archived unread"
assert "LiveGroup" not in arch, "a live group must not be archived"

# A kept chat must never also appear in the archive set.
assert not (keep & arch), "overlap between keep and archive: %s" % (keep & arch)

assert c["keep_email_protected"] == 3
assert d["applied"] is False, "report-only run must not report applied"
print("split + guardrail: PASS")
PY

# --------------------------------------------------------------------------
# report-only default: no --apply means nothing is archived and nothing is
# reported as applied.
# --------------------------------------------------------------------------
"$PY" "$SPLIT" --scan "$TMP/scan.json" >"$TMP/plain.txt" 2>&1 \
  || fail "plain run failed"
grep -q "Report only" "$TMP/plain.txt" \
  || fail "default run must state that nothing was archived"
grep -q "apply_result" "$TMP/out.json" \
  && fail "report-only run must not carry an apply_result"

# --------------------------------------------------------------------------
# --apply --dry-run walks the apply path without calling out.
# The fixture carries no whatsapp_account, so a port must be supplied: without
# one the tool correctly refuses to archive rather than aim at a guessed bridge.
# --------------------------------------------------------------------------
run_json --apply --dry-run --default-bridge-port 8080 >"$TMP/dry.json" \
  || fail "dry-run failed"
"$PY" - "$TMP/dry.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
r = d["apply_result"]
assert d["applied"] is True and r["dry_run"] is True
assert r["whatsapp_failed"] == 0 and r["email_failed"] == 0
# Asker carries an alt_jid, so both of its JIDs are archived.
assert r["whatsapp_ok"] >= len(d["archive"]["whatsapp_default"]), "alt_jids must be archived too"
assert r["email_ok"] == 0, "a default sweep must not touch FYI mail"
print("dry-run apply: PASS")
PY

# --------------------------------------------------------------------------
# MULTI-ACCOUNT ROUTING (regression guard, 2026-09-06).
# Two defects shipped together and both were silent:
#   1. a merged scan tagged each row with its account, but the split dropped
#      the tag and stamped every row "default";
#   2. the archiver sent every row to ONE port, so a chat on number A was
#      archived against number B's bridge — the wrong-number class already
#      fixed once for sending.
# A row that carries bridge_port must route to THAT port, and an untagged row
# with no default must be refused rather than guessed.
# --------------------------------------------------------------------------
cat >"$TMP/multi.json" <<'JSON'
{
 "whatsapp": {
  "needs_reply": [],
  "waiting": [
   {"who":"OnA","jid":"11@s.whatsapp.net","alt_jids":[],"account":"acct_a","bridge_port":8483},
   {"who":"OnB","jid":"12@s.whatsapp.net","alt_jids":[],"account":"acct_b","bridge_port":8482},
   {"who":"Untagged","jid":"13@s.whatsapp.net","alt_jids":[]}
  ],
  "fyi": [], "groups": []
 },
 "counts": {}, "notes": []
}
JSON
"$PY" "$SPLIT" --scan "$TMP/multi.json" --json >"$TMP/multi-out.json" \
  || fail "multi-account run failed"
"$PY" - "$TMP/multi-out.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
rows = {r["who"]: r for r in d["archive"]["whatsapp_default"]}
assert rows["OnA"]["account"] == "acct_a", "account tag must survive the split"
assert rows["OnB"]["account"] == "acct_b", "account tag must survive the split"
assert rows["OnA"]["bridge_port"] == 8483, "each row must keep its own bridge port"
assert rows["OnB"]["bridge_port"] == 8482, "each row must keep its own bridge port"
assert rows["Untagged"]["account"] == "default", "an untagged row falls back to default"
assert "bridge_port" not in rows["Untagged"], "an untagged row must not invent a port"
print("multi-account tagging: PASS")
PY

# The untagged row has no port and no --default-bridge-port: it must be counted
# as a failure and skipped, never sent to whichever bridge happens to answer.
"$PY" "$SPLIT" --scan "$TMP/multi.json" --json --apply --dry-run \
  >"$TMP/multi-dry.json" 2>"$TMP/multi-dry.err" || fail "multi dry-run failed"
"$PY" - "$TMP/multi-dry.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
r = d["apply_result"]
assert r["whatsapp_ok"] == 2, "both tagged rows must route to their own bridge, got %s" % r
assert r["whatsapp_failed"] == 1, "the untagged row must be refused, not guessed"
print("per-row bridge routing: PASS")
PY
grep -q "no bridge port" "$TMP/multi-dry.err" \
  || fail "a skipped untagged row must say why on stderr"

# --------------------------------------------------------------------------
# stale window is configurable and actually moves a thread across the line.
# --------------------------------------------------------------------------
run_json --stale-days 99999 >"$TMP/wide.json" || fail "wide-window run failed"
"$PY" - "$TMP/wide.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
keep = {r["who"] for r in d["keep"]["whatsapp_default"]}
assert "Stale" in keep, "a wide stale window must keep the old open ask"
print("stale window: PASS")
PY

# --------------------------------------------------------------------------
# ReDoS guard (CodeQL py/redos). The ack test used to be one alternation
# wrapped in (...)* with overlapping branches, so a long almost-matching
# string backtracked exponentially and hung the scan. Classification must stay
# linear on hostile input.
# --------------------------------------------------------------------------
"$PY" - "$SPLIT" <<'PY' || exit 1
import sys, time, importlib.util
from importlib.machinery import SourceFileLoader

# The script has no .py suffix, so it needs an explicit source loader.
loader = SourceFileLoader("split", sys.argv[1])
spec = importlib.util.spec_from_loader("split", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

for probe in ("oké" * 4000 + "!", "ok" * 8000 + " ", " " * 20000 + "x"):
    start = time.time()
    mod.is_courtesy_tail(probe)
    spent = time.time() - start
    assert spent < 1.0, "classification took %.1fs on a %d-char message (ReDoS)" % (
        spent, len(probe))

# Behaviour the word-set must preserve.
assert mod.is_courtesy_tail("Thanks bro!") is True
assert mod.is_courtesy_tail("dankjewel!! 🙏") is True
assert mod.is_courtesy_tail("Can you resend the file?") is False
assert mod.is_courtesy_tail("Hoe was Ibiza?") is False
assert mod.is_courtesy_tail("") is True

# Undescribed media is UNKNOWN, never a tail. A bare "[image]" means the
# enricher has not read it yet, and the photo may be an invoice or a signed
# page - archiving it unread is how this tool would lose real work.
for placeholder in ("[image]", "[voice]", "[document]", "[video]", "[ IMAGE ]".strip()):
    assert mod.is_courtesy_tail(placeholder) is False, placeholder
assert mod.is_courtesy_tail("", "image") is False      # empty body + media row
assert mod.is_courtesy_tail("", "") is True            # genuinely nothing inbound
# Once enriched it classifies on the description like any other text.
assert mod.is_courtesy_tail("[image] invoice for 200 euro, due Friday") is False
print("redos + ack behaviour: PASS")
PY

# --------------------------------------------------------------------------
# --archive-fyi is the explicit opt-in the briefing leads to, and only then
# does FYI join the sweep.
# --------------------------------------------------------------------------
run_json --archive-fyi --apply --dry-run >"$TMP/fyi.json" || fail "--archive-fyi failed"
"$PY" - "$TMP/fyi.json" <<'PY' || exit 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["counts"]["archive_email"] == 2, "opt-in must sweep the 2 unprotected FYI"
assert d["apply_result"]["email_ok"] == 2
# Protected mail stays protected even under the opt-in.
ids = {r["threadId"] for r in d["archive"]["email"]}
assert ids == {"t1", "t4"}, ids
assert "7@newsletter" in {r["jid"] for r in d["archive"]["whatsapp_default"]}
print("--archive-fyi opt-in: PASS")
PY

echo "ops-inbox-archive-set: ALL PASS"
