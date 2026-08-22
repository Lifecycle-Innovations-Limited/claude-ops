#!/bin/bash
# Checks that the Python and Node sides see the same approval store.
#
# Run: bash claude-ops/tests/outbound-guard/test-shared-guard.sh
# Requires python3 and node. Only touches /tmp/.claude-outbound-guard.json.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../scripts/outbound-guard" && pwd)"
PY="$SRC/outbound_guard.py"
MJS="$SRC/outbound-guard.mjs"
S=/tmp/.claude-outbound-guard.json
fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', expected '$3'"; fail=$((fail+1)); fi; }
left(){ python3 "$PY" peek | sed 's/.*remaining=\([0-9]*\).*/\1/'; }

rm -f "$S" /tmp/.claude-send-ok

echo "1. fingerprint identical in both languages"
A=$(python3 -c "import sys;sys.path.insert(0,'$SRC');import outbound_guard as g;print(g.fingerprint('a@b.com','Hallo  daar\n\nSam'))")
B=$(node --input-type=module -e "import {fingerprint} from '$MJS'; console.log(fingerprint('a@b.com','Hallo  daar\n\nSam'))")
chk "same fingerprint" "$A" "$B"

echo "2. mint 3, then three different messages"
python3 "$PY" mint 3 900 >/dev/null
python3 "$PY" consume "x@y.com" "een"  >/dev/null; r1=$?
python3 "$PY" consume "x@y.com" "twee" >/dev/null; r2=$?
python3 "$PY" consume "x@y.com" "drie" >/dev/null; r3=$?
python3 "$PY" consume "x@y.com" "vier" >/dev/null; r4=$?
chk "1st allowed" "$r1" "0"
chk "2nd allowed" "$r2" "0"
chk "3rd allowed" "$r3" "0"
chk "4th denied" "$r4" "1"

echo "3. same message across two layers costs one unit"
rm -f "$S"; python3 "$PY" mint 2 900 >/dev/null
python3 "$PY" consume "z@z.com" "zelfde tekst" >/dev/null
L1=$(left)
node --input-type=module -e "import {consume} from '$MJS'; process.exit(consume('z@z.com','zelfde tekst')?0:1)"; rn=$?
L2=$(left)
chk "node allows"     "$rn" "0"
chk "counter after python"   "$L1" "1"
chk "counter unchanged" "$L2" "1"

echo "4. node does deduct for a different message"
node --input-type=module -e "import {consume} from '$MJS'; process.exit(consume('z@z.com','ander bericht')?0:1)" >/dev/null; rn2=$?
chk "different message allowed" "$rn2" "0"
chk "counter now 0"       "$(left)" "0"

echo "5. empty means deny"
python3 "$PY" consume "q@q.com" "nog een" >/dev/null; r5=$?
chk "denied at zero" "$r5" "1"

rm -f "$S" /tmp/.claude-send-ok
echo
[ "$fail" -eq 0 ] && echo "ALL GOOD" || echo "$fail FAIL"
exit $fail
