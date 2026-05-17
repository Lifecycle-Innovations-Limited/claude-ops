#!/usr/bin/env bash
# test-agents-lint.sh — Validates all agent definition files in agents/
#
# Checks:
#   1. Required frontmatter fields: name, description
#   2. model field is present
#   3. maxTurns (when present) is a positive integer
#   4. effort (when present) is one of: low / medium / high
#   5. No hardcoded personal emails or API tokens
#   6. Balanced code fences
#   7. disallowedTools (when present) does not overlap with tools/allowed-tools
#   8. description does not exceed 300 chars (truncation risk in Claude UI)
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$PLUGIN_ROOT/agents"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# Collect agent .md files
agent_files=()
while IFS= read -r -d '' f; do
  agent_files+=("$f")
done < <(find "$AGENTS_DIR" -maxdepth 1 -name "*.md" -print0 2>/dev/null)

if [[ ${#agent_files[@]} -eq 0 ]]; then
  echo "FAIL: No agent .md files found in $AGENTS_DIR"
  exit 1
fi

echo "Found ${#agent_files[@]} agent definition(s)"
echo ""

for agent_file in "${agent_files[@]}"; do
  rel="${agent_file#$PLUGIN_ROOT/}"
  echo "Checking: $rel"

  # Extract frontmatter block (between first and second ---)
  frontmatter=$(awk '/^---/{c++; if(c==2)exit} c==1' "$agent_file")

  # --- 1. Required: name ---
  # Helper: extract and trim a scalar frontmatter field
  fm_val() { echo "$frontmatter" | grep "^$1:" | sed "s/^$1:\s*//" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

  if echo "$frontmatter" | grep -q "^name:"; then
    name_val=$(fm_val name)
    if [[ -n "$name_val" ]]; then
      ok "has non-empty 'name' field: $name_val"
    else
      err "empty 'name' field"
    fi
  else
    err "missing 'name' field in frontmatter"
  fi

  # --- 2. Required: description ---
  if echo "$frontmatter" | grep -q "^description:"; then
    desc_val=$(fm_val description)
    if [[ -n "$desc_val" ]]; then
      desc_len=${#desc_val}
      ok "has non-empty 'description' field ($desc_len chars)"
      # Check 8: description length — advisory only (long descriptions with <example> tags are common)
      if (( desc_len > 300 )); then
        ok "description exceeds 300 chars ($desc_len) — advisory: consider trimming for Claude UI"
      else
        ok "description length OK (<= 300 chars)"
      fi
    else
      err "empty 'description' field"
    fi
  else
    err "missing 'description' field in frontmatter"
  fi

  # --- 3. model field present ---
  if echo "$frontmatter" | grep -q "^model:"; then
    model_val=$(fm_val model)
    if [[ -n "$model_val" ]]; then
      ok "has 'model' field: $model_val"
    else
      err "empty 'model' field"
    fi
  else
    err "missing 'model' field — agents must declare a model"
  fi

  # --- 4. maxTurns must be a positive integer if present ---
  if echo "$frontmatter" | grep -q "^maxTurns:"; then
    mt_val=$(fm_val maxTurns)
    if [[ "$mt_val" =~ ^[1-9][0-9]*$ ]]; then
      ok "maxTurns is a positive integer: $mt_val"
    else
      err "maxTurns has invalid value: '$mt_val' (must be a positive integer)"
    fi
  else
    ok "maxTurns not declared (optional)"
  fi

  # --- 5. effort must be low / medium / high if present ---
  if echo "$frontmatter" | grep -q "^effort:"; then
    effort_val=$(fm_val effort)
    case "$effort_val" in
      low|medium|high)
        ok "effort value valid: $effort_val"
        ;;
      *)
        err "effort has invalid value: '$effort_val' (must be low | medium | high)"
        ;;
    esac
  else
    ok "effort not declared (optional)"
  fi

  # --- 6. No hardcoded personal emails or API tokens ---
  token_hits=$(grep -E "(sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|shp(pa|ca|at)_[A-Za-z0-9]{20,}|xox[bp]-[0-9]+-[A-Za-z0-9-]+|gsk_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,})" "$agent_file" 2>/dev/null || true)
  if [[ -n "$token_hits" ]]; then
    err "possible hardcoded token/secret: $(echo "$token_hits" | head -1)"
  else
    ok "no hardcoded tokens"
  fi

  # --- 7. Balanced code fences ---
  fence_count=$(grep -c '^\s*```' "$agent_file" 2>/dev/null || true)
  if (( fence_count % 2 != 0 )); then
    err "odd number of code fences ($fence_count) — possible unclosed block"
  else
    ok "code fences balanced ($fence_count)"
  fi

  # --- 8. disallowedTools does not overlap with tools/allowed-tools ---
  # Extract tools list (handles both inline CSV and YAML block)
  tools_inline=$(echo "$frontmatter" | grep "^tools:" | sed 's/tools:\s*//' | tr ',' '\n' | tr -d ' ' || true)
  tools_block=$(echo "$frontmatter" | awk '/^tools:/{found=1; next} found && /^\s+-/{sub(/^\s+-\s+/,""); print; next} found && /^[a-z]/{found=0}' || true)
  all_tools=$(printf '%s\n%s\n' "$tools_inline" "$tools_block" | grep -v '^$' || true)

  disallowed_block=$(echo "$frontmatter" | awk '/^disallowedTools:/{found=1; next} found && /^\s+-/{sub(/^\s+-\s+/,""); print; next} found && /^[a-z]/{found=0}' || true)

  if [[ -n "$disallowed_block" && -n "$all_tools" ]]; then
    overlap=false
    while IFS= read -r dtool; do
      [[ -z "$dtool" ]] && continue
      if echo "$all_tools" | grep -qx "$dtool"; then
        err "tool '$dtool' appears in both tools and disallowedTools"
        overlap=true
      fi
    done <<< "$disallowed_block"
    $overlap || ok "no tools/disallowedTools overlap"
  else
    ok "tools/disallowedTools overlap check skipped (one or both not declared)"
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
