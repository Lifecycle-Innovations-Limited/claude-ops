#!/usr/bin/env bash
# Pocket webhook handler — receives validated events from the receiver.
# Args: $1 = event name. Payload read from stdin (Phase 0 fix 2026-05-29).
# Runs as root (pocket-webhook.service). Journals every event, then feeds it to
# the real-time triage ingest (runs AS ec2-user so pipeline state stays
# ec2-user-owned and consistent with the cron watcher).
set -euo pipefail

EVENT="${1:-unknown}"
EVENT_JSON="$(printf '%s' "$EVENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")')"
# Event name is attacker-controlled (comes from the webhook payload). Sanitize
# it before it ever touches a filesystem path — strip anything outside a safe
# charset and cap length, so it cannot traverse out of the journal dir.
SAFE_EVENT="$(printf '%s' "$EVENT" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
[ -n "$SAFE_EVENT" ] || SAFE_EVENT="unknown"
PAYLOAD="$(cat || true)"
[ -n "$PAYLOAD" ] || PAYLOAD="{}"
LOG_DIR="/var/log/pocket-webhook"
JOURNAL_DIR="/var/lib/pocket-webhook/journal"
QUEUE_TMP="/var/lib/pocket-webhook/ingest-tmp"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EPOCH="$(date -u +%s%N)"

mkdir -p "$LOG_DIR" "$JOURNAL_DIR" "$QUEUE_TMP"

# Append-only journal entry (one JSON-line per event)
printf '{"ts":"%s","event":%s,"payload":%s}\n' "$TS" "$EVENT_JSON" "$PAYLOAD" \
  >> "$JOURNAL_DIR/events.jsonl"

# Per-event copy for easy inspection (sanitized name — never raw $EVENT in a path)
printf '%s\n' "$PAYLOAD" > "$JOURNAL_DIR/${EPOCH}-${SAFE_EVENT}.json"

# Bound disk: prune per-event journal files older than 7 days, rotate the
# append-only log at 50MB. Lock-free and best-effort — must never break ingest.
find "$JOURNAL_DIR" -maxdepth 1 -name '*.json' -type f -mtime +7 -delete 2>/dev/null || true
if [ "$(stat -c%s "$JOURNAL_DIR/events.jsonl" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  mv -f "$JOURNAL_DIR/events.jsonl" "$JOURNAL_DIR/events.jsonl.1" 2>/dev/null || true
fi

# systemd journal trace
logger -t pocket-webhook "event=$EVENT bytes=${#PAYLOAD}"

# ── Real-time triage ingest ──────────────────────────────────────────────────
# Write the {ts,event,payload} envelope to a temp FILE and hand the path to
# ops-pocket-webhook-ingest.py (file-arg mode). File-arg avoids any stdin
# interaction with `sudo -u` / backgrounded subshells. Runs as ec2-user so
# state files match the cron watcher's owner. Fail-safe: errors here must NEVER
# break the webhook receiver — backgrounded + `|| true`; the journal above is
# the durable record regardless.
POCKET_STATE_DIR="${POCKET_STATE_DIR:-/var/lib/pocket-pipeline}"
INGEST="/opt/pocket-mcp/pipeline/ops-pocket-webhook-ingest.py"
ENVFILE="$QUEUE_TMP/${EPOCH}-${SAFE_EVENT}.json"
printf '{"ts":"%s","event":%s,"payload":%s}' "$TS" "$EVENT_JSON" "$PAYLOAD" > "$ENVFILE"
chmod 644 "$ENVFILE" 2>/dev/null || true
if [ -f "$INGEST" ]; then
  (
    sudo -u ec2-user env POCKET_STATE_DIR="$POCKET_STATE_DIR" \
      POCKET_WEBHOOK_INFER="${POCKET_WEBHOOK_INFER:-0}" \
      /usr/bin/python3 "$INGEST" "$ENVFILE" >>"$LOG_DIR/ingest.log" 2>&1
    rm -f "$ENVFILE"
  ) || true &
fi

printf '%s handler-fired event=%s ingest=%s\n' "$TS" "$EVENT" \
  "$([ -f "$INGEST" ] && echo queued || echo missing)" >> "$LOG_DIR/handler.log"
