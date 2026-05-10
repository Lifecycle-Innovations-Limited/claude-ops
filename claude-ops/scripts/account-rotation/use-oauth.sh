#!/bin/bash
# use-oauth.sh — exit Bedrock mode in this shell, restore Anthropic OAuth defaults.
# Source me: `source ~/.claude/scripts/account-rotation/use-oauth.sh`
#
# Persists to ~/.claude/settings.json: removes Bedrock + hardcoded model overrides
# so Claude Code loads the subscription model catalog from the API.
# OAuth token is read from keychain by Claude Code on next session start.

unset CLAUDE_CODE_USE_BEDROCK
unset AWS_BEDROCK_REGION
unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL

python3 - <<'PYEOF'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
try:
    s = json.load(open(p))
except Exception:
    s = {}
env = s.setdefault("env", {})
for k in ("CLAUDE_CODE_USE_BEDROCK", "AWS_BEDROCK_REGION",
          "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
          "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"):
    env.pop(k, None)
s["env"] = env
s.pop("model", None)
s.pop("availableModels", None)
with open(p, "w") as f:
    json.dump(s, f, indent=2)
print("✓ settings.json env updated (Bedrock + hardcoded models removed)")
PYEOF

ACTIVE=$(python3 -c "import json; print(json.load(open('$HOME/.claude/scripts/account-rotation/state.json')).get('activeAccount',''))" 2>/dev/null)
echo "✅ OAuth mode restored for this shell + persisted to settings.json"
echo "   models       : (subscription catalog — no hardcoded IDs)"
echo "   active account: ${ACTIVE:-(unknown)}"
if [[ -f ~/.claude/.bedrock-fallback.json ]]; then
  echo "   ⚠  Bedrock sentinel still present — clearing"
  rm -f ~/.claude/.bedrock-fallback.json
fi

echo "   Reload zsh aliases/functions in this shell..."
[[ -f ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
echo "✅ Shell reloaded. New \`claude\` sessions will use OAuth."
