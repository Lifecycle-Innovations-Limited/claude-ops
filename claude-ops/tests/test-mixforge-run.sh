#!/usr/bin/env bash
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$TESTS_DIR/test-mixforge-run.py"
