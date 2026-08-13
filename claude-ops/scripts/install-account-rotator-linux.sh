#!/usr/bin/env bash
# install-account-rotator-linux.sh
#
# Purpose : Install the Claude account-rotation daemon as a systemd --user service.
# Platform: Linux (Amazon Linux 2023 / Debian / Ubuntu — anything with systemd ≥ 232)
# Schedule: Always-on (KeepAlive equivalent). The daemon polls every 15 s internally.
# Rollback: systemctl --user disable --now claude-account-rotator.service
#           rm ~/.config/systemd/user/claude-account-rotator.service
#           systemctl --user daemon-reload
#
# Usage: CLAUDE_AUTH_COORDINATION_PLAN=/absolute/reviewed-plan.json \
#        CLAUDE_AUTH_COORDINATION_PLAN_DIGEST=<reviewed-digest> bash install-account-rotator-linux.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="claude-account-rotator"
UNIT_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
DAEMON_SCRIPT="$SCRIPT_DIR/account-rotation/daemon.mjs"
LOG_FILE="$SCRIPT_DIR/account-rotation/rotation.log"
DRY_RUN=0

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log() { echo "[install-account-rotator] $*"; }
die() { echo "[install-account-rotator] ERROR: $*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1  || die "node not found (need Node 20+)"
command -v npx  >/dev/null 2>&1  || die "npx not found"
command -v jq   >/dev/null 2>&1  || die "jq not found"
node --version | grep -qE 'v(2[0-9]|[3-9][0-9])' || die "Node 20+ required (got $(node --version))"
[[ -f "$DAEMON_SCRIPT" ]] || die "daemon.mjs not found at $DAEMON_SCRIPT"
: "${CLAUDE_AUTH_COORDINATION_PLAN:?set the absolute reviewed coordination plan path}"
: "${CLAUDE_AUTH_COORDINATION_PLAN_DIGEST:?set the exact reviewed coordination plan digest}"
PREFLIGHT_JSON=$(node "$SCRIPT_DIR/account-rotation/provision-coordination.mjs" preflight \
  --plan "$CLAUDE_AUTH_COORDINATION_PLAN" --expected-digest "$CLAUDE_AUTH_COORDINATION_PLAN_DIGEST") \
  || die "auth coordination preflight failed"
CLAUDE_AUTH_COORDINATION_CONFIG=$(printf '%s' "$PREFLIGHT_JSON" | jq -er '.configPath') || die "invalid preflight config path"
CLAUDE_ROTATOR_CONFIG=$(printf '%s' "$PREFLIGHT_JSON" | jq -er '.runtimeInventoryPath') || die "invalid preflight inventory path"
REVIEWED_UNIT=$(printf '%s' "$PREFLIGHT_JSON" | jq -er '.linuxUnitPath') || die "invalid preflight unit path"
REVIEWED_UNIT_CANONICAL=$(realpath "$REVIEWED_UNIT") || die "cannot resolve reviewed unit destination"
UNIT_FILE_CANONICAL=$(realpath "$UNIT_FILE") || die "cannot resolve installer unit destination"
[[ "$REVIEWED_UNIT_CANONICAL" == "$UNIT_FILE_CANONICAL" ]] || die "reviewed unit destination does not match installer destination"

# ── Dry-run validation ────────────────────────────────────────────────────────

log "Dry-run: testing daemon starts cleanly..."
TIMEOUT_EXIT=0
timeout 5 node "$DAEMON_SCRIPT" --status >/dev/null 2>&1 || TIMEOUT_EXIT=$?
# exit 1 = no pid file (expected on first run), anything else = real error
if [[ $TIMEOUT_EXIT -gt 1 && $TIMEOUT_EXIT -ne 124 ]]; then
  die "daemon.mjs --status exited $TIMEOUT_EXIT — fix errors before installing"
fi
log "Dry-run passed (exit $TIMEOUT_EXIT — ok)"

[[ $DRY_RUN -eq 1 ]] && { log "--dry-run: skipping install"; exit 0; }

# ── Write unit file ───────────────────────────────────────────────────────────

log "Reviewed unit already provisioned: $UNIT_FILE"

# ── Plan-bound activation and health check ───────────────────────────────────

node "$SCRIPT_DIR/account-rotation/provision-coordination.mjs" activate-linux \
  --plan "$CLAUDE_AUTH_COORDINATION_PLAN" --expected-digest "$CLAUDE_AUTH_COORDINATION_PLAN_DIGEST" >/dev/null \
  || die "plan-bound systemd activation failed"
log "READY — ${SERVICE_NAME}.service is active"
