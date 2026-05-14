#!/usr/bin/env bash
# ops-daemon-manager.sh — Cross-OS daemon install / upgrade / status / uninstall
#
# Subcommands:
#   install      Generate plist (or systemd unit), register with OS, start
#   upgrade      Re-point plist at current PLUGIN_ROOT and reload (idempotent)
#   uninstall    Stop, unregister, remove plist
#   status       Emit JSON: {installed, running, pid, script_path, plugin_root, plist_version_matches}
#   restart      Stop + start without reconfiguring
#
# Exit codes:
#   0   success
#   1   generic failure
#   64  EX_USAGE (bad arguments)
#   69  EX_UNAVAILABLE (OS not supported for install)
#   78  EX_CONFIG (missing plist template, bad PLUGIN_ROOT)
#
# Portable: no hardcoded user paths. Reads PLUGIN_ROOT from env, argv, or auto-detect.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: ops-daemon-manager.sh <install|upgrade|ensure-current|uninstall|status|restart> [options]

Subcommands:
  install         First-time install (writes plist + loads launchd)
  upgrade         Re-point plist at PLUGIN_ROOT + reload (always reloads)
  ensure-current  No-op if plist already points at PLUGIN_ROOT, else upgrade
                  (cheap + idempotent — safe to run on every SessionStart)
  restart         Unload + reload without reconfiguring
  uninstall       Stop + remove plist
  status          Emit JSON snapshot

Options:
  --plugin-root PATH    Override auto-detected plugin root
  --dry-run             Print what would happen, do not execute

Environment:
  CLAUDE_PLUGIN_ROOT    Plugin install directory (preferred over auto-detect)
  OPS_DATA_DIR          Data directory (default: \$HOME/.claude/plugins/data/ops-ops-marketplace)

Examples:
  ops-daemon-manager.sh install
  ops-daemon-manager.sh status
  ops-daemon-manager.sh ensure-current
EOF
}

# ── Arg parsing ──────────────────────────────────────────────────────────
# Handle bare --help / -h before any required-value flag handling so users
# can run `ops-daemon-manager.sh --help` without supplying a subcommand.
if (( $# >= 1 )); then
  case "$1" in
    -h|--help) usage; exit 0 ;;
  esac
fi

if (( $# < 1 )); then
  usage
  exit 64
fi

CMD="$1"; shift
DRY_RUN=0
CLI_PLUGIN_ROOT=""
while (( $# > 0 )); do
  case "$1" in
    --plugin-root)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --plugin-root requires a value" >&2
        exit 64
      fi
      CLI_PLUGIN_ROOT="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 64 ;;
  esac
done

# ── OS detection ─────────────────────────────────────────────────────────
detect_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$uname_s" in
    Darwin) echo macos ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}
OS="$(detect_os)"

# ── Plugin root resolution ───────────────────────────────────────────────
resolve_plugin_root() {
  if [[ -n "$CLI_PLUGIN_ROOT" ]]; then
    echo "$CLI_PLUGIN_ROOT"
    return
  fi
  if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]] && [[ -d "${CLAUDE_PLUGIN_ROOT}/scripts" ]]; then
    echo "$CLAUDE_PLUGIN_ROOT"
    return
  fi
  # Auto-detect: newest installed version under ~/.claude/plugins/cache/ops-marketplace/ops/
  local newest
  newest=$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null \
           | sed 's:/$::' \
           | awk -F/ '{ver=$NF; print ver"\t"$0}' \
           | sort -V -k1,1 \
           | tail -1 \
           | cut -f2-)
  if [[ -z "$newest" ]]; then
    echo "" ; return
  fi
  echo "$newest"
}

PLUGIN_ROOT="$(resolve_plugin_root)"
DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
PLIST_LABEL="com.claude-ops.daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
HEALTH_FILE="$DATA_DIR/daemon-health.json"
SERVICES_FILE="$DATA_DIR/daemon-services.json"

log() { printf '[daemon-manager] %s\n' "$*" >&2; }
run() {
  if (( DRY_RUN )); then
    echo "DRY: $*" >&2
  else
    "$@"
  fi
}

# ── Resolve bash binary (must be v4+) ────────────────────────────────────
resolve_bash_path() {
  # Check known homebrew locations first (most common on macOS with new bash)
  local candidates=(
    /opt/homebrew/bin/bash
    /usr/local/bin/bash
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      local v
      v=$("$c" -c 'echo $BASH_VERSINFO' 2>/dev/null || echo 0)
      if [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 4 )); then
        echo "$c"; return
      fi
    fi
  done
  # Fall back to `bash` on PATH if it is >=4
  if command -v bash >/dev/null 2>&1; then
    local v
    v=$(bash -c 'echo $BASH_VERSINFO' 2>/dev/null || echo 0)
    if [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 4 )); then
      command -v bash; return
    fi
  fi
  echo ""  # not found
}

# ── macOS launchctl helpers ──────────────────────────────────────────────
mac_generate_plist() {
  local template="$PLUGIN_ROOT/scripts/com.claude-ops.daemon.plist"
  local bash_path
  bash_path="$(resolve_bash_path)"
  if [[ -z "$bash_path" ]]; then
    log "ERROR: bash 4+ not found. Install with: brew install bash"
    exit 78
  fi
  if [[ ! -f "$template" ]]; then
    log "ERROR: plist template not found at $template"
    exit 78
  fi
  mkdir -p "$(dirname "$PLIST_DEST")" "$LOG_DIR"
  local tmp="$PLIST_DEST.tmp"
  sed \
    -e "s|__BASH_PATH__|$bash_path|g" \
    -e "s|__DAEMON_SCRIPT_PATH__|$PLUGIN_ROOT/scripts/ops-daemon.sh|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PLUGIN_ROOT__|$PLUGIN_ROOT|g" \
    "$template" > "$tmp"
  # Validate before installing
  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$tmp" >/dev/null 2>&1; then
      log "ERROR: generated plist is invalid"
      rm -f "$tmp"
      exit 1
    fi
  fi
  run mv "$tmp" "$PLIST_DEST"
  log "wrote $PLIST_DEST"
}

mac_is_loaded() {
  launchctl list 2>/dev/null | grep -q "[[:space:]]${PLIST_LABEL}$"
}

mac_current_pid() {
  launchctl list 2>/dev/null | awk -v l="$PLIST_LABEL" '$3==l { print $1 }'
}

mac_unload() {
  if mac_is_loaded; then
    run launchctl bootout "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || \
      run launchctl unload "$PLIST_DEST" 2>/dev/null || true
  fi
}

mac_load() {
  run launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || \
    run launchctl load "$PLIST_DEST"
}

mac_plist_script_path() {
  # Extract the second <string> inside ProgramArguments.
  # Portable across GNU and BSD awk — no 3-arg match().
  if [[ ! -f "$PLIST_DEST" ]]; then return; fi
  awk '
    /<key>ProgramArguments<\/key>/ { in_pa=1; next }
    in_pa && /<string>/ {
      if (!bash_seen) { bash_seen=1; next }
      line=$0
      sub(/^[[:space:]]*<string>/, "", line)
      sub(/<\/string>[[:space:]]*$/, "", line)
      print line
      exit
    }
  ' "$PLIST_DEST" 2>/dev/null
}

# ── Commands ─────────────────────────────────────────────────────────────
cmd_install() {
  if [[ -z "$PLUGIN_ROOT" ]] || [[ ! -d "$PLUGIN_ROOT/scripts" ]]; then
    log "ERROR: plugin root not found. Set CLAUDE_PLUGIN_ROOT or install the plugin."
    exit 78
  fi
  log "plugin root: $PLUGIN_ROOT"
  log "os: $OS"
  case "$OS" in
    macos)
      if [[ -f "$PLIST_DEST" ]]; then
        log "plist already exists — running upgrade instead"
        cmd_upgrade
        return
      fi
      mac_generate_plist
      mac_load
      log "installed — verify with: launchctl list | grep $PLIST_LABEL"
      ;;
    linux|wsl)
      log "Linux/WSL systemd install is not yet supported by this helper."
      log "Run manually: nohup $PLUGIN_ROOT/scripts/ops-daemon.sh >> $LOG_DIR/ops-daemon.log 2>&1 &"
      exit 69
      ;;
    windows)
      log "Windows native is not supported. Use WSL."
      exit 69
      ;;
    *)
      log "unknown OS: $OS"
      exit 69
      ;;
  esac
}

cmd_upgrade() {
  if [[ -z "$PLUGIN_ROOT" ]] || [[ ! -d "$PLUGIN_ROOT/scripts" ]]; then
    log "ERROR: plugin root not found"
    exit 78
  fi
  case "$OS" in
    macos)
      mac_unload
      sleep 1
      mac_generate_plist
      mac_load
      log "upgraded to point at $PLUGIN_ROOT"
      ;;
    *)
      log "upgrade only supported on macOS"
      exit 69
      ;;
  esac
}

cmd_ensure_current() {
  # Always run post-update migrations FIRST (idempotent — sentinel-gated per-version).
  # This catches version bumps even when the daemon plist itself didn't change.
  local migrate_bin="$PLUGIN_ROOT/bin/ops-post-update-migrate"
  if [[ -x "$migrate_bin" ]]; then
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$migrate_bin" 2>/dev/null || true
  fi

  [[ "$OS" == "macos" ]] || exit 0
  [[ -n "$PLUGIN_ROOT" ]] && [[ -d "$PLUGIN_ROOT/scripts" ]] || exit 0
  [[ -f "$PLIST_DEST" ]] || exit 0
  local current_script="$PLUGIN_ROOT/scripts/ops-daemon.sh"
  local plist_script
  plist_script="$(mac_plist_script_path)"
  if [[ "$plist_script" == "$current_script" ]]; then
    exit 0
  fi
  log "plist points at stale version ($plist_script); upgrading to $PLUGIN_ROOT"
  cmd_upgrade
}

cmd_uninstall() {
  case "$OS" in
    macos)
      mac_unload
      run rm -f "$PLIST_DEST"
      log "removed $PLIST_DEST"
      ;;
    *) exit 69 ;;
  esac
}

cmd_restart() {
  case "$OS" in
    macos)
      mac_unload
      sleep 1
      mac_load
      log "restarted"
      ;;
    *) exit 69 ;;
  esac
}

cmd_status() {
  local installed=false
  local running=false
  local pid="null"
  local script_path=""
  local plist_version_match=false
  local health_fresh=false
  local health_mtime=""
  local current_script_path="$PLUGIN_ROOT/scripts/ops-daemon.sh"

  if [[ -f "$PLIST_DEST" ]]; then
    installed=true
    script_path="$(mac_plist_script_path)"
    if [[ "$script_path" == "$current_script_path" ]]; then
      plist_version_match=true
    fi
  fi

  case "$OS" in
    macos)
      if mac_is_loaded; then
        local p
        p="$(mac_current_pid)"
        if [[ -n "$p" ]] && [[ "$p" != "-" ]]; then
          pid="$p"
          if kill -0 "$p" 2>/dev/null; then
            running=true
          fi
        fi
      fi
      ;;
  esac

  if [[ -f "$HEALTH_FILE" ]]; then
    local now mtime age
    now=$(date +%s)
    # Portable mtime: GNU vs BSD stat
    if stat --version >/dev/null 2>&1; then
      mtime=$(stat -c %Y "$HEALTH_FILE" 2>/dev/null || echo 0)
    else
      mtime=$(stat -f %m "$HEALTH_FILE" 2>/dev/null || echo 0)
    fi
    age=$(( now - mtime ))
    health_mtime="$(date -u -r "$mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                    date -u -d "@$mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
    if (( age < 120 )); then
      health_fresh=true
    fi
  fi

  cat <<EOF
{
  "os": "$OS",
  "plugin_root": "${PLUGIN_ROOT:-null}",
  "installed": $installed,
  "running": $running,
  "pid": $( [[ "$pid" == "null" ]] && echo null || echo "$pid" ),
  "plist_path": "$PLIST_DEST",
  "plist_script_path": "$script_path",
  "expected_script_path": "$current_script_path",
  "plist_version_match": $plist_version_match,
  "health_file": "$HEALTH_FILE",
  "health_fresh": $health_fresh,
  "health_mtime": "$health_mtime",
  "services_file": "$SERVICES_FILE"
}
EOF
}

# ── Dispatch ─────────────────────────────────────────────────────────────
case "$CMD" in
  install)        cmd_install ;;
  upgrade)        cmd_upgrade ;;
  ensure-current) cmd_ensure_current ;;
  uninstall)      cmd_uninstall ;;
  restart)        cmd_restart ;;
  status)         cmd_status ;;
  *)              usage; exit 64 ;;
esac
