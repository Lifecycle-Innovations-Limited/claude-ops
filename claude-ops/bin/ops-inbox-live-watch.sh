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
#   GOG_ACCOUNT                    mailbox to watch (default: gog's own configured
#                                   default account — set this only to pin a
#                                   non-default mailbox)
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

SEEN="$(mktemp "${TMPDIR:-/tmp}/.ops-inbox-seen-ids.XXXXXX")"
trap 'rm -f "$SEEN"' EXIT

gog gmail search "in:inbox" --max 15 -j --results-only --no-input 2>/dev/null \
  | python3 -c "import json,sys; [print(t['id']) for t in json.load(sys.stdin)]" > "$SEEN" 2>/dev/null

for i in $(seq 1 "$MAX_ITERS"); do
  sleep "$INTERVAL"
  NEW=$(gog gmail search "in:inbox" --max 15 -j --results-only --no-input 2>/dev/null | python3 -c "
import json, sys
seen = set(open('$SEEN').read().split())
for t in json.load(sys.stdin):
    if t['id'] not in seen:
        print(f\"NEW INBOX MAIL: {t['from']} | {t['subject']} | {t['date']} | id={t['id']}\")" 2>/dev/null)
  [ -n "$NEW" ] && { echo "$NEW"; exit 0; }
done

echo "watcher expired (~$(( MAX_ITERS * INTERVAL / 3600 ))h, no new mail)"
exit 0
