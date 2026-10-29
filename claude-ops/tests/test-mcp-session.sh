#!/usr/bin/env bash
set -euo pipefail
python3 -I -m unittest discover -s "$(dirname "$0")" -p test_ops_mcp_session.py -v
