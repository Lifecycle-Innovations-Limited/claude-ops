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
grep -q 'WHERE archived=0 OR last_message_time' "$CODE" \
  || fail "whatsapp working set must be driven by the archived flag"

# gog treats bare args as MESSAGE ids; the scan emits THREAD ids.
grep -q '"--thread"' "$SPLIT" \
  || fail "gmail archive must pass --thread when given thread ids"

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
# --------------------------------------------------------------------------
run_json --apply --dry-run >"$TMP/dry.json" || fail "dry-run failed"
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
