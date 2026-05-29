#!/usr/bin/env bash
# email-cos-status.sh [--tg]   one-glance health of the email chief-of-staff
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

SD="$EMAIL_COS_STATE_DIR"
today=$(date +%Y-%m-%d)
q=$(ls -1 "$SD/pending.d" 2>/dev/null | wc -l); q=${q:-0}
sweeps=$(grep -c "\"ts\":\"$today.*sweep" "$SD/metrics.jsonl" 2>/dev/null || echo 0)
orchs=$(grep -c "\"ts\":\"$today.*orch" "$SD/metrics.jsonl" 2>/dev/null || echo 0)
errs=$(grep "$today" "$SD/metrics.jsonl" 2>/dev/null | grep -c '"exit":[^0]' || echo 0)

out=$(
  echo "EMAIL CHIEF-OF-STAFF — $(date '+%Y-%m-%d %H:%M %Z')"
  echo "timers:"
  systemctl --user list-timers 'email-cos*' --no-pager 2>/dev/null | grep email-cos \
    | awk '{print "  "$NF": next "$1" "$2}' || true
  echo "linger: $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  echo "queue (awaiting orchestrator): $q"
  echo "today: sweeps=$sweeps orch=$orchs errors=$errs"
  echo "last runs:"; tail -3 "$SD/metrics.jsonl" 2>/dev/null | sed 's/^/  /' || true
  echo "last digest:"; tail -6 "$SD/digest.txt" 2>/dev/null | sed 's/^/  /' || true
)

echo "$out"
[ "${1:-}" = "--tg" ] && "$_SCRIPT_DIR/email-cos-notify.sh" "$out" >/dev/null 2>&1 || true
exit 0
