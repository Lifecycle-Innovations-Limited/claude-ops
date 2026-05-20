#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs/marketing-auth-prewarm.log"
mkdir -p "$(dirname "$LOG_FILE")"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting marketing-auth-prewarm" >> "$LOG_FILE"
"$SCRIPT_DIR/ops-marketing-auth-prewarm.sh" 2>> "$LOG_FILE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] finished marketing-auth-prewarm (exit $?)" >> "$LOG_FILE"
