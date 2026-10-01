#!/usr/bin/env bash
# Mocked or isolated tests only; does not register or execute live jobs.
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$TESTS_DIR/test_ops_mac_log_rotate.py"
python3 "$TESTS_DIR/test_ops_mac_recall_seed.py"
python3 "$TESTS_DIR/test_ops_mac_hypertune.py"
python3 "$TESTS_DIR/test_ops_mac_reaper.py"
python3 "$TESTS_DIR/test_ops_mac_installer.py"
