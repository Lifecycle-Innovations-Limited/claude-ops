#!/usr/bin/env bash
# ops-inbox-live-watch.sh — poll the Gmail inbox (via `gog`) and exit as soon as
# a NEW inbound message lands. Meant to be launched as a background job at the
# start of an ops-inbox session: the job's exit (with its summary line on
# stdout) IS the new-mail ping — the orchestrator restarts it after each ping.
#
# Cross-platform (Linux + macOS): pure bash + python3 + gog, no systemd/journalctl
# dependency, no GNU-only flags (mktemp/sleep/seq all behave the same in both
# BSD (macOS) and GNU (Linux) userlands here), $TMPDIR-safe seen-file.
#
# Env overrides:
#   GMAIL_ACCOUNT / GOG_ACCOUNT    mailbox to watch (default: gog whoami)
#   OPS_INBOX_WATCH_INTERVAL_SEC   poll interval in seconds (default 240 = 4min)
#   OPS_INBOX_WATCH_MAX_ITERS      max polls before giving up (default 90 = ~6h)
#
# Exit 0 always — either "NEW INBOX MAIL: ..." (new mail found) or
# "watcher expired (...)" (max iterations reached, no new mail).
set -u

set -a; . "$HOME/.mcp-secrets.env" 2>/dev/null; set +a

INTERVAL="${OPS_INBOX_WATCH_INTERVAL_SEC:-240}"
MAX_ITERS="${OPS_INBOX_WATCH_MAX_ITERS:-90}"

command -v gog >/dev/null 2>&1     || { echo "ops-inbox-live-watch: gog not found on PATH" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ops-inbox-live-watch: python3 not found on PATH" >&2; exit 2; }

GMAIL_ACCOUNT="${GMAIL_ACCOUNT:-${GOG_ACCOUNT:-}}"
if [ -z "$GMAIL_ACCOUNT" ]; then
  GMAIL_ACCOUNT="$(gog whoami 2>/dev/null | head -1 | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' || true)"
fi
ACCT_ARGS=()
[ -n "$GMAIL_ACCOUNT" ] && ACCT_ARGS=(-a "$GMAIL_ACCOUNT")

SEEN="$(mktemp "${TMPDIR:-/tmp}/.ops-inbox-seen-ids.XXXXXX")"
trap 'rm -f "$SEEN" "${SEEN}.err"' EXIT

if ! gog gmail search "${ACCT_ARGS[@]}" "in:inbox" --max 100 -j --results-only --no-input 2>"${SEEN}.err" \
  | python3 -c "import json,sys; [print(t['id']) for t in json.load(sys.stdin)]" > "$SEEN"; then
  echo "ops-inbox-live-watch: baseline inbox snapshot failed: $(head -c 200 "${SEEN}.err" 2>/dev/null | tr '\n' ' ')" >&2
  exit 2
fi
rm -f "${SEEN}.err"

for i in $(seq 1 "$MAX_ITERS"); do
  sleep "$INTERVAL"
  NEW=$(gog gmail search "${ACCT_ARGS[@]}" "in:inbox" --max 15 -j --results-only --no-input | python3 -c "
import json, sys
seen = set(open('$SEEN').read().split())
data = json.load(sys.stdin)
new_lines = []
for t in data:
    tid = t['id']
    if tid not in seen:
        new_lines.append(f\"NEW INBOX MAIL: {t['from']} | {t['subject']} | {t['date']} | id={tid}\")
    seen.add(tid)
if not new_lines:
    with open('$SEEN', 'w') as f:
        if seen:
            f.write('\n'.join(seen) + '\n')
for line in new_lines:
    print(line)")
  [ -n "$NEW" ] && { echo "$NEW"; exit 0; }
done

echo "watcher expired (~$(( MAX_ITERS * INTERVAL / 3600 ))h, no new mail)"
exit 0
