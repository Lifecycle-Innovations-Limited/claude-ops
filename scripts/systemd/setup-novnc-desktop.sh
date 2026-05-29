#!/usr/bin/env bash
# setup-novnc-desktop.sh — make a headless box's TigerVNC desktop reachable as a
# browser-based noVNC client over Tailscale, persistent across reboots.
#
# Idempotent. Safe to re-run. Installs nothing it can't find a reason to.
#
# Layers it wires up:
#   1. TigerVNC server on display :1  -> systemd `vncserver@:1.service` (must exist)
#   2. noVNC proxy :6080 -> localhost:5901 -> systemd --user `novnc.service` (this script)
#   3. HTTPS front over the tailnet -> `tailscale serve --bg 6080`
#   4. linger ON so the --user service runs without an interactive login
#
# Prereqs assumed already present: tigervnc-server, a configured `vncserver@:1`,
# python3, git, tailscale (logged in). The script checks and warns if missing.
set -euo pipefail

VNC_DISPLAY="${VNC_DISPLAY:-1}"
VNC_PORT="${VNC_PORT:-$((5900 + VNC_DISPLAY))}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
NOVNC_DIR="${NOVNC_DIR:-$HOME/noVNC}"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/novnc.service"
USER_UNIT_DIR="$HOME/.config/systemd/user"

log() { printf '\033[36m[novnc-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[novnc-setup] WARN:\033[0m %s\n' "$*" >&2; }

# 1. websockify (user-site pip; system python is restricted on AL2023)
if ! python3 -c 'import websockify' 2>/dev/null; then
  log "installing websockify (pip --user)"
  pip3 install --user --quiet websockify
fi

# 2. noVNC web client
if [ ! -f "$NOVNC_DIR/vnc.html" ]; then
  log "cloning noVNC -> $NOVNC_DIR"
  git clone --depth 1 https://github.com/novnc/noVNC.git "$NOVNC_DIR"
fi

# 3. install + enable the user service
mkdir -p "$USER_UNIT_DIR"
sed -e "s/__NOVNC_PORT__/${NOVNC_PORT}/g" -e "s/__VNC_PORT__/${VNC_PORT}/g" \
  "$UNIT_SRC" >"$USER_UNIT_DIR/novnc.service"
chmod 0644 "$USER_UNIT_DIR/novnc.service"
systemctl --user daemon-reload
systemctl --user enable --now novnc.service
log "novnc.service: $(systemctl --user is-enabled novnc.service) / $(systemctl --user is-active novnc.service)"

# 4. linger so the user unit survives logout / starts at boot
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  log "enabling linger for $USER"
  sudo loginctl enable-linger "$USER"
fi

# 5. VNC server enabled on boot
if systemctl list-unit-files "vncserver@.service" >/dev/null 2>&1; then
  if [ "$(systemctl is-enabled "vncserver@:${VNC_DISPLAY}.service" 2>/dev/null)" != "enabled" ]; then
    log "enabling vncserver@:${VNC_DISPLAY}.service"
    sudo systemctl enable "vncserver@:${VNC_DISPLAY}.service"
  fi
else
  warn "vncserver@.service not installed — install tigervnc-server and configure :${VNC_DISPLAY} first"
fi

# 6. HTTPS front over Tailscale (config persists in tailscaled state across reboots)
if command -v tailscale >/dev/null 2>&1; then
  log "asserting tailscale serve -> :${NOVNC_PORT}"
  sudo tailscale serve --bg "${NOVNC_PORT}" || warn "tailscale serve failed (is tailscaled up & logged in?)"
else
  warn "tailscale not found — skipping HTTPS front; use http://<tailnet-ip>:${NOVNC_PORT}/vnc.html"
fi

# 7. kill the GNOME idle screen-lock (it interrupts long remote sessions)
if command -v gsettings >/dev/null 2>&1; then
  DISP=":${VNC_DISPLAY}"
  if DISPLAY="$DISP" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
       gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null; then
    DISPLAY="$DISP" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
      gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
    log "disabled GNOME idle screen-lock"
  fi
fi

cat <<EOF

[novnc-setup] done.
  Local:    http://localhost:${NOVNC_PORT}/vnc.html
  Tailnet:  http://\$(tailscale ip -4 | head -1):${NOVNC_PORT}/vnc.html
  HTTPS:    https://<magicdns-name>/vnc.html  (if tailscale serve succeeded)
  VNC pw:   set with  printf '%s\\n' '<pw>' | vncpasswd -f > ~/.vnc/passwd
EOF
