#!/usr/bin/env bash
# email-cos/install.sh — idempotent installer for the email chief-of-staff system.
#
# What it does:
#   1. Creates required directories.
#   2. Copies scripts to ~/.local/share/email-cos/ (overwrite if changed).
#   3. Installs systemd user units from ./systemd/.
#   4. Prompts to create ~/.config/email-cos/config.sh if it does not exist.
#   5. Enables timers ONLY for channels that are configured + enabled.
#   6. Runs systemctl --user daemon-reload.
#
# Safe to re-run. Does not enable unconfigured channels.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/email-cos"
CONFIG_DIR="$HOME/.config/email-cos"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG_FILE="$CONFIG_DIR/config.sh"

echo "=== email-cos installer ==="

# ── 1. Create directories ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$UNIT_DIR"
mkdir -p "$HOME/.local/state/email-cos/pending.d"

# ── 2. Copy scripts ───────────────────────────────────────────────────────────
echo "Copying scripts to $INSTALL_DIR ..."
for f in \
  email-cos-sweep.sh \
  email-cos-orch.sh \
  email-cos-sender.sh \
  email-cos-sender.py \
  email-cos-approve-agent.py \
  email-cos-approve.sh \
  email-cos-notify.sh \
  email-cos-slack.sh \
  email-cos-status.sh \
  email-cos-compact.sh \
  icloud-reminder.sh \
  pocket-telegram-read; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
  chmod +x "$INSTALL_DIR/$f"
done

# Copy the lib and prompts directories.
cp -r "$SCRIPT_DIR/lib" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/prompts" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/package.json"

# Copy example categories if no user categories exist yet.
if [ ! -f "$CONFIG_DIR/categories.json" ]; then
  cp "$SCRIPT_DIR/categories.example.json" "$CONFIG_DIR/categories.json"
  echo "Created $CONFIG_DIR/categories.json from example — edit to match your email categories."
fi

# ── 3. Install systemd units ──────────────────────────────────────────────────
echo "Installing systemd units to $UNIT_DIR ..."
for unit in "$SCRIPT_DIR/systemd/"*; do
  cp "$unit" "$UNIT_DIR/"
done
# Reload BEFORE enabling so upgrade-in-place picks up changed unit definitions.
systemctl --user daemon-reload

# ── 4. Config file ────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  echo "No config found at $CONFIG_FILE."
  echo "Copying example config ..."
  cp "$SCRIPT_DIR/email-cos.config.example.sh" "$CONFIG_FILE"
  echo ""
  echo "NEXT STEP: Edit $CONFIG_FILE and fill in your values."
  echo "  Required: EMAIL_COS_ACCOUNT"
  echo "  Optional: enable channels by setting ENABLE=true + their identifiers."
  echo ""
  echo "Then re-run install.sh to activate the configured timers."
  systemctl --user daemon-reload
  echo "daemon-reload done. Re-run after editing config."
  exit 0
fi

# Source the config so we can check which channels are enabled.
set -a; . "$CONFIG_FILE"; set +a

# ── 5. Enable timers for configured channels ──────────────────────────────────
echo ""
echo "Enabling timers ..."

# Core timers — always enabled when EMAIL_COS_ACCOUNT is set.
if [ -z "${EMAIL_COS_ACCOUNT:-}" ]; then
  echo "WARNING: EMAIL_COS_ACCOUNT is not set in $CONFIG_FILE."
  echo "         Core timers will NOT be enabled until it is configured."
else
  for timer in email-cos-sweep email-cos-orch email-cos-sender email-cos-compact; do
    systemctl --user enable --now "${timer}.timer" && echo "  enabled: ${timer}.timer" || true
  done

  # Status heartbeat — enable if any notification channel is on.
  if [ "${EMAIL_COS_TG_ENABLE:-false}" = "true" ] \
      || [ "${EMAIL_COS_SLACK_ENABLE:-false}" = "true" ]; then
    systemctl --user enable --now email-cos-status.timer && echo "  enabled: email-cos-status.timer" || true
  fi

  # Approve-agent — Gmail reply channel is available whenever account is set.
  systemctl --user enable --now email-cos-approve.timer && echo "  enabled: email-cos-approve.timer" || true
fi

# ── 6. Reload ─────────────────────────────────────────────────────────────────
systemctl --user daemon-reload
echo ""
echo "=== install complete ==="
echo "Run: systemctl --user list-timers 'email-cos*' to verify."
echo "Run: $INSTALL_DIR/email-cos-status.sh to see health."
