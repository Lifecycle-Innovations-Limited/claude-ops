#!/usr/bin/env bash
# test-agent-teams.sh — Ensures every skill that spawns agents has Agent Teams support
#
# Policy: Any SKILL.md that references Agent() or subagent spawning MUST also have:
#   1. "TeamCreate" and "SendMessage" in allowed-tools
#   2. An "## Agent Teams support" section in the body
#   3. A conditional check for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
#
# Skills that ONLY run shell scripts (no Agent tool) are exempt.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$PLUGIN_ROOT/skills"

pass=0
fail=0
skip=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }
skp()  { echo "  SKIP: $1"; skip=$((skip+1)); }

skill_files=()
while IFS= read -r -d '' f; do
  skill_files+=("$f")
done < <(find "$SKILLS_DIR" -name "SKILL.md" -print0 2>/dev/null)

if [[ ${#skill_files[@]} -eq 0 ]]; then
  echo "FAIL: No SKILL.md files found in $SKILLS_DIR"
  exit 1
fi

echo "Agent Teams compliance audit — ${#skill_files[@]} skills"
echo ""

for skill_file in "${skill_files[@]}"; do
  rel="${skill_file#$PLUGIN_ROOT/}"
  skill_name=$(basename "$(dirname "$skill_file")")

  # Extract frontmatter
  frontmatter=$(awk '/^---/{c++; if(c==2)exit} c==1' "$skill_file")

  # Check if this skill declares Agent in allowed-tools (authoritative signal)
  has_agent_tool=false
  if echo "$frontmatter" | grep -qE "^\s+-\s+Agent\b"; then
    has_agent_tool=true
  fi

  # Check if body has actual Agent() invocation patterns (not just prose mentions)
  has_agent_invocation=false
  if grep -qE "Agent\(\{|Agent\(team_name|subagent_type:" "$skill_file" 2>/dev/null; then
    has_agent_invocation=true
  fi

  # Only flag skills that ACTUALLY use the Agent tool (in allowed-tools or with invocation patterns)
  # Prose mentions like "spawn a doctor agent" or "subagents" in descriptions don't count
  if [[ "$has_agent_tool" == "false" && "$has_agent_invocation" == "false" ]]; then
    skp "$skill_name — no agent usage"
    continue
  fi

  echo "Checking: $rel"

  # 1. TeamCreate in allowed-tools
  if echo "$frontmatter" | grep -qE "^\s+-\s+TeamCreate"; then
    ok "TeamCreate in allowed-tools"
  else
    err "$skill_name: missing 'TeamCreate' in allowed-tools"
  fi

  # 2. SendMessage in allowed-tools
  if echo "$frontmatter" | grep -qE "^\s+-\s+SendMessage"; then
    ok "SendMessage in allowed-tools"
  else
    err "$skill_name: missing 'SendMessage' in allowed-tools"
  fi

  # 3. Agent Teams support section (accepts "## Agent Teams support" or "## Agent Teams" or subsection variants)
  if grep -qE "^#{2,3} .*(Agent Teams|Teams support)" "$skill_file" 2>/dev/null; then
    ok "has Agent Teams documentation section"
  else
    err "$skill_name: missing '## Agent Teams support' section"
  fi

  # 4. Feature flag check
  if grep -q "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" "$skill_file" 2>/dev/null; then
    ok "checks CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS flag"
  else
    err "$skill_name: missing CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS flag check"
  fi

  # 5. TeamCreate() call in body
  if grep -qE "TeamCreate\(" "$skill_file" 2>/dev/null; then
    ok "has TeamCreate() usage example"
  else
    err "$skill_name: missing TeamCreate() usage example in body"
  fi

  # 6. Fallback to standard subagents when flag is off
  if grep -qiE "(flag is NOT set|flag is not enabled|not set.*subagent|fallback|fire-and-forget)" "$skill_file" 2>/dev/null; then
    ok "documents fallback when flag is off"
  else
    err "$skill_name: missing fallback documentation for when flag is off"
  fi

  echo ""
done

echo "---"
echo "Results: $pass passed, $fail failed, $skip skipped"
echo ""

if (( fail > 0 )); then
  echo "To fix: add Agent Teams support sections to failing skills."
  echo "Template: see skills/ops-fires/SKILL.md for reference."
  exit 1
fi
exit 0
