#!/bin/bash
# Checks the contract between the Node twin and the Python guard it delegates to.
#
# This test used to assert that outbound-guard.mjs and the bundled outbound_guard.py
# agreed about a count-based store: mint 3, spend 3, deny the 4th. It passed because BOTH
# files were on that schema. It could not catch the actual failure, which was the two
# implementations drifting apart, because it only ever compared them with each other.
#
# outbound-guard.mjs no longer implements the store. It hands every decision to
# outbound_guard.py over stdin (OUTBOUND_GUARD_PY), precisely so there is one
# implementation of the approved set, the in-flight window and the ledger instead of two
# to keep in step. So the thing to test is the contract, not a second copy of the logic:
# does the Node side pass the message through unchanged, does it answer what the guard
# answered, and does it fail CLOSED when the guard cannot be reached.
#
# The delegate here is a stub, on purpose. A stub pins the contract without dragging in
# the real guard's locking, ledger and audit file.
#
# Run: bash claude-ops/tests/outbound-guard/test-shared-guard.sh
# Requires python3 and node. Touches /tmp/.claude-send-ok (legacy token path).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../scripts/outbound-guard" && pwd)"
MJS="$SRC/outbound-guard.mjs"
REPO_PY="$SRC/outbound_guard.py"
TOKEN=/tmp/.claude-send-ok

fail=0
ok(){ echo "  ok   $1"; }
bad(){ echo "  FAIL $1"; fail=$((fail+1)); }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', expected '$3'"; fi; }

TD="$(mktemp -d)"
trap 'rm -rf "$TD"; rm -f "$TOKEN"' EXIT
STUB="$TD/stub_guard.py"
LOG="$TD/calls.jsonl"

cat > "$STUB" <<'PYEOF'
"""Stub delegate. Answers yes or no on command and records what it was asked."""
import hashlib, json, os

SPENT_WINDOW_SEC = 120
_ANSWER = os.environ.get("STUB_ANSWER", "1") == "1"
_LOG = os.environ.get("STUB_LOG", "")

if os.environ.get("STUB_MODE") == "crash":
    raise RuntimeError("stub guard refuses to load")


def _log(fn, **kw):
    if _LOG:
        with open(_LOG, "a") as fh:
            fh.write(json.dumps({"fn": fn, **kw}) + "\n")


def fingerprint(recipient: str, body: str) -> str:
    r = str(recipient or "").strip().lower()
    b = "\n".join(ln.rstrip() for ln in str(body or "").split("\n")).rstrip("\n")
    return hashlib.sha256(f"{r}|{b}".encode()).hexdigest()[:32]


def identify_args(tool_input: dict):
    return str(tool_input.get("to", "")), str(tool_input.get("body", ""))


def peek():
    return (2, 300)


def consume(recipient="", body="", session_id="", tool=""):
    _log("consume", recipient=recipient, body=body, session_id=session_id, tool=tool)
    return _ANSWER


def claim_reservation(recipient="", body="", guard="", session_id="", tool=""):
    _log("claim", recipient=recipient, body=body, guard=guard,
         session_id=session_id, tool=tool)
    return _ANSWER
PYEOF

node_consume(){ # $1 recipient  $2 body
  node --input-type=module -e "import {consume} from '$MJS'; process.exit(consume(process.argv[1], process.argv[2], {tool:'Bash', sessionId:'s-1'})?0:1)" -- "$1" "$2"
}
node_claim(){ # stdin: JSON opts
  node --input-type=module -e "import {claimReservation} from '$MJS'; let b=''; process.stdin.on('data',d=>b+=d).on('end',()=>process.exit(claimReservation(JSON.parse(b))?0:1))"
}

echo "1. the Node fingerprint is the per-line rstrip one, byte for byte"
# The drifted version collapsed ALL whitespace and truncated to 400 chars. A body with
# trailing spaces, interior blank lines and more than 400 chars separates the two.
B="$(printf 'Hallo  daar   \n\nSam\n')$(python3 -c 'print("x"*500)')"
export B
FP_PY=$(python3 -c "import sys,os;sys.path.insert(0,'$TD');import stub_guard as g;print(g.fingerprint('A@B.com ',os.environ['B']))")
FP_JS=$(node --input-type=module -e "import {fingerprint} from '$MJS'; console.log(fingerprint('A@B.com ', process.env.B))")
chk "same fingerprint in both languages" "$FP_PY" "$FP_JS"
OLD=$(node --input-type=module -e "
import crypto from 'node:crypto';
const r='a@b.com', b=process.env.B.split(/\s+/).filter(Boolean).join(' ').slice(0,400);
console.log(crypto.createHash('sha256').update(r+'|'+b).digest('hex').slice(0,32));")
if [ "$FP_JS" = "$OLD" ]; then bad "still using the drifted collapse+truncate normaliser"; else ok "differs from the drifted collapse+truncate normaliser"; fi

echo "2. a yes from the guard is a yes, and the message reaches it unchanged"
rm -f "$LOG" "$TOKEN"
OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=1 STUB_LOG="$LOG" node_consume "x@y.com" "$(printf 'regel een\nregel twee')"
chk "consume allowed" "$?" "0"
got_r=$(python3 -c "import json,sys;print(json.loads(open('$LOG').readline())['recipient'])" 2>/dev/null || echo MISSING)
got_b=$(python3 -c "import json;print(repr(json.loads(open('$LOG').readline())['body']))" 2>/dev/null || echo MISSING)
got_t=$(python3 -c "import json;print(json.loads(open('$LOG').readline())['tool'])" 2>/dev/null || echo MISSING)
chk "recipient passed through" "$got_r" "x@y.com"
chk "body passed through with its newline" "$got_b" "'regel een\nregel twee'"
chk "tool reaches the ledger" "$got_t" "Bash"

echo "3. a no from the guard is a no, and a fresh legacy token does NOT rescue it"
touch "$TOKEN"
OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=0 node_consume "x@y.com" "geweigerd"
chk "consume denied" "$?" "1"
if [ -f "$TOKEN" ]; then ok "legacy token untouched by a refusal"; else bad "refusal ate the legacy token"; fi

echo "4. guard unreachable: the legacy token is the ONLY fallback, once"
rm -f "$TOKEN"; touch "$TOKEN"
OUTBOUND_GUARD_PY="$TD/does-not-exist.py" node_consume "x@y.com" "via token"
chk "allowed on a fresh token" "$?" "0"
if [ -f "$TOKEN" ]; then bad "token not spent"; else ok "token spent (single use)"; fi
OUTBOUND_GUARD_PY="$TD/does-not-exist.py" node_consume "x@y.com" "via token"
chk "second send denied" "$?" "1"

echo "5. guard crashes on load: treated as unreachable, and deny without a token"
rm -f "$TOKEN"
OUTBOUND_GUARD_PY="$STUB" STUB_MODE=crash node_consume "x@y.com" "crash"
chk "denied when the guard cannot load and no token exists" "$?" "1"

echo "6. claimReservation fails closed on every uncertainty"
printf '{"recipient":"x@y.com","body":"b","sessionId":"s-1","tool":"Bash"}' | OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=1 node_claim
chk "no guard name -> false" "$?" "1"
printf '{"guard":"mcp-proxy","recipient":"x@y.com","body":"b"}' | OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=1 node_claim
chk "guard says yes -> true" "$?" "0"
printf '{"guard":"mcp-proxy","recipient":"x@y.com","body":"b"}' | OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=0 node_claim
chk "guard says no -> false" "$?" "1"
touch "$TOKEN"
printf '{"guard":"mcp-proxy","recipient":"x@y.com","body":"b"}' | OUTBOUND_GUARD_PY="$TD/does-not-exist.py" node_claim
chk "guard unreachable -> false even with a fresh token" "$?" "1"
if [ -f "$TOKEN" ]; then ok "claim never spends the legacy token"; else bad "claim spent the legacy token"; fi
rm -f "$TOKEN"

echo "7. the reservation is identified from the tool arguments by the GUARD, not by Node"
rm -f "$LOG"
printf '{"guard":"mcp-proxy","args":{"to":"from-args@y.com","body":"uit args"},"recipient":"wrong@y.com","body":"verkeerd"}' \
  | OUTBOUND_GUARD_PY="$STUB" STUB_ANSWER=1 STUB_LOG="$LOG" node_claim
chk "claim allowed" "$?" "0"
got=$(python3 -c "import json;d=json.loads(open('$LOG').readline());print(d['recipient'],'|',d['body'])" 2>/dev/null || echo MISSING)
chk "identify_args() output wins over the Node-side pair" "$got" "from-args@y.com | uit args"

echo "8. note: the bundled outbound_guard.py is NOT yet a valid delegate"
# Informational, not a failure. The repo copy is still the retired count-based CLI
# (`mint <n> <ttl>`), while the guard the installed twin delegates to lives at
# ~/.claude/scripts/hooks/outbound_guard.py and is reservation-based. Bringing the
# bundled copy forward also means migrating `scripts/outbound-guard/ok`, which is a
# separate change; until then the Node twin delegates to the installed guard, and fails
# closed if it is absent.
if grep -q 'def claim_reservation' "$REPO_PY"; then
  echo "  note bundled outbound_guard.py now exposes claim_reservation() — point test 1 at it and drop this note"
else
  echo "  note bundled outbound_guard.py is still count-based; the delegate is the installed guard (see README)"
fi

echo
[ "$fail" -eq 0 ] && echo "ALL GOOD" || echo "$fail FAIL"
exit $fail
