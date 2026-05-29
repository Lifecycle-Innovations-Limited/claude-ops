#!/usr/bin/env bash
# email-cos-sweep.sh — L1 Haiku sweep: classify, label, archive, queue pending.
# Sources config via lib/config.sh; all deployment-specific values come from config.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

# Single-instance guard (requires claude-ops once.sh).
_ONCE_LIB="$HOME/.claude/scripts/lib/once.sh"
if [ -f "$_ONCE_LIB" ]; then
  source "$_ONCE_LIB"
  claude_once email-cos-sweep 0 || exit 0
fi

SD="$EMAIL_COS_STATE_DIR"
mkdir -p "$SD/pending.d"

ts=$(date -u +%FT%TZ)
start=$(date +%s)

# (A) Cheap pre-check: skip LLM boot if no unseen inbox ids.
if [ -z "$EMAIL_COS_ACCOUNT" ]; then
  echo "email-cos-sweep: EMAIL_COS_ACCOUNT not configured, exiting" >&2
  exit 1
fi

new=$(gog gmail search "in:inbox" -a "$EMAIL_COS_ACCOUNT" --max 40 -j --results-only --no-input 2>/dev/null \
  | python3 -c "
import json,sys,pathlib
sd=pathlib.Path('$SD')
try: d=json.load(sys.stdin)
except: d=[]
seen=set((sd/'seen_sweep.txt').read_text().split()) if (sd/'seen_sweep.txt').exists() else set()
print(sum(1 for t in d if t.get('id') not in seen))
" 2>/dev/null || echo "0")

if [ "${new:-0}" = "0" ]; then
  echo "{\"ts\":\"$ts\",\"tier\":\"sweep\",\"exit\":0,\"secs\":0,\"noop\":true}" >> "$SD/metrics.jsonl"
  exit 0
fi

# Build the prompt, injecting account and category list at runtime.
CATEGORIES_FILE="${EMAIL_COS_CONFIG_DIR:-$HOME/.config/email-cos}/categories.json"
if [ ! -f "$CATEGORIES_FILE" ]; then
  CATEGORIES_FILE="$_SCRIPT_DIR/categories.example.json"
fi

CAT_LIST=$(python3 -c "
import json,pathlib
cats=json.loads(pathlib.Path('$CATEGORIES_FILE').read_text())
for c in cats.get('categories',[]):
    no=(' (no-autodraft)' if c.get('no_autodraft') else '')
    print(f\"  - {c['name']}: {c['description']}{no}\")
" 2>/dev/null || echo "  - Personal: fallback category")

PROMPT_TEMPLATE="$SD/sweep.prompt"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
  # Fall back to the bundled prompt template.
  PROMPT_TEMPLATE="$_SCRIPT_DIR/prompts/sweep.prompt"
fi

export EMAIL_COS_CATEGORY_LIST="$CAT_LIST"
RENDERED_PROMPT=$(python3 -c "
import pathlib, os
tmpl=pathlib.Path('$PROMPT_TEMPLATE').read_text()
tmpl=tmpl.replace('{{EMAIL_COS_ACCOUNT}}', os.environ.get('EMAIL_COS_ACCOUNT',''))
tmpl=tmpl.replace('{{EMAIL_COS_STATE_DIR}}', os.environ.get('EMAIL_COS_STATE_DIR',''))
tmpl=tmpl.replace('{{CATEGORY_LIST}}', os.environ.get('EMAIL_COS_CATEGORY_LIST',''))
print(tmpl)
")

: > "$SD/sweep.out"
printf '%s' "$RENDERED_PROMPT" | \
  claude --print --model "$EMAIL_COS_SWEEP_MODEL" --dangerously-skip-permissions >> "$SD/sweep.out" 2>&1
rc=$?
secs=$(( $(date +%s) - start ))
echo "{\"ts\":\"$ts\",\"tier\":\"sweep\",\"exit\":$rc,\"secs\":$secs,\"new\":$new}" >> "$SD/metrics.jsonl"

# (B) Chain: if anything got queued, kick the orchestrator immediately.
if [ -n "$(ls -A "$SD/pending.d" 2>/dev/null)" ]; then
  systemctl --user start email-cos-orch.service 2>/dev/null || true
fi
exit $rc
