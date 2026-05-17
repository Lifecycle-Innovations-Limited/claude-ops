#!/usr/bin/env bash
# page-diff.sh — fetch a competitor URL, normalize, SHA, diff vs prior snapshot.
# Emits a JSONL event when the page has changed. Silent (exit 0, no output) when unchanged.
#
# Usage:
#   page-diff.sh <brand> <competitor> <kind> <url>
#     kind ∈ {pricing, features, careers, blog, changelog, other}
#
# State layout:
#   $DATA_DIR/competitor_state/<brand>/<competitor>/snapshots/<kind>.<sha8>.txt
#   $DATA_DIR/competitor_state/<brand>/<competitor>/snapshots/<kind>.latest        # symlink
#
# Severity:
#   high — pricing page changed AND diff touches a $€£ or /mo /yr token
#   med  — pricing/features/changelog changed (no money token), or careers added a role
#   low  — copy tweak, whitespace, or no signal worth alerting on
#
# Output (stdout, one line):
#   {"source":"page-diff","timestamp":"…","competitor":"…","kind":"…","url":"…",
#    "old_sha":"…","new_sha":"…","lines_changed":N,"severity":"…","snippet":"…"}

set -euo pipefail

BRAND="${1:?brand required}"
COMPETITOR="${2:?competitor required}"
KIND="${3:?kind required}"
URL="${4:?url required}"

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/competitor-page-diff.log"
mkdir -p "$LOG_DIR"
log() { printf '%s [page-diff] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

# Slugify brand + competitor for filesystem safety
slug() { printf '%s' "$1" | tr '[:upper:] /' '[:lower:]--' | tr -cd 'a-z0-9-_.'; }
BRAND_SLUG=$(slug "$BRAND")
COMP_SLUG=$(slug "$COMPETITOR")
SNAP_DIR="$DATA_DIR/competitor_state/$BRAND_SLUG/$COMP_SLUG/snapshots"
mkdir -p "$SNAP_DIR"

# ── Fetch + normalize ────────────────────────────────────────────────────
# 30s timeout, follow redirects, modern UA so most sites don't 403.
HTML=$(curl -sSL \
  --max-time 30 \
  --retry 1 \
  --retry-delay 2 \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605 claude-ops-competitor-intel/2.3" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "$URL" 2>>"$LOG" || true)

if [[ -z "$HTML" ]]; then
  log "FETCH_FAIL $BRAND/$COMPETITOR/$KIND $URL — empty body"
  exit 0
fi

# Normalize: strip <script>/<style>/<noscript> blocks, then strip all tags,
# collapse whitespace, drop blank lines. Keep money tokens intact.
NORMALIZER=$(mktemp)
cat > "$NORMALIZER" <<'PYEOF'
import sys, re
html = sys.stdin.read()
for tag in ("script", "style", "noscript", "svg"):
    html = re.sub(rf"<{tag}\b[^>]*>.*?</{tag}>", "", html, flags=re.DOTALL | re.IGNORECASE)
html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)
html = re.sub(r"</(p|div|section|article|li|h[1-6]|tr|br)>", "\n", html, flags=re.IGNORECASE)
html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
html = re.sub(r"<[^>]+>", " ", html)
for old, new in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
    html = html.replace(old, new)
out = []
for line in html.splitlines():
    s = re.sub(r"\s+", " ", line).strip()
    if len(s) >= 3:
        out.append(s)
print("\n".join(out))
PYEOF

NORMALIZED=$(printf '%s' "$HTML" | python3 "$NORMALIZER" 2>>"$LOG" || true)
rm -f "$NORMALIZER"

if [[ -z "$NORMALIZED" ]]; then
  log "NORMALIZE_FAIL $BRAND/$COMPETITOR/$KIND $URL"
  exit 0
fi

# ── SHA + diff ────────────────────────────────────────────────────────────
if command -v shasum >/dev/null 2>&1; then
  NEW_SHA=$(printf '%s' "$NORMALIZED" | shasum -a 256 | awk '{print $1}')
else
  NEW_SHA=$(printf '%s' "$NORMALIZED" | sha256sum | awk '{print $1}')
fi
NEW_SHA8="${NEW_SHA:0:8}"
NEW_FILE="$SNAP_DIR/$KIND.$NEW_SHA8.txt"
LATEST_LINK="$SNAP_DIR/$KIND.latest"

# First run for this URL — write baseline and exit (no event; nothing to compare)
if [[ ! -L "$LATEST_LINK" ]]; then
  printf '%s\n' "$NORMALIZED" > "$NEW_FILE"
  ln -sf "$NEW_FILE" "$LATEST_LINK"
  log "BASELINE $BRAND/$COMPETITOR/$KIND sha=$NEW_SHA8 (no event emitted on first run)"
  exit 0
fi

OLD_FILE=$(readlink "$LATEST_LINK")
[[ "$OLD_FILE" != /* ]] && OLD_FILE="$SNAP_DIR/$OLD_FILE"
OLD_SHA8=$(basename "$OLD_FILE" .txt | awk -F. '{print $NF}')

# No change → silent exit
if [[ "$NEW_SHA8" == "$OLD_SHA8" ]]; then
  exit 0
fi

# Compute diff stats + extract a snippet of changed lines
printf '%s\n' "$NORMALIZED" > "$NEW_FILE"
DIFF_OUT=$(diff -u "$OLD_FILE" "$NEW_FILE" 2>/dev/null || true)
LINES_CHANGED=$(printf '%s\n' "$DIFF_OUT" | grep -cE '^[+-][^+-]' || echo 0)
# Extract first 5 changed lines (skip diff header), cap to 400 chars total
CHANGED_SNIPPET=$(printf '%s\n' "$DIFF_OUT" | grep -E '^[+][^+]' | head -5 | sed 's/^+//' | tr '\n' ' ' | head -c 400)

# Detect money/pricing tokens in the changes (signal that pricing actually moved)
HAS_MONEY_TOKEN=0
if printf '%s' "$CHANGED_SNIPPET" | grep -qE '\$[0-9]+|€[0-9]+|£[0-9]+|[0-9]+\s*(USD|EUR|GBP)|\/(mo|month|yr|year)\b|free\s+trial|per\s+(seat|user)'; then
  HAS_MONEY_TOKEN=1
fi

# ── Severity classification ──────────────────────────────────────────────
SEVERITY=low
case "$KIND" in
  pricing)
    if (( HAS_MONEY_TOKEN == 1 )); then SEVERITY=high; else SEVERITY=med; fi
    ;;
  features|changelog)
    SEVERITY=med
    ;;
  careers)
    # Job postings count change → med if grew or any senior keyword in snippet
    if printf '%s' "$CHANGED_SNIPPET" | grep -qiE '\b(VP|head of|director|chief|founding|principal)\b'; then
      SEVERITY=high
    else
      SEVERITY=med
    fi
    ;;
esac

# Tiny diffs (< 3 lines changed) downgrade to low unless pricing+money
if (( LINES_CHANGED < 3 )) && [[ "$SEVERITY" != "high" ]]; then
  SEVERITY=low
fi

# Update latest pointer
ln -sf "$NEW_FILE" "$LATEST_LINK"

# Retention: keep last 12 snapshots per kind, drop older
find "$SNAP_DIR" -maxdepth 1 -name "$KIND.*.txt" -type f -print0 \
  | xargs -0 ls -t 2>/dev/null \
  | tail -n +13 \
  | while read -r old; do rm -f "$old"; done

# Emit event
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg comp "$COMPETITOR" \
      --arg kind "$KIND" \
      --arg url "$URL" \
      --arg old "$OLD_SHA8" \
      --arg new "$NEW_SHA8" \
      --argjson lc "${LINES_CHANGED:-0}" \
      --arg sev "$SEVERITY" \
      --arg snip "$CHANGED_SNIPPET" \
      '{source:"page-diff", timestamp:$ts, competitor:$comp, kind:$kind, url:$url, old_sha:$old, new_sha:$new, lines_changed:$lc, severity:$sev, snippet:$snip}'

log "DIFF $BRAND/$COMPETITOR/$KIND $OLD_SHA8 → $NEW_SHA8 lines=$LINES_CHANGED severity=$SEVERITY"
