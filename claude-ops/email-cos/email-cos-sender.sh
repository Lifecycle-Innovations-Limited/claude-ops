#!/usr/bin/env bash
# email-cos-sender.sh — wrapper that sources config then invokes the Python sender.
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"
exec /usr/bin/python3 "$_SCRIPT_DIR/email-cos-sender.py"
