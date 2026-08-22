#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ROOT="$(cd "$ROOT/../.." && pwd)"

cd "$PLUGIN_ROOT"
python3 -m unittest discover -s "$ROOT/tests" -p 'test_*.py' -v
python3 -m py_compile "$ROOT"/local_failover/*.py "$ROOT/vpc_paths.py"
python3 -m json.tool "$ROOT/config.example.json" >/dev/null
PYTHONPATH="$ROOT" python3 -m local_failover check --config "$ROOT/config.example.json" >/dev/null
plutil -lint "$ROOT/launchd/com.example.local-failover.plist.template"
git diff --check
