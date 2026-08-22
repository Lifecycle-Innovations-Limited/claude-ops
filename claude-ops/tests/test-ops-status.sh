#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_BIN="$PLUGIN_ROOT/bin/ops-status"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

/bin/bash -n "$STATUS_BIN"

PATH="/usr/bin:/bin" /bin/bash "$STATUS_BIN" --json \
  >"$TMP_DIR/status.json" 2>"$TMP_DIR/status.err"

if [ -s "$TMP_DIR/status.err" ]; then
  echo "FAIL: ops-status emitted stderr under /bin/bash" >&2
  sed -n '1,10p' "$TMP_DIR/status.err" >&2
  exit 1
fi

jq -e '.generated_at and (.clis | type == "object") and (.channels | type == "object")' \
  "$TMP_DIR/status.json" >/dev/null

echo "PASS: ops-status bootstraps from macOS Bash 3.2 and emits valid JSON"

