#!/bin/bash
# use-bedrock.sh — switch this shell into Bedrock mode for Claude Code.
# Source me: `source ~/.claude/scripts/account-rotation/use-bedrock.sh`
#
# Sets in current shell + persists to ~/.claude/settings.json env block:
#   CLAUDE_CODE_USE_BEDROCK=1
#   AWS_BEDROCK_REGION=us-east-1 (override via env before sourcing)
#   ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL — resolved from
#   `aws bedrock list-inference-profiles` (latest Sonnet + Haiku for your region),
#   with pinned fallbacks if AWS CLI fails. BEDROCK_SKIP_RESOLVE=1 forces fallbacks.
#
# Auto-fired by rotate.mjs / daemon when all configured Anthropic Max accounts
# are LIVE-CONFIRMED at >=95% util. Sentinel: ~/.claude/.bedrock-fallback.json.
# Back to OAuth: source ~/.claude/scripts/account-rotation/use-oauth.sh

_ROT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

export CLAUDE_CODE_USE_BEDROCK=1
export AWS_BEDROCK_REGION="${AWS_BEDROCK_REGION:-us-east-1}"
export AWS_REGION="${AWS_REGION:-$AWS_BEDROCK_REGION}"

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL

_RESOLVED=""
if command -v node >/dev/null 2>&1 && [[ -f "$_ROT_DIR/resolve-bedrock-models.mjs" ]]; then
  _RESOLVED="$(cd "$_ROT_DIR" && node resolve-bedrock-models.mjs 2>/dev/null)" || true
fi

if [[ -n "$_RESOLVED" ]]; then
  export ANTHROPIC_MODEL="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('primary',''))" "$_RESOLVED")"
  export ANTHROPIC_SMALL_FAST_MODEL="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('small',''))" "$_RESOLVED")"
fi
if [[ -z "$ANTHROPIC_MODEL" ]]; then
  export ANTHROPIC_MODEL="us.anthropic.claude-sonnet-4-6"
fi
if [[ -z "$ANTHROPIC_SMALL_FAST_MODEL" ]]; then
  export ANTHROPIC_SMALL_FAST_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"
fi

_SRC="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('source','?'))" "$_RESOLVED" 2>/dev/null || echo "?")"

# Persist to ~/.claude/settings.json so NEW Claude Code sessions inherit Bedrock
# even without sourcing this file. Backs up the prior env block once.
python3 - "$_SRC" <<'PYEOF'
import json, os, shutil, sys
p = os.path.expanduser("~/.claude/settings.json")
bak = p + ".bak.pre-bedrock"
try:
    s = json.load(open(p))
except Exception:
    s = {}
if not os.path.exists(bak):
    try: shutil.copy(p, bak)
    except Exception: pass
env = s.setdefault("env", {})
env["CLAUDE_CODE_USE_BEDROCK"] = "1"
env["AWS_BEDROCK_REGION"] = os.environ.get("AWS_BEDROCK_REGION", "us-east-1")
env["AWS_REGION"] = env["AWS_BEDROCK_REGION"]
env["ANTHROPIC_MODEL"] = os.environ.get("ANTHROPIC_MODEL", "")
env["ANTHROPIC_SMALL_FAST_MODEL"] = os.environ.get("ANTHROPIC_SMALL_FAST_MODEL", "")
for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
    env.pop(k, None)
s.pop("model", None)
s.pop("availableModels", None)
with open(p, "w") as f:
    json.dump(s, f, indent=2)
src = sys.argv[1] if len(sys.argv) > 1 else "?"
print("✓ settings.json env updated (" + src + "; backup: " + bak + ")")
PYEOF

echo "✅ Bedrock mode active for this shell + persisted to settings.json"
echo "   region   : $AWS_BEDROCK_REGION"
echo "   resolve  : $_SRC (latest from inference profiles when api)"
echo "   model    : $ANTHROPIC_MODEL"
echo "   fast     : $ANTHROPIC_SMALL_FAST_MODEL"
echo "   identity : $(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo 'aws sts FAILED')"
echo ""
echo "   Reload zsh aliases/functions in this shell..."
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
echo "✅ Shell reloaded. New \`claude\` sessions will use Bedrock."
echo "   Back to OAuth: source ~/.claude/scripts/account-rotation/use-oauth.sh"
