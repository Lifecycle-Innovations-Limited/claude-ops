#!/usr/bin/env bash
# Registry changes use the supported CLI; install.py owns backups and recovery.
# Usage: install.sh [install|update|uninstall|rollback BACKUP]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$HERE/install.py" "$@"
