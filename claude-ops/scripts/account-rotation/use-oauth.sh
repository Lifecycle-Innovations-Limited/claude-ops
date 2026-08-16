#!/bin/bash
# use-oauth.sh — exit Bedrock mode in this shell, restore OAuth defaults.
# Source me: `source ~/.claude/scripts/account-rotation/use-oauth.sh`
#
# Persists to ~/.claude/settings.json via claude-routing-state: no base-URL
# override and no injected API key, so Claude Code uses its own OAuth credential.

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
"$_ROT_DIR/../../../.local/bin/claude-stack" route --mode oauth --reason oauth-restored >/dev/null || return 1 2>/dev/null || exit 1

ACTIVE=$(python3 -c "import json; print(json.load(open('$HOME/.claude/scripts/account-rotation/state.json')).get('activeAccount',''))" 2>/dev/null)
echo "✅ OAuth mode restored for this shell + persisted to settings.json"
echo "   models       : (subscription catalog — no hardcoded IDs)"
echo "   route        : OAuth"
echo "   active account: ${ACTIVE:-(unknown)}"
if [[ -f ~/.claude/.bedrock-fallback.json ]]; then
  echo "   ⚠  Bedrock sentinel still present — clearing"
  rm -f ~/.claude/.bedrock-fallback.json
fi

echo "   Reload zsh aliases/functions in this shell..."
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
echo "✅ Shell reloaded. New \`claude\` sessions will use OAuth."
