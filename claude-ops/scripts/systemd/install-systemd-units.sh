#!/usr/bin/env bash
# install-systemd-units.sh — install pocket pipeline systemd units on Linux.
# Run as root (or with sudo). Substitutes __USER__ / __HOME__ / __TAILSCALE_USER__
# placeholders and installs to /etc/systemd/system/.
#
# Usage:
#   sudo bash install-systemd-units.sh [username]
#
# username defaults to the SUDO_USER env var, then to the first non-root human
# account found in /etc/passwd.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Resolve target user ──────────────────────────────────────────────────────
TARGET_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$TARGET_USER" ]]; then
  TARGET_USER="$(getent passwd | awk -F: '$3>=1000 && $1!="nobody" {print $1; exit}')"
fi
if [[ -z "$TARGET_USER" ]]; then
  echo "ERROR: could not determine target user. Pass username as first argument." >&2
  exit 1
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TAILSCALE_USER="${TAILSCALE_USER:-$TARGET_USER}"

echo "Installing pocket systemd units for user=$TARGET_USER home=$TARGET_HOME"

# ── Copy + substitute units ──────────────────────────────────────────────────
UNITS=(
  pocket-watcher.service
  pocket-watcher.timer
  pocket-executor.service
  pocket-executor.timer
  pocket-activity-notifier.service
  pocket-activity-notifier.timer
  pocket-out-queue.service
  pocket-out-queue.timer
  pocket-email-bridge.service
  pocket-email-bridge.timer
  pocket-whatsapp-bridge.service
  pocket-whatsapp-bridge.timer
  whatsapp-baileys.service
  pocket-ops-ui.service
  cloudflared.service
  cloudflared-watchdog.service
  cloudflared-watchdog.timer
)

for unit in "${UNITS[@]}"; do
  src="$SCRIPT_DIR/$unit"
  if [[ ! -f "$src" ]]; then
    echo "WARNING: $src not found, skipping" >&2
    continue
  fi
  dest="/etc/systemd/system/$unit"
  sed \
    -e "s|__USER__|$TARGET_USER|g" \
    -e "s|__HOME__|$TARGET_HOME|g" \
    -e "s|__TAILSCALE_USER__|$TAILSCALE_USER|g" \
    "$src" > "$dest"
  chmod 644 "$dest"
  echo "  installed $dest"
done

# ── Reload + enable ──────────────────────────────────────────────────────────
systemctl daemon-reload

# Long-running services
for svc in whatsapp-baileys.service pocket-ops-ui.service; do
  systemctl enable "$svc"
  echo "  enabled $svc"
done

# Cloudflared tunnel (optional — only enable when /etc/cloudflared-watchdog.env
# exists and the unit ExecStart has been populated with a tunnel token).
if [[ -f /etc/cloudflared-watchdog.env ]] \
   && grep -q 'tunnel run --token ' /etc/systemd/system/cloudflared.service \
   && ! grep -q '${CLOUDFLARED_TUNNEL_TOKEN}' /etc/systemd/system/cloudflared.service; then
  systemctl enable cloudflared.service
  echo "  enabled cloudflared.service"
  systemctl enable cloudflared-watchdog.timer
  echo "  enabled cloudflared-watchdog.timer"
else
  echo "  SKIP cloudflared — /etc/cloudflared-watchdog.env missing OR token placeholder still present"
  echo "        edit /etc/systemd/system/cloudflared.service to replace \${CLOUDFLARED_TUNNEL_TOKEN}"
  echo "        with the real tunnel token from your Cloudflare Zero Trust dashboard,"
  echo "        then write /etc/cloudflared-watchdog.env (chmod 600) with:"
  echo "          CLOUDFLARE_API_TOKEN=<token with Account:Tunnel:Read scope>"
fi

# Timers (oneshot services triggered by timers)
for timer in \
  pocket-watcher.timer \
  pocket-executor.timer \
  pocket-activity-notifier.timer \
  pocket-out-queue.timer \
  pocket-email-bridge.timer \
  pocket-whatsapp-bridge.timer; do
  systemctl enable "$timer"
  echo "  enabled $timer"
done

echo ""
echo "Done. To START services now:"
echo "  sudo systemctl start whatsapp-baileys.service"
echo "  sudo systemctl start pocket-ops-ui.service"
echo "  sudo systemctl start pocket-watcher.timer pocket-executor.timer pocket-activity-notifier.timer pocket-out-queue.timer pocket-email-bridge.timer pocket-whatsapp-bridge.timer"
echo ""
echo "NOTE: whatsapp-baileys will need QR scan on first start."
echo "NOTE: pocket-ops-ui needs pocket-ops-ui/ app.py to exist."
