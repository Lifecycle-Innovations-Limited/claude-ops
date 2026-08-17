#!/usr/bin/env bash
# magic-link-autoloop.sh — single-flight wrapper for magic-link-autoloop.mjs.
# Invoked by launchd/systemd (recommended: every 600s).
#
# Portable: resolves the plugin via $CLAUDE_PLUGIN_ROOT (installer sets this)
# or relative to this script. No host-specific paths.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

# Optional single-flight helper (present on some installs; no-op if missing)
# shellcheck disable=SC1091
source "${HOME:-}/.claude/scripts/lib/once.sh" 2>/dev/null || true
if type claude_once >/dev/null 2>&1; then
  claude_once magic-link-autoloop 60 || exit 0
fi

# Logs live under plugin data dir when available (cross-platform).
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-${HOME:-}/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="${CLAUDE_ROTATION_LOG_DIR:-$DATA_DIR/logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG="${MAGIC_LINK_AUTOLOOP_LOG:-$LOG_DIR/magic-link-autoloop.log}"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "magic-link-autoloop: node is required" >&2
  exit 1
fi

# ── Unattended reauth seat (env-templatable; override in unit/plist) ─────────
export DISPLAY="${DISPLAY:-${CLAUDE_DESKTOP_DISPLAY:-:1}}"
export CLAUDE_DESKTOP_DISPLAY="${CLAUDE_DESKTOP_DISPLAY:-$DISPLAY}"
export DESKTOP_ACT_DISPLAY="${DESKTOP_ACT_DISPLAY:-$CLAUDE_DESKTOP_DISPLAY}"
export CLAUDE_ROT_HEADED="${CLAUDE_ROT_HEADED:-1}"
export CLAUDE_ROT_FORCE_HEADED="${CLAUDE_ROT_FORCE_HEADED:-1}"
export CLAUDE_ROT_VISUAL_CAPTCHA="${CLAUDE_ROT_VISUAL_CAPTCHA:-1}"
export CLAUDE_ROT_DESKTOP_ACT="${CLAUDE_ROT_DESKTOP_ACT:-1}"
export CLAUDE_ROT_VNC_AGENT="${CLAUDE_ROT_VNC_AGENT:-1}"
export CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS="${CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS:-4}"
export CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS="${CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS:-8000}"
export CLAUDE_REAUTH_TIMEOUT_MS="${CLAUDE_REAUTH_TIMEOUT_MS:-1200000}"
# Clear sticky one-shot skip flags from interactive debug sessions
if [[ "${CLAUDE_ROT_SKIP_TOKEN_SOLVERS:-0}" == "1" && "${CLAUDE_ROT_ALLOW_SKIP_TOKEN_SOLVERS:-0}" != "1" ]]; then
  echo "magic-link-autoloop: clearing CLAUDE_ROT_SKIP_TOKEN_SOLVERS=1 (set CLAUDE_ROT_ALLOW_SKIP_TOKEN_SOLVERS=1 to keep)" >&2
  export CLAUDE_ROT_SKIP_TOKEN_SOLVERS=0
fi

if [[ -f "$LOG" ]]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  if [[ "${LOGSIZE:-0}" -gt 2097152 ]]; then
    mv "$LOG" "$LOG.1" 2>/dev/null || true
  fi
fi

"$NODE" "$SCRIPT_DIR/magic-link-autoloop.mjs" "$@" >>"$LOG" 2>&1
