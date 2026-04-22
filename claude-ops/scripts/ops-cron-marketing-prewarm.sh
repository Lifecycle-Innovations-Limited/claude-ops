#!/usr/bin/env bash
# ops-cron-marketing-prewarm.sh — thin cron wrapper that invokes
# bin/ops-marketing-dash and caches its JSON output so /ops:marketing
# loads instantly from cache. Phase 16 INFR-04.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR/..}"
DATA_DIR="${DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
CACHE_DIR="$DATA_DIR/cache"
mkdir -p "$CACHE_DIR"

MARKETING_BIN="$PLUGIN_ROOT/bin/ops-marketing-dash"
[[ -x "$MARKETING_BIN" ]] || exit 0

TMP="$CACHE_DIR/marketing.json.tmp.$$"
if "$MARKETING_BIN" --json > "$TMP" 2>/dev/null; then
  python3 - "$TMP" <<'PY' 2>/dev/null || true
import json, sys, datetime
p = sys.argv[1]
try:
  d = json.load(open(p))
  d["cached_at"] = datetime.datetime.utcnow().isoformat() + "Z"
  json.dump(d, open(p, "w"))
except Exception:
  pass
PY
  mv "$TMP" "$CACHE_DIR/marketing.json"
else
  rm -f "$TMP" 2>/dev/null || true
fi
