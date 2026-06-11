#!/usr/bin/env bash
# setup-wa-mac-cf-tunnel.sh — wire the Cloudflare-tunnel SSH fallback to the
# owner's Mac (transport 2 of wa-mac-transport.sh).
#
# What it does:
#   LOCAL (this box):  installs cloudflared if missing (dnf/apt/brew).
#   MAC   (over the currently-working SSH path, usually Tailscale):
#     - installs cloudflared via brew if missing
#     - installs the tunnel as a LaunchDaemon using a remotely-managed tunnel
#       token (CF_TUNNEL_TOKEN) so it survives reboots
#   Prints the env exports to add to your shell profile.
#
# Prereqs (one-time, in the Cloudflare Zero Trust dashboard):
#   1. Create a tunnel (remotely-managed), copy its token → CF_TUNNEL_TOKEN
#   2. Add a public hostname route: <WA_MAC_CF_HOST> → ssh://localhost:22
#   3. (Recommended) Add an Access application + service token or allow-policy
#      for that hostname so the SSH port isn't open to the world.
#
# Usage:
#   WA_MAC_SSH=user@mac-tailscale-ip \
#   WA_MAC_CF_HOST=ssh-mac.example.com \
#   CF_TUNNEL_TOKEN=<token> \
#   bash setup-wa-mac-cf-tunnel.sh
set -euo pipefail

: "${WA_MAC_SSH:?set WA_MAC_SSH=user@mac-host (a currently-working SSH path to the Mac)}"
: "${WA_MAC_CF_HOST:?set WA_MAC_CF_HOST=ssh hostname routed in the CF tunnel}"
: "${CF_TUNNEL_TOKEN:?set CF_TUNNEL_TOKEN=<remotely-managed tunnel token>}"

echo "▶ 1/3 local cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/').rpm
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb
  elif command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    echo "install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2; exit 1
  fi
fi
cloudflared --version

echo "▶ 2/3 Mac-side cloudflared LaunchDaemon (over $WA_MAC_SSH)"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$WA_MAC_SSH" "
  set -e
  if ! command -v cloudflared >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then brew install cloudflared
    else echo 'brew missing on Mac — install cloudflared manually' >&2; exit 1; fi
  fi
  # idempotent: reinstall service with the (possibly rotated) token
  sudo -n cloudflared service uninstall >/dev/null 2>&1 || true
  sudo -n cloudflared service install '$CF_TUNNEL_TOKEN'
  sleep 3
  sudo -n launchctl list | grep -i cloudflare || true
  echo 'mac: cloudflared service installed'
"

echo "▶ 3/3 verify CF path end-to-end"
USER_PART="${WA_MAC_SSH%%@*}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 \
     -o ProxyCommand="cloudflared access ssh --hostname $WA_MAC_CF_HOST" \
     "${USER_PART}@${WA_MAC_CF_HOST}" true; then
  echo "✓ Cloudflare-tunnel SSH to Mac works"
else
  echo "✗ CF path not working yet — check the tunnel's public-hostname route (ssh://localhost:22) and Access policy" >&2
  exit 1
fi

cat <<EOF

Add to your shell profile (and the daemon env if used by timers):
  export WA_MAC_SSH=$WA_MAC_SSH
  export WA_MAC_CF_HOST=$WA_MAC_CF_HOST
EOF
