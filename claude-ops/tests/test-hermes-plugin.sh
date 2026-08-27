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

plugin_ver="$(python3 -c "import json; print(json.load(open('$PLUGIN_ROOT/.claude-plugin/plugin.json'))['version'])")"
hermes_ver="$(awk -F'"' '/^version:/{print $2; exit}' "$HP/plugin.yaml")"
if [[ -z "$hermes_ver" ]]; then
  hermes_ver="$(awk '/^version:/{gsub(/[" ]/,""); sub(/^version:/,""); print; exit}' "$HP/plugin.yaml")"
fi
if [[ "$plugin_ver" == "$hermes_ver" ]]; then
  ok "hermes-plugin version matches plugin.json ($plugin_ver)"
else
  err "hermes-plugin version '$hermes_ver' != plugin.json '$plugin_ver'"
fi

if [[ -f "$HP/__init__.py" && -f "$HP/RUNTIME.md" ]]; then
  ok "__init__.py and RUNTIME.md exist"
else
  err "missing __init__.py or RUNTIME.md"
fi

# Redirect the bytecode cache so py_compile does not drop __pycache__ in the tree.
if PYTHONPYCACHEPREFIX="$(mktemp -d)" python3 -m py_compile "$HP/__init__.py"; then
  ok "__init__.py compiles"
else
  err "__init__.py failed to compile"
fi

# Plugin slash command handlers are terminal responses, not agent turns. The
# installer-mirrored skills own /ops-*; registering the same names here shadows
# them and only echoes the handler string back to the user.
registration_json="$(PYTHONPYCACHEPREFIX="$(mktemp -d)" python3 - "$HP/__init__.py" <<'PY'
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("claude_ops_hermes_plugin", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.skills = []
        self.commands = []

    def register_skill(self, name, path, description=""):
        self.skills.append(name)

    def register_command(self, name, **kwargs):
        self.commands.append(name)

ctx = Context()
module.register(ctx)
print(json.dumps({"skills": ctx.skills, "commands": ctx.commands}))
PY
)"
if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); raise SystemExit(0 if "ops-inbox" in d["skills"] and "ops" in d["skills"] else 1)' "$registration_json"; then
  ok "Hermes plugin registers ops + ops-inbox as namespaced skills"
else
  err "Hermes plugin did not register expected namespaced skills"
fi
if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); raise SystemExit(0 if d["commands"] == [] else 1)' "$registration_json"; then
  ok "Hermes plugin does not shadow skill slash commands"
else
  err "Hermes plugin still registers shadowing slash commands: $registration_json"
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
