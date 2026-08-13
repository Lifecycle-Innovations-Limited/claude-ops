#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

python3 test_browser_cleanup.py
python3 test_checkpoint.py
python3 test_lease_cooldown.py
python3 test_candidate_validation.py
