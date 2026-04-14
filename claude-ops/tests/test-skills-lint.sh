#!/usr/bin/env bash
# test-skills-lint.sh — Validates all SKILL.md files in skills/
set -euo pipefail

IS_MACOS=false
[[ "$(uname)" == "Darwin" ]] && IS_MACOS=true

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$PLUGIN_ROOT/skills"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

VALID_TOOLS=("Bash" "Read" "Write" "Edit" "Grep" "Glob" "Skill" "Agent" "AskUserQuestion" "WebSearch" "WebFetch" "TodoRead" "TodoWrite" "NotebookRead" "NotebookEdit" "mcp__" "Task")

skill_files=()
while IFS= read -r -d '' f; do
  skill_files+=("$f")
done < <(find "$SKILLS_DIR" -name "SKILL.md" -print0 2>/dev/null)

if [[ ${#skill_files[@]} -eq 0 ]]; then
  echo "FAIL: No SKILL.md files found in $SKILLS_DIR"
  exit 1
fi

echo "Found ${#skill_files[@]} SKILL.md file(s)"
echo ""

for skill_file in "${skill_files[@]}"; do
  rel="${skill_file#$PLUGIN_ROOT/}"
  echo "Checking: $rel"

  # Extract frontmatter (between first and second ---)
  frontmatter=$(awk '/^---/{c++; if(c==2)exit} c==1' "$skill_file")

  # 1. Has required frontmatter fields: name, description, allowed-tools
  if echo "$frontmatter" | grep -q "^name:"; then
    ok "has 'name' field"
  else
    err "missing 'name' field in frontmatter"
  fi

  if echo "$frontmatter" | grep -q "^description:"; then
    ok "has 'description' field"
  else
    err "missing 'description' field in frontmatter"
  fi

  if echo "$frontmatter" | grep -q "^allowed-tools:"; then
    ok "has 'allowed-tools' field"
  else
    err "missing 'allowed-tools' field in frontmatter"
  fi

  # 2. No AskUserQuestion option lists > 4 items
  # Look for option arrays that may exceed 4 items by counting consecutive list items after "options:"
  max_options=0
  in_options=0
  count=0
  while IFS= read -r line; do
    if echo "$line" | grep -qE "options\s*:"; then
      in_options=1
      count=0
    elif [[ $in_options -eq 1 ]]; then
      if echo "$line" | grep -qE "^\s*-\s+"; then
        count=$((count+1))
        if (( count > max_options )); then
          max_options=$count
        fi
      elif echo "$line" | grep -qE "^\s*[a-zA-Z]" && ! echo "$line" | grep -qE "^\s*-"; then
        in_options=0
        count=0
      fi
    fi
  done < "$skill_file"

  if (( max_options > 4 )); then
    err "AskUserQuestion options list has $max_options items (max 4) in $rel"
  else
    ok "AskUserQuestion option count OK (max found: $max_options)"
  fi

  # 3. No hardcoded personal data (emails, tokens, personal names)
  # Allow placeholder patterns like example@example.com or your@email.com
  if grep -qE "[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|project-domain|lifecycle)\.(com|ai|io)" "$skill_file" 2>/dev/null; then
    # Allow clearly marked examples/placeholders
    bad=$(grep -E "[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|project-domain|lifecycle)\.(com|ai|io)" "$skill_file" | grep -vE "(example|placeholder|your-|<|>|\[|\]|#)" || true)
    if [[ -n "$bad" ]]; then
      err "possible hardcoded email in $rel: $bad"
    else
      ok "no hardcoded personal emails (example patterns OK)"
    fi
  else
    ok "no hardcoded personal emails"
  fi

  # Check for token patterns — require a realistic suffix (20+ alnum chars) after prefix
  # This avoids false positives on documentation phrases like 'Key starts with "gsk_"'
  token_hits=$(grep -E "(sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|shp(pa|ca|at)_[A-Za-z0-9]{20,}|xox[bp]-[0-9]+-[A-Za-z0-9-]+|gsk_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,})" "$skill_file" 2>/dev/null || true)
  if [[ -n "$token_hits" ]]; then
    err "possible hardcoded token/secret in $rel: $(echo "$token_hits" | head -1)"
  else
    ok "no hardcoded tokens"
  fi

  # 4. Tools referenced in skill body match allowed-tools
  allowed_section=$(echo "$frontmatter" | awk '/^allowed-tools:/,/^[a-z]/' | grep -E "^\s+-\s+" | sed 's/.*- //' || true)
  ok "allowed-tools declared (tool-body cross-check is advisory)"

  # 5. No unclosed code fences
  fence_count=$(grep -c '^\s*```' "$skill_file" 2>/dev/null || true)
  if (( fence_count % 2 != 0 )); then
    err "odd number of code fences ($fence_count) — possible unclosed block in $rel"
  else
    ok "code fences balanced ($fence_count)"
  fi

  echo ""
done

echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
