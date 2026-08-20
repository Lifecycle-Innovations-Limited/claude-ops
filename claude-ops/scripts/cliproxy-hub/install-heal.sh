#!/usr/bin/env bash
# Install the CLIProxy healer onto a hub that already runs crsproxy.
# Copies policy/tick modules to /opt/crsproxy/heal and enables the systemd timer.
# Run on the hub as root. No secrets are written.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../account-rotation" && pwd)"
DEST="${CLIPROXY_HEAL_DEST:-/opt/crsproxy/heal}"
UNIT_DIR="${CLIPROXY_UNIT_DIR:-/etc/systemd/system}"
TEMPLATE_DIR="$(cd "$(dirname "$0")/../../templates" && pwd)"

# DEST is interpolated into a sed replacement (below) and, via the generated
# unit, into systemd directives (ExecStart=, Environment=CLIPROXY_REAUTH_CMD=).
# Rather than try to replicate systemd's own escaping rules for that context
# (% is systemd's specifier-expansion escape and must be doubled; backslash
# and quotes carry meaning inside unit file quoting) constrain DEST to a
# strict allow-list of characters that are inert in both a sed replacement
# and a systemd directive: it must be an absolute path built only from
# alphanumerics, underscore, dot, slash, and dash. Anything else — spaces,
# %, \, ", ', &, #, $, ; — is rejected outright.
if [[ ! "$DEST" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "install-heal.sh: CLIPROXY_HEAL_DEST must be an absolute path using only [A-Za-z0-9_./-] (got: $DEST)" >&2
  exit 1
fi

# cliproxy-heal-ai.mjs uses AbortSignal.timeout(), added in Node 17.3 / 18.0.
# A pre-18 node on the hub would silently throw on the first advisor call
# instead of failing this install step, so enforce the floor here. Resolve
# the exact executable path (not just "node" by name) and reuse that same
# path in the generated unit's ExecStart, so validation and execution can
# never resolve two different Node.js binaries (e.g. a PATH that differs
# between an interactive install shell and systemd's ExecStart environment).
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    echo "install-heal.sh: node >=18 required (found $("$NODE_BIN" -v)); AbortSignal.timeout is used by cliproxy-heal-ai.mjs" >&2
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

# Second unattended-healing gate: a filesystem marker, not another env var.
# automatedAuthAllowed() (auto-auth-policy.mjs) requires both
# CLIPROXY_HUB_HEAL=1 (a process env var, settable by editing the unit's
# Environment= lines or exporting it in a shell) AND this marker file's
# CONTENT matching CLIPROXY_HEAL_OPTIN_TOKEN (settable only by running this
# install script against /opt/crsproxy). Content, not mere existence, is
# required so that pointing at some other pre-existing file cannot forge the
# gate. The token literal below must stay in sync with
# CLIPROXY_HEAL_OPTIN_TOKEN in account-rotation/auto-auth-policy.mjs.
# Running this script is the deliberate "provision this host for unattended
# healing" step; writing the marker here — not via Environment= in the unit
# template — keeps that decision on a different control plane than the
# env var, so editing the unit alone cannot satisfy both gates.
printf '%s\n' "cliproxy-heal-optin-v1" >/opt/crsproxy/.heal-account-optin
chmod 0600 /opt/crsproxy/.heal-account-optin

# Escape DEST and NODE_BIN for use as sed replacement text: sed treats `&` as
# "the whole match" and `\` as an escape in the replacement, and `#` is the
# delimiter this script uses for the s### command, so any of those three
# characters in an unescaped path would corrupt the generated unit (or the
# sed command itself) instead of producing the requested path.
sed_escape_repl() { printf '%s' "$1" | sed -e 's/[\&#]/\\&/g'; }
DEST_ESCAPED="$(sed_escape_repl "$DEST")"
NODE_BIN_ESCAPED="$(sed_escape_repl "$NODE_BIN")"

# The template hardcodes /opt/crsproxy/heal (ExecStart, CLIPROXY_REAUTH_CMD)
# and /usr/local/bin/node (ExecStart). When CLIPROXY_HEAL_DEST overrides the
# install dir, or the validated node binary lives elsewhere, the generated
# unit must point at those same paths, not silently keep referencing the
# template's defaults.
sed -e "s#/opt/crsproxy/heal#${DEST_ESCAPED}#g" -e "s#/usr/local/bin/node#${NODE_BIN_ESCAPED}#g" \
  "$TEMPLATE_DIR/cliproxy-heal.service" >"$UNIT_DIR/cliproxy-heal.service"
chmod 0644 "$UNIT_DIR/cliproxy-heal.service"
install -m 0644 "$TEMPLATE_DIR/cliproxy-heal.timer" "$UNIT_DIR/cliproxy-heal.timer"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now cliproxy-heal.timer
fi

echo "installed $DEST and cliproxy-heal.timer"
