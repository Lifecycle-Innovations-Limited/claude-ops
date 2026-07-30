#!/usr/bin/env bash
# desktop-act MCP launcher — auto-bootstraps a venv on first run, then execs server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${DESKTOP_ACT_VENV:-$ROOT/.venv}"
PY="${DESKTOP_ACT_PYTHON:-python3}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[desktop-act] bootstrapping venv at $VENV" >&2
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$ROOT/requirements.txt"
fi

exec "$VENV/bin/python" "$ROOT/mcp-server/server.py" "$@"
