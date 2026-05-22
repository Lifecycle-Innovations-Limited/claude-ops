#!/usr/bin/env bash
#
# Linux equivalent of scripts/install-ops-daemon.sh (which is launchd/macOS-only).
#
# Installs the claude-ops background daemon as a `systemd --user` service so it
# survives logout and reboot. Idempotent: re-running re-bootstraps cleanly.
#
# Requires:
#   - systemd (any modern Linux distro: Amazon Linux 2023, Ubuntu, Fedora, etc.)
#   - bash >= 4 (for the daemon script itself)
#   - sudo access (only used for `loginctl enable-linger`, nothing else)
#
# Idempotency:
#   - If the unit file is already installed, contents are diffed and re-written only on change.
#   - `daemon-reload` is always safe.
#   - `enable --now` is a no-op if the service is already running.
#
# Cache-permission guard:
#   The daemon needs to mkdir into ~/.claude/plugins/cache/ — if that dir is
#   owned by root (from a prior sudo run), the daemon crash-loops with EACCES.
#   We chown it back to the invoking user before starting.
#
# Usage:
#   bash install-ops-daemon-linux.sh
#   bash install-ops-daemon-linux.sh --dry-run    # show what would change
#   bash install-ops-daemon-linux.sh --uninstall  # stop + disable + remove unit
#
set -euo pipefail

UNIT_NAME="claude-ops-daemon.service"
USER_UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DST="$USER_UNIT_DIR/$UNIT_NAME"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/systemd/claude-ops-daemon.service"

DRY_RUN=false
UNINSTALL=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --uninstall) UNINSTALL=true ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 64 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run()  { if $DRY_RUN; then printf '  DRY: %s\n' "$*"; else eval "$@"; fi; }

# --- Platform gate ----------------------------------------------------------
case "$(uname -s)" in
  Linux) : ;;
  *)     die "this installer is Linux-only. macOS users: run scripts/install-ops-daemon.sh" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this installer requires systemd"

# --- Uninstall path ---------------------------------------------------------
if $UNINSTALL; then
  log "Uninstalling claude-ops daemon"
  run "systemctl --user disable --now $UNIT_NAME 2>/dev/null || true"
  run "rm -f '$UNIT_DST'"
  run "systemctl --user daemon-reload"
  log "✓ Uninstalled. (linger was NOT disabled — run 'sudo loginctl disable-linger \$USER' if no other user services need it.)"
  exit 0
fi

# --- Sanity checks ----------------------------------------------------------
[ -f "$UNIT_SRC" ] || die "unit template missing: $UNIT_SRC"
DAEMON_SCRIPT="$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops/scripts/ops-daemon.sh"
[ -f "$DAEMON_SCRIPT" ] || die "daemon script missing: $DAEMON_SCRIPT"

BASH_VER="${BASH_VERSINFO[0]}"
[ "$BASH_VER" -ge 4 ] || die "ops-daemon.sh requires bash >= 4 (have $BASH_VER)"

# --- Cache-perms guard (the #1 install-time footgun) ------------------------
CACHE_DIR="$HOME/.claude/plugins/cache"
if [ -d "$CACHE_DIR" ]; then
  OWNER=$(stat -c '%U' "$CACHE_DIR" 2>/dev/null || echo unknown)
  if [ "$OWNER" != "$USER" ]; then
    log "⚠ $CACHE_DIR is owned by $OWNER (not $USER). The daemon will crash-loop on EACCES."
    log "  Fixing: sudo chown -R $USER:$USER '$CACHE_DIR'"
    run "sudo chown -R '$USER':'$USER' '$CACHE_DIR'"
  fi
fi

# --- Unit file install ------------------------------------------------------
run "mkdir -p '$USER_UNIT_DIR'"
if [ -f "$UNIT_DST" ] && diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
  log "✓ Unit file unchanged: $UNIT_DST"
else
  log "Installing unit: $UNIT_DST"
  run "cp '$UNIT_SRC' '$UNIT_DST'"
fi

# --- Linger (so the daemon survives logout) ---------------------------------
LINGER=$(loginctl show-user "$USER" 2>/dev/null | grep -E '^Linger=' | cut -d= -f2 || echo no)
if [ "$LINGER" != "yes" ]; then
  log "Enabling linger so the daemon survives logout"
  run "sudo loginctl enable-linger '$USER'"
fi

# --- Reload + enable --------------------------------------------------------
run "systemctl --user daemon-reload"
run "systemctl --user enable --now $UNIT_NAME"

# --- Verify -----------------------------------------------------------------
if $DRY_RUN; then
  log "✓ Dry-run complete."
  exit 0
fi

sleep 2
if systemctl --user is-active --quiet "$UNIT_NAME"; then
  PID=$(systemctl --user show -p MainPID --value "$UNIT_NAME")
  log "✓ claude-ops daemon active (PID $PID)"
  log "  Logs:    journalctl --user -u $UNIT_NAME -f"
  log "  Status:  systemctl --user status $UNIT_NAME"
  log "  Health:  cat ~/.claude/plugins/data/ops-ops-marketplace/daemon-health.json | jq ."
else
  log "✗ daemon failed to start. Check logs:"
  log "    journalctl --user -u $UNIT_NAME -n 50 --no-pager"
  exit 1
fi
