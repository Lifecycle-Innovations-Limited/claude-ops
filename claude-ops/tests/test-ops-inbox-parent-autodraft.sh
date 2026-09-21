#!/usr/bin/env bash
# Guard: /ops:ops-inbox must run in the parent session so drafting starts on
# the slash command. `context: fork` parked the whole skill (including drafts)
# in a background agent; the parent then idled until the owner typed
# "continue drafting". Measured 2026-09-21.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$PLUGIN_ROOT/skills/ops-inbox/SKILL.md"

pass=0
fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

frontmatter() {
  awk '/^---/{c++; if(c==2)exit} c==1 && !/^---/' "$1"
}

has_fork() {
  frontmatter "$1" | grep -qE '^context:[[:space:]]*fork[[:space:]]*$'
}

echo "Checking: ops-inbox parent auto-draft"
echo ""

if [[ ! -f "$SKILL" ]]; then
  echo "FAIL: $SKILL not found"
  exit 1
fi
ok "SKILL.md exists"

# Prove the guard would have caught the live defect, not just the current file.
FIXTURE="$(mktemp "${TMPDIR:-/tmp}/ops-inbox-fork.XXXXXX")"
trap 'rm -f "$FIXTURE"' EXIT
printf '%s\n' '---' 'name: ops-inbox' 'context: fork' '---' 'body' > "$FIXTURE"
if has_fork "$FIXTURE"; then
  ok "guard detects context: fork (the 2026-09-21 defect)"
else
  err "guard missed a context: fork fixture"
fi

if has_fork "$SKILL"; then
  err "ops-inbox frontmatter still has context: fork — parent would idle until continue drafting"
else
  ok "ops-inbox is not context: fork"
fi

if grep -q 'AUTO-START DRAFTING' "$SKILL"; then
  ok "body has AUTO-START DRAFTING"
else
  err "body missing AUTO-START DRAFTING heading"
fi

if grep -q 'continue drafting' "$SKILL"; then
  ok "body names continue drafting as something not to wait for"
else
  err "body does not mention continue drafting"
fi

if grep -q 'Always report to the main agent by default' "$SKILL"; then
  ok "body reports to the parent by default"
else
  err "body missing report-to-parent default"
fi

echo ""
echo "Results: $pass passed, $fail failed"
if (( fail > 0 )); then
  exit 1
fi
exit 0
