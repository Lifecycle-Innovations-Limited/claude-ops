#!/usr/bin/env bash
# ops-cron-marketing-autopilot.sh — thin daemon wrapper that invokes
# bin/ops-marketing-autopilot for the autonomous per-project daily ad
# optimization pass. Mirrors ops-cron-marketing-prewarm.sh.
#
# Opt-in, disabled by default. Enable via /ops:setup marketing (autopilot block)
# which flips the marketing-autopilot daemon service on. The bin itself enforces
# all spend-safety invariants (cap pre-flight, first-run dry, escalation).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR/..}"

AUTOPILOT_BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"
[[ -x "$AUTOPILOT_BIN" ]] || exit 0

# Route headless reasoning through the credit pool when configured.
export CLAUDE_OPS_USE_CREDIT_POOL="${CLAUDE_OPS_USE_CREDIT_POOL:-1}"

exec "$AUTOPILOT_BIN" "$@"
