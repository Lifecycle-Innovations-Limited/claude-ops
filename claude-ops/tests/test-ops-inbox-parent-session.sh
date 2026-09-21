#!/usr/bin/env bash
# ops-inbox must run in the parent session and workers must report to it.
# A forked skill parks drafts in a side channel (measured 2026-09-21).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SKILL="$PLUGIN_ROOT/skills/ops-inbox/SKILL.md"
FANOUT="$PLUGIN_ROOT/skills/ops-inbox/references/fan-out.md"
HEARTBEAT="$PLUGIN_ROOT/bin/ops-inbox-parent-heartbeat.sh"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "ops-inbox parent-session gate"
echo ""

if [ ! -f "$SKILL" ]; then
  err "skill exists" "missing $SKILL"
else
  ok "skill exists"
fi

if [ -f "$SKILL" ]; then
  if awk 'BEGIN{in_fm=0} /^---$/{in_fm++; next} in_fm==1 && /^context:[[:space:]]*fork([[:space:]]|$)/{found=1} END{exit found?0:1}' "$SKILL"; then
    err "no context:fork in frontmatter" "skills/ops-inbox/SKILL.md still has context: fork"
  else
    ok "no context:fork in frontmatter"
  fi

  if grep -q 'Always report to the main agent by default' "$SKILL"; then
    ok "skill names the report-to-parent default"
  else
    err "skill names the report-to-parent default" "phrase missing from SKILL.md"
  fi

  if grep -q 'Never set `context: fork`' "$SKILL"; then
    ok "skill forbids context: fork"
  else
    err "skill forbids context: fork" "ban missing from SKILL.md"
  fi
fi

if [ ! -f "$FANOUT" ]; then
  err "fan-out exists" "missing $FANOUT"
else
  ok "fan-out exists"
  if grep -q 'Always report to the main agent by default' "$FANOUT"; then
    ok "fan-out names the report-to-parent default"
  else
    err "fan-out names the report-to-parent default" "phrase missing from fan-out.md"
  fi
fi

if [ -x "$HEARTBEAT" ] || [ -f "$HEARTBEAT" ]; then
  ok "heartbeat script exists"
else
  err "heartbeat script exists" "missing $HEARTBEAT"
fi

echo ""
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
