#!/usr/bin/env bash
# Regression: registry `source` is a discovery root, not a git/external flag.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/data"
printf '{}\n' > "$TMP/data/preferences.json"
cat > "$TMP/data/registry.json" <<'JSON'
{
  "projects": [
    {"name":"local-app","source":"Developer","path":"/work/local-app"},
    {"name":"cache-copy","source":".grok","path":"/cache/copy"},
    {"alias":"docs","source":"notion","type":"external","notion":{"workspace":"acme"}},
    {"alias":"chat","source":"slack","slack":{"workspace":"acme"}},
    {"name":"named-custom","source":"custom","type":"external","custom":{}}
  ]
}
JSON

OUT=$(CLAUDE_PLUGIN_DATA_DIR="$TMP/data" "$PLUGIN_ROOT/bin/ops-external")
[ "$(echo "$OUT" | jq 'length')" -eq 3 ]
[ "$(echo "$OUT" | jq '[.[].alias] | sort == ["chat","docs","named-custom"]')" = true ]
[ "$(echo "$OUT" | jq '[.[] | select(.alias == null or .alias == "null")] | length')" -eq 0 ]
[ "$(echo "$OUT" | jq '[.[] | select(.source == "Developer" or .source == ".grok")] | length')" -eq 0 ]
[ "$(echo "$OUT" | jq '[.[] | select(.status == "unknown_source")] | length')" -eq 0 ]

echo "PASS: ops-external only selects actual external registry rows"
