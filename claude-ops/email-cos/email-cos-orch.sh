#!/usr/bin/env bash
# email-cos-orch.sh — L2 Opus orchestrator: enrich, draft, remind, queue ASKs.
# Sources config via lib/config.sh; all deployment-specific values come from config.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

SD="$EMAIL_COS_STATE_DIR"
QD="$SD/pending.d"
REVIEW="$EMAIL_COS_POCKET_STATE_DIR/review.jsonl"

[ -n "$(ls -A "$QD" 2>/dev/null)" ] || {
  echo "$(date -u +%FT%TZ) orch: queue empty, skip" >> "$SD/orch.out"
  exit 0
}

# Single-instance guard.
_ONCE_LIB="$HOME/.claude/scripts/lib/once.sh"
if [ -f "$_ONCE_LIB" ]; then
  source "$_ONCE_LIB"
  claude_once email-cos-orch 0 || exit 0
fi

ts=$(date -u +%FT%TZ)
start=$(date +%s)
rbefore=$(wc -l < "$REVIEW" 2>/dev/null || echo 0)

PROMPT_TEMPLATE="$SD/orchestrator.prompt"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
  PROMPT_TEMPLATE="$_SCRIPT_DIR/prompts/orchestrator.prompt"
fi

RENDERED_PROMPT=$(python3 -c "
import pathlib, os
tmpl=pathlib.Path('$PROMPT_TEMPLATE').read_text()
tmpl=tmpl.replace('{{EMAIL_COS_ACCOUNT}}', os.environ.get('EMAIL_COS_ACCOUNT',''))
tmpl=tmpl.replace('{{EMAIL_COS_STATE_DIR}}', os.environ.get('EMAIL_COS_STATE_DIR',''))
tmpl=tmpl.replace('{{EMAIL_COS_POCKET_STATE_DIR}}', os.environ.get('EMAIL_COS_POCKET_STATE_DIR','/var/lib/pocket-pipeline'))
tmpl=tmpl.replace('{{ICLOUD_REMINDER_SCRIPT}}', os.path.join('$_SCRIPT_DIR', 'icloud-reminder.sh'))
print(tmpl)
")

: > "$SD/orch.out"
# Run headless with a MINIMAL MCP config (enrichment servers only, e.g. gbrain +
# tavily) — loading the full env's MCP defs blows the model context. Point
# EMAIL_COS_ORCH_MCP_CONFIG at a JSON file with just the servers the orchestrator
# needs; unset/missing => no MCP (drafts from thread context only).
_ORCH_MCP="${EMAIL_COS_ORCH_MCP_CONFIG:-}"
if [ -z "$_ORCH_MCP" ] || [ ! -f "$_ORCH_MCP" ]; then _ORCH_MCP='{"mcpServers":{}}'; fi
printf '%s' "$RENDERED_PROMPT" | \
  claude --print --model "$EMAIL_COS_ORCH_MODEL" --dangerously-skip-permissions \
    --strict-mcp-config --mcp-config "$_ORCH_MCP" >> "$SD/orch.out" 2>&1
rc=$?
secs=$(( $(date +%s) - start ))
echo "{\"ts\":\"$ts\",\"tier\":\"orch\",\"exit\":$rc,\"secs\":$secs}" >> "$SD/metrics.jsonl"

if [ $rc -ne 0 ]; then
  "$_SCRIPT_DIR/email-cos-notify.sh" "email-cos ORCH failed (rc=$rc) — $(tail -3 "$SD/orch.out" 2>/dev/null | tr '\n' ' ')"
fi

# Chain: deliver digest immediately if new ASKs appeared.
rafter=$(wc -l < "$REVIEW" 2>/dev/null || echo 0)
[ "$rafter" -gt "$rbefore" ] && systemctl --user start ops-pocket-digest.service 2>/dev/null || true

exit $rc
