#!/usr/bin/env bash
# Install the CLIProxy healer onto a hub that already runs crsproxy.
# Copies policy/tick modules to /opt/crsproxy/heal and enables the systemd timer.
# Run on the hub as root. No secrets are written.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../account-rotation" && pwd)"
DEST="${CLIPROXY_HEAL_DEST:-/opt/crsproxy/heal}"
UNIT_DIR="${CLIPROXY_UNIT_DIR:-/etc/systemd/system}"
TEMPLATE_DIR="$(cd "$(dirname "$0")/../../templates" && pwd)"

# cliproxy-heal-ai.mjs uses AbortSignal.timeout(), added in Node 17.3 / 18.0.
# A pre-18 node on the hub would silently throw on the first advisor call
# instead of failing this install step, so enforce the floor here.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    echo "install-heal.sh: node >=18 required (found $(node -v)); AbortSignal.timeout is used by cliproxy-heal-ai.mjs" >&2
    exit 1
  fi
else
  echo "install-heal.sh: node not found on PATH" >&2
  exit 1
fi

mkdir -p "$DEST"
install -m 0755 "$SRC/cliproxy-heal-tick.mjs" "$DEST/cliproxy-heal-tick.mjs"
install -m 0644 "$SRC/cliproxy-heal-policy.mjs" "$DEST/cliproxy-heal-policy.mjs"
install -m 0644 "$SRC/cliproxy-heal-ai.mjs" "$DEST/cliproxy-heal-ai.mjs"
install -m 0644 "$SRC/cliproxy-pool-snapshot.mjs" "$DEST/cliproxy-pool-snapshot.mjs"
install -m 0644 "$SRC/auto-auth-policy.mjs" "$DEST/auto-auth-policy.mjs"
install -m 0644 "$SRC/cliproxy-isolate-compat.mjs" "$DEST/cliproxy-isolate-compat.mjs"
HUB_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$HUB_SCRIPTS/cliproxy-reauth-one.sh" "$DEST/cliproxy-reauth-one.sh"
mkdir -p /opt/crsproxy/isolated
if [ ! -f /opt/crsproxy/isolated/manifest.json ]; then
  printf '%s\n' '{"providers":["opencode-go"],"reasons":{"opencode-go":"upstream CreditsError/RegionError: no payment method / China-host opt-in"}}' >/opt/crsproxy/isolated/manifest.json
  chmod 0644 /opt/crsproxy/isolated/manifest.json
fi

# The template hardcodes /opt/crsproxy/heal (ExecStart, CLIPROXY_REAUTH_CMD).
# When CLIPROXY_HEAL_DEST overrides the install dir, the generated unit must
# point at that same dir, not silently keep referencing the default path.
sed -e "s#/opt/crsproxy/heal#${DEST}#g" "$TEMPLATE_DIR/cliproxy-heal.service" >"$UNIT_DIR/cliproxy-heal.service"
chmod 0644 "$UNIT_DIR/cliproxy-heal.service"
install -m 0644 "$TEMPLATE_DIR/cliproxy-heal.timer" "$UNIT_DIR/cliproxy-heal.timer"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now cliproxy-heal.timer
fi

echo "installed $DEST and cliproxy-heal.timer"
