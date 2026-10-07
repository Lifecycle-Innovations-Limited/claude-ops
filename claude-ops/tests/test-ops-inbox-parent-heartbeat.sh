#!/usr/bin/env bash
# Keep the optional heartbeat utility tested, but inbox instructions follow the
# host's cadence and deliver ready evidence instead of creating a polling loop.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HB="$PLUGIN_ROOT/bin/ops-inbox-parent-heartbeat.sh"
SKILL="$PLUGIN_ROOT/skills/ops-inbox/SKILL.md"
FANOUT="$PLUGIN_ROOT/skills/ops-inbox/references/fan-out.md"

pass=0
fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: ops-inbox 30s parent heartbeat"
echo ""

if [[ -x "$HB" ]]; then
  ok "heartbeat script is executable"
else
  err "heartbeat script missing or not executable: $HB"
fi

if grep -q 'default 30' "$HB" && grep -q 'OPS_INBOX_HEARTBEAT_SEC:-30' "$HB"; then
  ok "default interval is 30 seconds"
else
  err "default interval is not 30 seconds"
fi

help="$("$HB" --help 2>&1)"
case "$help" in
  *"30s"*|*"30 second"*) ok "help names 30s" ;;
  *) err "help does not name 30s: $help" ;;
esac

missing="${TMPDIR:-/tmp}/ois-missing-$$.json"
out="$("$HB" --once --scan-json "$missing" --keep-json "$missing" 2>&1)"
rc=$?
if [[ "$rc" -eq 0 ]]; then
  ok "--once exits 0"
else
  err "--once exit=$rc"
fi
case "$out" in
  INBOX\ HEARTBEAT\ after=30s*) ok "--once prints INBOX HEARTBEAT after=30s" ;;
  *) err "--once output was: $out" ;;
esac

scan="$(mktemp "${TMPDIR:-/tmp}/ois-scan.XXXXXX")"
printf '%s\n' '{"whatsapp":{"needs_reply":[{"who":"Ada"}],"waiting":[{},{}]},"email":{"needs_reply":[],"waiting":[]}}' > "$scan"
out="$("$HB" --once --scan-json "$scan" --keep-json "$missing" 2>&1)"
rm -f "$scan"
case "$out" in
  *'keep=1 waiting=2 next=Ada'*) ok "summarises scan JSON" ;;
  *) err "scan summary was: $out" ;;
esac

if grep -q "host's cadence" "$SKILL" && ! grep -q 'ops-inbox-parent-heartbeat.sh' "$SKILL"; then
  ok "skill follows host cadence without launching a polling loop"
else
  err "skill overrides host cadence or launches a heartbeat loop"
fi

if grep -q 'SendMessage' "$FANOUT" && grep -q 'as soon as' "$FANOUT" && ! grep -q 'every 30' "$FANOUT"; then
  ok "workers report ready evidence progressively, without a fixed heartbeat"
else
  err "fan-out lacks progressive reporting or mandates a fixed heartbeat"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if (( fail > 0 )); then
  exit 1
fi
exit 0
