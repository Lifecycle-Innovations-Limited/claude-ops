#!/usr/bin/env bash
# Only isolated fixtures; no launchd jobs or live log rotation.
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$TESTS_DIR/test_ops_mac_log_rotate.py"
