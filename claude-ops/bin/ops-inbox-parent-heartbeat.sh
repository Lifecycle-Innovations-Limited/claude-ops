#!/usr/bin/env bash
# Sleep INTERVAL (default 30s), print one INBOX HEARTBEAT line, exit 0.
# The parent launches this with Bash run_in_background at the start of
# /ops:ops-inbox. The job's exit IS the ping — relaunch immediately.
set -u

INTERVAL="${OPS_INBOX_HEARTBEAT_SEC:-30}"
ONCE=0
SCAN_JSON="${OPS_INBOX_SCAN_JSON:-/tmp/ops-inbox-scan-clean.json}"
KEEP_JSON="${OPS_INBOX_KEEP_JSON:-/tmp/ops-inbox-keep.json}"

usage() {
  cat <<'EOF'
ops-inbox-parent-heartbeat.sh — one 30s ping for the parent inbox session

  --once            print now, do not sleep
  --interval N      sleep N seconds (default 30, or OPS_INBOX_HEARTBEAT_SEC)
  --scan-json PATH  ops-inbox-scan JSON (default /tmp/ops-inbox-scan-clean.json)
  --keep-json PATH  keep JSON (default /tmp/ops-inbox-keep.json)
  -h, --help

Exit 0 after printing one INBOX HEARTBEAT line. The parent relaunches.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1; shift ;;
    --interval)
      if [ $# -lt 2 ]; then echo "ops-inbox-parent-heartbeat: --interval requires a value" >&2; exit 2; fi
      INTERVAL="$2"; shift 2
      ;;
    --scan-json)
      if [ $# -lt 2 ]; then echo "ops-inbox-parent-heartbeat: --scan-json requires a value" >&2; exit 2; fi
      SCAN_JSON="$2"; shift 2
      ;;
    --keep-json)
      if [ $# -lt 2 ]; then echo "ops-inbox-parent-heartbeat: --keep-json requires a value" >&2; exit 2; fi
      KEEP_JSON="$2"; shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ops-inbox-parent-heartbeat: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

case "$INTERVAL" in
  ''|*[!0-9]*) echo "ops-inbox-parent-heartbeat: interval must be an integer" >&2; exit 2 ;;
esac

if [ "$ONCE" -eq 0 ]; then
  sleep "$INTERVAL"
fi

summary="$(python3 - "$SCAN_JSON" "$KEEP_JSON" <<'PY'
import json, sys
scan_path, keep_path = sys.argv[1], sys.argv[2]
keep = waiting = "?"
nxt = "-"

def load(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None

def as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    return []

def who(rows):
    rows = as_list(rows)
    if rows and isinstance(rows[0], dict):
        return rows[0].get("who") or rows[0].get("from") or rows[0].get("name") or "-"
    return "-"

scan = load(scan_path)
keepj = load(keep_path)
if keepj is not None and ("keep" in keepj or "archive" in keepj):
    kr, ar = as_list(keepj.get("keep")), as_list(keepj.get("archive") or keepj.get("waiting"))
    keep, waiting, nxt = len(kr), len(ar), who(kr)
elif isinstance(scan, dict):
    wa, em = scan.get("whatsapp") or {}, scan.get("email") or {}
    nr = as_list(wa.get("needs_reply")) + as_list(em.get("needs_reply"))
    wt = as_list(wa.get("waiting")) + as_list(em.get("waiting"))
    keep, waiting, nxt = len(nr), len(wt), who(nr)
print(f"keep={keep} waiting={waiting} next={nxt}")
PY
)" || summary="keep=? waiting=? next=-"

echo "INBOX HEARTBEAT after=${INTERVAL}s ${summary}"
exit 0
