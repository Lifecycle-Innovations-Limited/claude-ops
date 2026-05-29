#!/usr/bin/env bash
# test-ops-pocket-notify.sh — config-driven notification dispatcher: channel
# resolution, off-by-default, per-event schedule (inactive-day), severity
# escalation past the schedule, and cooldown rate-limiting. No external channels:
# uses the 'email' channel which enqueues to a local out-queue file.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTIFY="$PLUGIN_ROOT/scripts/ops-pocket-notify.py"
PY="$(command -v python3 || true)"

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() {
  echo "  FAIL: $1 — $2"
  fail=$((fail + 1))
}

echo "Testing ops-pocket-notify"
echo ""
if [[ -z "$PY" ]]; then
  echo "  SKIP: python3 unavailable"
  echo "test-ops-pocket-notify.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NOT_TODAY="$("$PY" -c 'import datetime;print((datetime.date.today().weekday()+1)%7)')"
cat >"$TMP/prefs.json" <<JSON
{"pocket":{"notifications":{"default_cooldown":300,"events":{
  "t.on":{"channels":["email"],"severity":"medium"},
  "t.off":{"channels":[]},
  "t.sched":{"channels":["email"],"severity":"medium","schedule":{"active_days":[$NOT_TODAY]}},
  "t.high":{"channels":["email"],"severity":"high","schedule":{"active_days":[$NOT_TODAY]}},
  "t.cool":{"channels":["email"],"severity":"medium","schedule":{"cooldown":300}}
}}}}
JSON

dry() { PREFS_PATH="$TMP/prefs.json" POCKET_STATE_DIR="$TMP" "$PY" "$NOTIFY" "$1" msg --dry-run --json 2>/dev/null; }
live() { PREFS_PATH="$TMP/prefs.json" POCKET_STATE_DIR="$TMP" "$PY" "$NOTIFY" "$1" msg --json 2>/dev/null; }

echo "$(dry t.on)" | grep -q '"fired": \["email"\]' && ok "configured event resolves to its channels" || err "t.on" "$(dry t.on)"
echo "$(dry t.off)" | grep -q '"suppressed": "no_channels_configured"' && ok "unconfigured event is off by default" || err "t.off" "$(dry t.off)"
echo "$(dry t.sched)" | grep -q '"suppressed": "inactive_day"' && ok "schedule suppresses medium outside active days" || err "t.sched" "$(dry t.sched)"
HI="$(dry t.high)"
if echo "$HI" | grep -q '"fired": \["email"\]'; then ok "high severity escalates past the schedule"; else err "t.high" "$HI"; fi

# cooldown: first live send fires (enqueues email), second within window is suppressed
R1="$(live t.cool)"
R2="$(live t.cool)"
if echo "$R1" | grep -q '"fired": \["email"\]' && echo "$R2" | grep -q '"suppressed": "cooldown"'; then
  ok "cooldown suppresses a repeat within the window"
else
  err "cooldown" "first=$R1 second=$R2"
fi
# the first live send should have enqueued an email to the out-queue
if [[ -f "$TMP/supervisor-out-queue.jsonl" ]] && grep -q '"kind": "email"' "$TMP/supervisor-out-queue.jsonl"; then
  ok "email channel enqueues to the out-queue"
else
  err "out-queue" "no email record: $(cat "$TMP/supervisor-out-queue.jsonl" 2>/dev/null)"
fi

echo ""
echo "test-ops-pocket-notify.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
