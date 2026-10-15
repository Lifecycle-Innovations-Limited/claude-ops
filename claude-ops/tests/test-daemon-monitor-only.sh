#!/usr/bin/env bash
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$TESTS_DIR/test-daemon-monitor-only.py"
exec python3 "$TESTS_DIR/test-daemon-monitor-contract.py"
