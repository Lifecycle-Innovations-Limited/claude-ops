#!/usr/bin/env bash
# Install the CLIProxy healer onto a hub that already runs crsproxy.
# Copies policy/tick modules to /opt/crsproxy/heal and enables the systemd timer.
# Run on the hub as root. No secrets are written.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../account-rotation" && pwd)"
DEST="${CLIPROXY_HEAL_DEST:-/opt/crsproxy/heal}"
UNIT_DIR="${CLIPROXY_UNIT_DIR:-/etc/systemd/system}"
TEMPLATE_DIR="$(cd "$(dirname "$0")/../../templates" && pwd)"

mkdir -p "$DEST"
install -m 0755 "$SRC/cliproxy-heal-tick.mjs" "$DEST/cliproxy-heal-tick.mjs"
install -m 0644 "$SRC/cliproxy-heal-policy.mjs" "$DEST/cliproxy-heal-policy.mjs"
install -m 0644 "$SRC/cliproxy-heal-ai.mjs" "$DEST/cliproxy-heal-ai.mjs"
install -m 0644 "$SRC/cliproxy-pool-snapshot.mjs" "$DEST/cliproxy-pool-snapshot.mjs"
install -m 0644 "$SRC/auto-auth-policy.mjs" "$DEST/auto-auth-policy.mjs"
install -m 0644 "$SRC/cliproxy-isolate-compat.mjs" "$DEST/cliproxy-isolate-compat.mjs"
mkdir -p /opt/crsproxy/isolated
if [ ! -f /opt/crsproxy/isolated/manifest.json ]; then
  printf '%s\n' '{"providers":["opencode-go"],"reasons":{"opencode-go":"upstream CreditsError/RegionError: no payment method / China-host opt-in"}}' >/opt/crsproxy/isolated/manifest.json
  chmod 0644 /opt/crsproxy/isolated/manifest.json
fi

install -m 0644 "$TEMPLATE_DIR/cliproxy-heal.service" "$UNIT_DIR/cliproxy-heal.service"
install -m 0644 "$TEMPLATE_DIR/cliproxy-heal.timer" "$UNIT_DIR/cliproxy-heal.timer"

# Keep auto_reauth.py as the OAuth writer; prepend a heal tick so leftover
# quota is rotated before the 15-minute reauth scan.
HOOK="$DEST/run-before-reauth.sh"
cat > "$HOOK" <<'HOOK'
#!/bin/sh
export CLIPROXY_HUB_HEAL=1
export CLIPROXY_AUTH_DIR="${CLIPROXY_AUTH_DIR:-/opt/crsproxy/auths}"
exec /usr/local/bin/node /opt/crsproxy/heal/cliproxy-heal-tick.mjs
HOOK
chmod 0755 "$HOOK"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now cliproxy-heal.timer
  # Drop-in so crsproxy-reauth also runs the healer first (no HITL).
  mkdir -p "$UNIT_DIR/crsproxy-reauth.service.d"
  cat > "$UNIT_DIR/crsproxy-reauth.service.d/20-heal-first.conf" <<'DROPIN'
[Service]
Environment=CLIPROXY_HUB_HEAL=1
ExecStartPre=/opt/crsproxy/heal/run-before-reauth.sh
DROPIN
  systemctl daemon-reload
fi

echo "installed $DEST and cliproxy-heal.timer"
