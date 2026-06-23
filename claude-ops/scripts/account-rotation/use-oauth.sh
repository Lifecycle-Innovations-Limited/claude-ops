#!/bin/bash
# use-oauth.sh — exit Bedrock mode in this shell, restore CRS-backed OAuth defaults.
# Source me: `source ~/.claude/scripts/account-rotation/use-oauth.sh`
#
# Persists to ~/.claude/settings.json via claude-routing-state:
# ANTHROPIC_BASE_URL points at CRS and CLAUDE_CODE_OAUTH_TOKEN is the CRS relay token.

unset CLAUDE_CODE_USE_BEDROCK
unset AWS_BEDROCK_REGION
unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_FABLE_MODEL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL

_ROT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
"$_ROT_DIR/../../../.local/bin/claude-stack" route --mode crs-oauth --reason oauth-restored >/dev/null || return 1 2>/dev/null || exit 1

ACTIVE=$(python3 -c "import json; print(json.load(open('$HOME/.claude/scripts/account-rotation/state.json')).get('activeAccount',''))" 2>/dev/null)
echo "✅ OAuth mode restored for this shell + persisted to settings.json"
echo "   models       : (subscription catalog — no hardcoded IDs)"
echo "   route        : CRS OAuth"
echo "   active account: ${ACTIVE:-(unknown)}"
if [[ -f ~/.claude/.bedrock-fallback.json ]]; then
  echo "   ⚠  Bedrock sentinel still present — clearing"
  rm -f ~/.claude/.bedrock-fallback.json
fi

echo "   Reload zsh aliases/functions in this shell..."
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
echo "✅ Shell reloaded. New \`claude\` sessions will use OAuth."
