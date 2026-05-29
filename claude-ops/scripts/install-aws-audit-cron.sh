#!/usr/bin/env bash
###############################################################################
# install-aws-audit-cron.sh — install a daily systemd --user timer that runs
# ops-aws-audit.sh. Linux/systemd (this fleet uses systemd, not launchd).
#
# Env:
#   AUDIT_ONCALENDAR   systemd OnCalendar expr (default: *-*-* 03:00:00)
#   AUDIT_PROFILE / AUDIT_REGIONS / AUDIT_OUTPUT_DIR  passed through to the audit
###############################################################################
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/ops-aws-audit.sh"
[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"
ONCAL="${AUDIT_ONCALENDAR:-*-*-* 03:00:00}"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/ops-aws-audit.service" <<UNIT
[Unit]
Description=ops AWS account audit (read-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Credentials via standard AWS chain. Set AUDIT_PROFILE here if you use a named profile.
Environment=AUDIT_PROFILE=${AUDIT_PROFILE:-}
Environment=AUDIT_REGIONS=${AUDIT_REGIONS:-}
Environment=AUDIT_OUTPUT_DIR=${AUDIT_OUTPUT_DIR:-%h/.aws-audit-history/audit-%i}
ExecStart=/usr/bin/env bash $SCRIPT --quiet
UNIT

cat > "$UNIT_DIR/ops-aws-audit.timer" <<UNIT
[Unit]
Description=Daily ops AWS account audit

[Timer]
OnCalendar=$ONCAL
Persistent=true
AccuracySec=10min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now ops-aws-audit.timer
echo "✓ installed ops-aws-audit.timer (OnCalendar='$ONCAL')"
systemctl --user list-timers ops-aws-audit.timer --no-pager 2>/dev/null || true
