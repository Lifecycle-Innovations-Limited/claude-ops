#!/usr/bin/env bash
# test-claude-md.sh — Validates CLAUDE.md contains required rules
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_MD="$PLUGIN_ROOT/CLAUDE.md"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: CLAUDE.md"
echo ""

# 1. File exists
if [[ ! -f "$CLAUDE_MD" ]]; then
  echo "FAIL: CLAUDE.md not found at $CLAUDE_MD"
  exit 1
fi
ok "CLAUDE.md exists"

# 2. Contains max-4-options rule
# Look for the key constraint about AskUserQuestion and 4 options
if grep -qE "(<=4|max.*4|4.*options|AskUserQuestion)" "$CLAUDE_MD"; then
  ok "contains max-4-options rule reference"
else
  err "missing max-4-options / AskUserQuestion constraint"
fi

# More specific: the actual numeric constraint
if grep -qE "4\s*(items|options)" "$CLAUDE_MD"; then
  ok "contains explicit '4 items/options' constraint"
else
  # Check for <=4 pattern
  if grep -q "<=4" "$CLAUDE_MD"; then
    ok "contains '<=4' constraint"
  else
    err "could not find explicit 4-option limit (<=4 or '4 items')"
  fi
fi

# 3. Contains never-delegate-commands rule
# The rule that says run commands via Bash tool instead of telling users to run them
if grep -qiE "(never delegate|never.*tell.*user.*run|run.*via.*bash|delegate.*terminal)" "$CLAUDE_MD"; then
  ok "contains never-delegate-commands rule"
else
  err "missing never-delegate-commands rule (should instruct to run via Bash tool, not tell user)"
fi

# More specific check
if grep -qE "(Bash tool|run_in_background)" "$CLAUDE_MD"; then
  ok "references Bash tool for command execution"
else
  err "no reference to Bash tool for command execution in CLAUDE.md"
fi

# 4. Has at least 2 numbered/named rules
rule_count=$(grep -cE "^## Rule [0-9]+" "$CLAUDE_MD" 2>/dev/null || true)
if (( rule_count >= 2 )); then
  ok "has $rule_count numbered rules"
else
  err "expected at least 2 numbered rules, found: $rule_count"
fi

# 5. File is not empty
size=$(wc -c < "$CLAUDE_MD")
if (( size > 200 )); then
  ok "CLAUDE.md has substantial content ($size bytes)"
else
  err "CLAUDE.md is suspiciously small ($size bytes)"
fi

# 6. No broken markdown headings (# at start of line followed immediately by text with no space)
bad_headings=$(grep -cE "^#{1,6}[^ #]" "$CLAUDE_MD" 2>/dev/null || true)
if (( bad_headings == 0 )); then
  ok "no malformed headings (missing space after #)"
else
  err "found $bad_headings malformed heading(s) (missing space after #)"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
