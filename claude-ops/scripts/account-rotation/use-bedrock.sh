#!/bin/bash
# use-bedrock.sh — switch this shell into Bedrock mode for Claude Code.
# Source me: `source ~/.claude/scripts/account-rotation/use-bedrock.sh`
#
# Bedrock is metered AWS usage. To persist it, explicitly confirm:
#   CLAUDE_CONFIRM_METERED_BEDROCK=1 source ~/.claude/scripts/account-rotation/use-bedrock.sh
#
# Sets in current shell + persists to ~/.claude/settings.json env block:
#   CLAUDE_CODE_USE_BEDROCK=1
#   AWS_BEDROCK_REGION=us-east-1 (override via env before sourcing)
#   Model selection is left to Claude Code / the provider default.
#
# Auto-fired by rotate.mjs / daemon when all configured Anthropic Max accounts
# are LIVE-CONFIRMED at >=95% util. Sentinel: ~/.claude/.bedrock-fallback.json.
# Back to OAuth: source ~/.claude/scripts/account-rotation/use-oauth.sh

_ROT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if [[ "${CLAUDE_CONFIRM_METERED_BEDROCK:-}" != "1" ]]; then
  echo "⛔ Bedrock fallback blocked."
  echo "   Bedrock is metered AWS usage. OAuth/CRS is the preferred route."
  echo "   Reason OAuth is unavailable: ${CLAUDE_BEDROCK_REASON:-not supplied}"
  echo "   To confirm for this short session: CLAUDE_CONFIRM_METERED_BEDROCK=1 source ~/.claude/scripts/account-rotation/use-bedrock.sh"
  return 2 2>/dev/null || exit 2
fi

export CLAUDE_CODE_USE_BEDROCK=1
export AWS_BEDROCK_REGION="${AWS_BEDROCK_REGION:-us-east-1}"
export AWS_REGION="${AWS_REGION:-$AWS_BEDROCK_REGION}"

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL

unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_FABLE_MODEL

_SRC="claude-default"

CLAUDE_BEDROCK_REASON="${CLAUDE_BEDROCK_REASON:-manual use-bedrock}" \
  "$_ROT_DIR/../../../.local/bin/claude-stack" route \
  --mode bedrock-confirmed \
  --reason "${CLAUDE_BEDROCK_REASON:-manual use-bedrock}" \
  --ttl-minutes "${CLAUDE_BEDROCK_CONFIRM_TTL_MINUTES:-60}" \
  --region "$AWS_BEDROCK_REGION" \
  --confirm-metered-bedrock >/dev/null || return 1 2>/dev/null || exit 1

echo "✅ Bedrock mode active for this shell + persisted to settings.json"
echo "   region   : $AWS_BEDROCK_REGION"
echo "   model    : Claude Code default"
echo "   identity : $(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo 'aws sts FAILED')"
echo ""
echo "   Reload zsh aliases/functions in this shell..."
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
echo "✅ Shell reloaded. New \`claude\` sessions will use Bedrock."
echo "   Back to OAuth: source ~/.claude/scripts/account-rotation/use-oauth.sh"
