#!/usr/bin/env bash
# Prepend to the backed-up data-dir wrapper; no legacy fallthrough while pinned.
export OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
exec python3 -I "$OPS_DATA_DIR/bin/ops-daemon-monitor-selector.py" "$@"
