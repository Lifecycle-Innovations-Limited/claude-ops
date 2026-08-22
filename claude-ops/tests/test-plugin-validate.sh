#!/usr/bin/env bash
# test-plugin-validate.sh — plugin-dev layout checks (and claude plugin validate if present)
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "Checking: plugin layout"
echo ""

if [[ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]]; then
  ok "plugin.json exists"
else
  err "missing .claude-plugin/plugin.json"
fi

python3 - "$PLUGIN_ROOT" <<'PY' && ok "plugin.json has name+version" || err "plugin.json missing name/version"
import json, sys
from pathlib import Path
d=json.loads((Path(sys.argv[1])/".claude-plugin"/"plugin.json").read_text())
assert d.get("name") and d.get("version")
PY

if grep -q "skills/ops-rules/SKILL.md" "$PLUGIN_ROOT/CLAUDE.md"; then
  ok "CLAUDE.md is a pointer to ops-rules"
else
  err "CLAUDE.md must point at skills/ops-rules/SKILL.md"
fi

if [[ -f "$PLUGIN_ROOT/skills/ops-rules/SKILL.md" ]]; then
  ok "ops-rules skill present"
else
  err "ops-rules skill missing"
fi

if [[ -x "$PLUGIN_ROOT/hooks/ops-rules-context.sh" ]]; then
  ok "SessionStart ops-rules hook is executable"
else
  err "hooks/ops-rules-context.sh missing or not executable"
fi

if [[ -f "$PLUGIN_ROOT/.mcp.json" ]]; then
  python3 - "$PLUGIN_ROOT/.mcp.json" <<'PY' && ok ".mcp.json is valid JSON"
import json, sys
json.load(open(sys.argv[1]))
PY
else
  ok ".mcp.json absent (MCP is on-demand, not bundled)"
fi

if command -v claude >/dev/null 2>&1; then
  if claude plugin validate "$PLUGIN_ROOT" >/tmp/ops-plugin-validate.out 2>&1; then
    if grep -qi "CLAUDE.md at the plugin root is not loaded" /tmp/ops-plugin-validate.out && \
       ! grep -q "skills/ops-rules" "$PLUGIN_ROOT/CLAUDE.md"; then
      err "claude plugin validate still expects rules in a skill"
    else
      ok "claude plugin validate passed"
    fi
  else
    # validate may warn; treat error-only as fail
    if grep -q "✔ Validation passed" /tmp/ops-plugin-validate.out; then
      ok "claude plugin validate passed with warnings"
    else
      err "claude plugin validate failed"
      cat /tmp/ops-plugin-validate.out | head -40
    fi
  fi
else
  echo "  SKIP: claude CLI not on PATH"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if ((fail > 0)); then
  exit 1
fi
exit 0
