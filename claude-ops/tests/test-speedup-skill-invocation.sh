#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 -I -B "$TESTS_DIR/test-speedup-skill-invocation.py"
