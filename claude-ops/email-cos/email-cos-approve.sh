#!/usr/bin/env bash
# email-cos-approve.sh — wrapper that sources config (so ${HOME}/vars expand in a
# real shell, unlike systemd EnvironmentFile) then invokes the approval reader.
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"
exec /usr/bin/python3 "$_SCRIPT_DIR/email-cos-approve-agent.py"
