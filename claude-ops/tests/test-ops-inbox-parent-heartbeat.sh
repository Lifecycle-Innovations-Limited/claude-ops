#!/usr/bin/env bash
# Guard: /ops:ops-inbox pings the parent every 30s by default.
# The heartbeat script's exit IS the ping (same pattern as live-watch).
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

if grep -q '30-second parent heartbeat' "$SKILL" && grep -q 'ops-inbox-parent-heartbeat.sh' "$SKILL"; then
  ok "skill launches the heartbeat"
else
  err "skill missing 30-second heartbeat launch"
fi

if grep -q 'SendMessage' "$SKILL" && grep -q 'every 30' "$FANOUT"; then
  ok "workers SendMessage parent every 30s"
else
  err "fan-out/skill missing 30s SendMessage"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if (( fail > 0 )); then
  exit 1
fi
exit 0
