#!/usr/bin/env bash
# test-hermes-plugin.sh — native Hermes package stays loadable and public-clean
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HP="$PLUGIN_ROOT/hermes-plugin"

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "Checking: hermes-plugin"
echo ""

if [[ -f "$HP/plugin.yaml" ]]; then
  ok "plugin.yaml exists"
else
  err "plugin.yaml missing"
fi

if grep -qE '^name:[[:space:]]*ops[[:space:]]*$' "$HP/plugin.yaml"; then
  ok "plugin.yaml name is ops"
else
  err "plugin.yaml name must be ops"
fi

if [[ -f "$HP/__init__.py" && -f "$HP/RUNTIME.md" ]]; then
  ok "__init__.py and RUNTIME.md exist"
else
  err "missing __init__.py or RUNTIME.md"
fi

if python3 -m py_compile "$HP/__init__.py"; then
  ok "__init__.py compiles"
else
  err "__init__.py failed to compile"
fi

skill_count=$(find "$PLUGIN_ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
if ((skill_count >= 50)); then
  ok "sibling skills/ has $skill_count SKILL.md files"
else
  err "sibling skills/ looks empty ($skill_count)"
fi

if grep -q 'AskUserQuestion' "$HP/RUNTIME.md" && grep -q 'delegate_task' "$HP/RUNTIME.md"; then
  ok "RUNTIME.md maps AskUserQuestion and Workflow"
else
  err "RUNTIME.md missing required primitive maps"
fi

# Public-repo: no home paths or mailbox addresses in this package.
if grep -RE --exclude-dir='__pycache__' --include='*.py' --include='*.md' --include='*.yaml' \
  '(/Users/|/home/[a-z]|@gmail\.com|@samfeldt)' "$HP" >/dev/null; then
  err "hermes-plugin contains a private path or mailbox"
else
  ok "hermes-plugin has no private paths or mailboxes"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if ((fail > 0)); then
  exit 1
fi
exit 0
