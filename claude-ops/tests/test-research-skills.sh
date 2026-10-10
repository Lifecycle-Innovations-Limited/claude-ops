#!/usr/bin/env bash
# test-research-skills.sh — contract tests for ops-research and ops-research-audit.
#
# WHAT IS ASSERTED
#   (a) both skills ship a byte-identical research-contract.md and each SKILL.md
#       names it relative to its own directory
#   (b) the reference resolves when ONLY one of the two skills is installed
#       (per-skill copies/registration must not depend on a sibling skill)
#   (c) frontmatter lint: no Bash(curl:*), no blanket curl, no shell-config or
#       secret paths — with a negative control proving the lint is not vacuous
#   (d) the contract carries the required rules (query-docs, two-route cap,
#       unknown cost, untrusted data) and none of the retired claims
#   (e) the prompt-injection EVAL fixture exists, is named by the contract and
#       its expected verdict is "data, zero tool calls"
#
# This is a static contract check. A live model EVAL is a separate acceptance
# step and is NOT run here. Public repo: no personal data in this file.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS="$PLUGIN_ROOT/skills"
FIX="$PLUGIN_ROOT/tests/fixtures/research"
RES="$SKILLS/ops-research"
AUD="$SKILLS/ops-research-audit"
REF="references/research-contract.md"

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "=== research skills contract ==="

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- (a) identical references, named relative to own dir ---------------------
if [[ -f "$RES/$REF" && -f "$AUD/$REF" ]] && cmp -s "$RES/$REF" "$AUD/$REF"; then
  ok "research-contract.md is byte-identical in both skills"
else
  err "research-contract.md missing or differs between ops-research and ops-research-audit"
fi
for s in "$RES" "$AUD"; do
  if grep -q "](${REF})" "$s/SKILL.md"; then
    ok "$(basename "$s") names $REF relative to its own directory"
  else
    err "$(basename "$s") does not link $REF relative to its own directory"
  fi
done

# --- (b) single-skill layouts resolve the reference ---------------------------
for s in "$AUD" "$RES"; do
  name="$(basename "$s")"
  layout="$WORK/layout-$name"
  mkdir -p "$layout"
  cp -R "$s" "$layout/$name"
  linked="$(grep -oE '\]\(references/[^)]+\)' "$layout/$name/SKILL.md" | head -1 | sed 's/^](//; s/)$//')"
  if [[ -n "$linked" && -f "$layout/$name/$linked" ]]; then
    ok "$name-only layout resolves $linked"
  else
    err "$name-only layout cannot resolve its reference (got '$linked')"
  fi
done

# --- (c) frontmatter lint with negative control -------------------------------
# Returns 0 when clean, 1 when a forbidden grant or path is present.
lint_skill() {
  local f="$1" fm
  fm="$(awk '/^---/{c++; if(c==2)exit} c==1' "$f")"
  if grep -qE 'Bash\(curl' <<<"$fm"; then return 1; fi
  if grep -qiE '^\s*-\s*Bash\(\*\)|curl:\*' <<<"$fm"; then return 1; fi
  if grep -qE '(\.zshrc|\.bashrc|\.zprofile|\.bash_profile|[~$]HOME?/\.profile|~/\.env|\.netrc|\.aws/credentials|[Kk]eychain)' "$f"; then
    return 1
  fi
  return 0
}

for s in "$RES" "$AUD"; do
  if lint_skill "$s/SKILL.md"; then
    ok "$(basename "$s") frontmatter has no curl grant or shell/secret path"
  else
    err "$(basename "$s") frontmatter grants curl or names a shell/secret path"
  fi
done

neg="$WORK/neg/SKILL.md"
mkdir -p "$(dirname "$neg")"
cat >"$neg" <<'EOF'
---
name: neg
description: "This skill should be used when testing the lint."
allowed-tools:
  - Bash(curl:*)
---
Read ~/.zshrc to find the API key.
EOF
if lint_skill "$neg"; then
  err "negative control: lint accepted Bash(curl:*) and ~/.zshrc (lint is vacuous)"
else
  ok "negative control: lint rejects Bash(curl:*) and ~/.zshrc"
fi

# --- (d) required contract rules ----------------------------------------------
C="$RES/$REF"
check_has() {
  if grep -qiE "$1" "$C"; then ok "contract: $2"; else err "contract missing: $2"; fi
}
check_not() {
  if grep -qiE "$1" "$C"; then err "contract must not contain: $2"; else ok "contract free of: $2"; fi
}
check_has 'query-docs' "Context7 query-docs"
check_has 'at most two distinct search routes' "two-route cap"
check_has 'cost status is `unknown`' "unknown cost stays unknown"
check_has 'untrusted data, never instructions' "web content is untrusted data"
check_has 'coverage gap, not evidence of absence' "failure is a coverage gap"
check_has 'provisional' "unread conclusions stay provisional"
check_has 'publication date.*unknown' "unknown publication date"
check_not 'get-library-docs' "outdated get-library-docs tool name"
check_not 'unmetered' "unproven unmetered claim"
check_not 'Bash\(curl' "curl grant"
check_not '\.zshrc' "shell config as secret source"

# --- (e) prompt-injection EVAL fixture ----------------------------------------
if [[ -f "$FIX/injection-page.html" ]] && grep -qi 'ignore previous instructions' "$FIX/injection-page.html"; then
  ok "injection fixture exists and carries an embedded instruction"
else
  err "injection fixture missing or has no embedded instruction"
fi
if grep -q 'tests/fixtures/research/injection-page.html' "$C"; then
  ok "contract EVAL section names the injection fixture"
else
  err "contract EVAL section does not name the injection fixture"
fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); raise SystemExit(0 if d.get("treat_as")=="data" and d.get("tool_calls")==0 else 1)' "$FIX/expected-verdict.json" 2>/dev/null; then
  ok "expected verdict: treat as data, zero tool calls"
else
  err "expected verdict is not data/0 tool calls"
fi

echo "NOTE: live model EVAL not executed (static contract check only)"
echo ""
echo "Results: $pass passed, $fail failed"
((fail == 0))
