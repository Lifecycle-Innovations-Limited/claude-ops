#!/usr/bin/env bash
set -euo pipefail

# test-ops-marketing-auth-prewarm.sh
# Requires: doppler CLI, jq

command -v doppler &>/dev/null || { echo "SKIP: doppler not installed"; exit 0; }
command -v jq &>/dev/null || { echo "SKIP: jq not installed"; exit 0; }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[test] running prewarm with OPS_DATA_DIR=$TMP_DIR"
OPS_DATA_DIR="$TMP_DIR" bash "$SCRIPT_DIR/scripts/ops-marketing-auth-prewarm.sh"

OUTPUT="$TMP_DIR/marketing-auth-prewarm.json"

if [[ ! -f "$OUTPUT" ]]; then
  echo "FAIL: output file not created at $OUTPUT"
  exit 1
fi

# validate JSON
if ! jq empty "$OUTPUT" 2>/dev/null; then
  echo "FAIL: output is not valid JSON"
  exit 1
fi

# check required top-level keys
for key in by_project by_category generated_at doppler_projects_scanned; do
  if ! jq -e "has(\"$key\")" "$OUTPUT" &>/dev/null; then
    echo "FAIL: missing top-level key: $key"
    exit 1
  fi
done

# verify at least one category was populated for at least one project
category_count=$(jq '.by_category | length' "$OUTPUT")
if [[ "$category_count" -lt 1 ]]; then
  echo "FAIL: by_category is empty — no marketing creds found in any source"
  exit 1
fi

echo "PASS: output valid, $category_count categories found"
exit 0
