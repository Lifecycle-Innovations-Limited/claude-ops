#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -m py_compile "$ROOT/scripts/macos/pid-performance-monitor.py"
python3 "$ROOT/tests/test-pid-performance-monitor.py"
