#!/usr/bin/env bash
# test-safety-hooks.sh — Validates the 3 universal safety hooks:
#   bin/ops-prevent-secret-commit  (PreToolUse, gated git commit*)
#   bin/ops-no-rm-rf-anchor        (PreToolUse, gated rm *)
#   bin/ops-warn-mainpush          (PreToolUse, gated git push*)
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# Helper: assert deny in JSON output.
assert_deny() {
  local out="$1" label="$2"
  if echo "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; then
    ok "$label"
  else
    err "$label (expected deny, got: $(echo "$out" | head -c 200))"
  fi
}
assert_ask() {
  local out="$1" label="$2"
  if echo "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"ask"'; then
    ok "$label"
  else
    err "$label (expected ask, got: $(echo "$out" | head -c 200))"
  fi
}
assert_allow() {
  local out="$1" label="$2"
  # Allow = empty stdout (no JSON emitted, exit 0).
  if [[ -z "$out" ]]; then
    ok "$label"
  else
    err "$label (expected silent allow, got: $(echo "$out" | head -c 200))"
  fi
}

############################################
# 1. ops-prevent-secret-commit
############################################
echo ""
echo "── ops-prevent-secret-commit ──"

TMPREPO=$(mktemp -d)
cd "$TMPREPO"
git init -q
git config user.email "test@example.com"
git config user.name "test"
git commit --allow-empty -q -m init

# Patterns to test. Sample values are runtime-assembled to avoid tripping
# upstream secret scanners (GitHub, gitleaks, etc.) on this test file itself.
P_LIVE="sk_""live_""abcdefghijklmnopqrstuvwxyz1234"
P_TEST="sk_""test_""abcdefghijklmnopqrstuvwxyz1234"
P_AKIA="AKIA""IOSFODNN7""EXAMPLE"
P_GHP="ghp_""abcdefghijklmnopqrstuvwxyzABCDEF1234"
P_GHO="gho_""abcdefghijklmnopqrstuvwxyzABCDEF1234"
P_GHS="ghs_""abcdefghijklmnopqrstuvwxyzABCDEF1234"
P_XOXB="xoxb""-12345-67890-abcdefghij"
P_XOXA="xoxa""-12345-67890-abcdefghij"
P_XOXP="xoxp""-12345-67890-abcdefghij"
P_JWT="eyJhbGciOiJIUzI1NiJ9.""eyJzdWIiOiIxMjM0NSJ9.""SflKxwRJSMeKKF2QT4f"
P_ANTHROPIC="ANTHROPIC_API_KEY=""sk-ant-""abc123"
P_OPENAI="OPENAI_API_KEY=""sk-""proj-abc123"
_PW_VAL="super""secret""123"
P_PASS="password = \"${_PW_VAL}\""

SECRETS=(
  "stripe-live:$P_LIVE"
  "stripe-test:$P_TEST"
  "aws-akia:$P_AKIA"
  "github-ghp:$P_GHP"
  "github-gho:$P_GHO"
  "github-ghs:$P_GHS"
  "slack-xoxb:$P_XOXB"
  "slack-xoxa:$P_XOXA"
  "slack-xoxp:$P_XOXP"
  "jwt:$P_JWT"
  "anthropic-key:$P_ANTHROPIC"
  "openai-key:$P_OPENAI"
  "password:$P_PASS"
)

for entry in "${SECRETS[@]}"; do
  label="${entry%%:*}"
  payload="${entry#*:}"
  echo "$payload" > "secret-$label.txt"
  git add "secret-$label.txt"
  out=$(TOOL_INPUT='{"command":"git commit -m fix"}' bash "$BIN/ops-prevent-secret-commit" 2>&1)
  assert_deny "$out" "secret pattern blocked: $label"
  git reset -q HEAD "secret-$label.txt" >/dev/null 2>&1
  rm -f "secret-$label.txt"
done

# Clean diff → allow.
echo "just some clean code" > clean.txt
git add clean.txt
out=$(TOOL_INPUT='{"command":"git commit -m clean"}' bash "$BIN/ops-prevent-secret-commit" 2>&1)
assert_allow "$out" "clean diff allowed"
git reset -q HEAD clean.txt >/dev/null 2>&1

# Opt-out.
echo "sk_""live_""aaaaaaaaaaaaaaaaaaaaaaaaaa" > optout.txt
git add optout.txt
out=$(CLAUDE_PLUGIN_OPTION_PREVENT_SECRET_COMMIT=false TOOL_INPUT='{"command":"git commit -m x"}' bash "$BIN/ops-prevent-secret-commit" 2>&1)
assert_allow "$out" "opt-out (env=false) bypasses hook"
git reset -q HEAD optout.txt >/dev/null 2>&1


# Removal of secret → deny (full diff is scanned, not just added lines).
# v2.0.1: the hook intentionally scans the complete diff to guard against
# patterns that slip through on context / removal lines.
TMPREPO2=$(mktemp -d)
cd "$TMPREPO2"
git init -q
git config user.email "test@example.com"
git config user.name "test"
echo "OPENAI_API_KEY=""sk-""proj-abc123" > leaked.txt
git add leaked.txt
git commit -q -m "oops leaked"
# Now remove the secret and replace with env-var reference.
echo 'OPENAI_API_KEY=$OPENAI_API_KEY' > leaked.txt
git add leaked.txt
out=$(TOOL_INPUT='{"command":"git commit -m remediate"}' bash "$BIN/ops-prevent-secret-commit" 2>&1)
assert_deny "$out" "removing a secret is denied (full diff scanned)"
cd / && rm -rf "$TMPREPO2"
cd / && rm -rf "$TMPREPO"

############################################
# 2. ops-no-rm-rf-anchor
############################################
echo ""
echo "── ops-no-rm-rf-anchor ──"

DANGEROUS=(
  "rm -rf /"
  "rm -rf /*"
  "rm -rf ~"
  "rm -rf ~/*"
  "rm -rf \$HOME"
  "rm -rf \"\$HOME\""
  "rm -rf .."
  "rm -rf ../*"
  "rm -rf ."
  "rm -fr /"
  "rm -Rf ~"
  "rm --recursive --force /"
)
for cmd in "${DANGEROUS[@]}"; do
  payload=$(printf '{"command":"%s"}' "$(echo "$cmd" | sed 's/"/\\"/g')")
  out=$(TOOL_INPUT="$payload" bash "$BIN/ops-no-rm-rf-anchor" 2>&1)
  assert_deny "$out" "dangerous blocked: $cmd"
done

SAFE=(
  "rm -rf ./node_modules"
  "rm -rf /tmp/foo"
  "rm -rf /tmp/build-output"
  "rm -rf dist"
  "rm -rf ./dist/*"
  "rm file.txt"
  "rm -f stale.lock"
  "rm -r somedir"
)
for cmd in "${SAFE[@]}"; do
  payload=$(printf '{"command":"%s"}' "$cmd")
  out=$(TOOL_INPUT="$payload" bash "$BIN/ops-no-rm-rf-anchor" 2>&1)
  assert_allow "$out" "safe allowed: $cmd"
done

# Opt-out.
out=$(CLAUDE_PLUGIN_OPTION_NO_RM_RF_ANCHOR=false TOOL_INPUT='{"command":"rm -rf /"}' bash "$BIN/ops-no-rm-rf-anchor" 2>&1)
assert_allow "$out" "opt-out (env=false) bypasses hook"


# Multi-target: safe first, dangerous second → allowed (v2.0.1+).
# The anchor check now inspects only the FIRST non-flag target to avoid
# false-positives on commands like `rm -rf dist /tmp/stale-cache`.
MULTI_SAFE_FIRST=(
  "rm -rf /tmp/build /"
  "rm -rf dist ~"
  "rm -rf ./node_modules .."
)
for cmd in "${MULTI_SAFE_FIRST[@]}"; do
  payload=$(printf '{"command":"%s"}' "$(echo "$cmd" | sed 's/"/\\"/g')")
  out=$(TOOL_INPUT="$payload" bash "$BIN/ops-no-rm-rf-anchor" 2>&1)
  assert_allow "$out" "multi-target safe-first allowed: $cmd"
done
############################################
# 3. ops-warn-mainpush
############################################
echo ""
echo "── ops-warn-mainpush ──"

TMPREPO=$(mktemp -d)
cd "$TMPREPO"
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"
git commit --allow-empty -q -m init

# On main → bare push asks.
out=$(TOOL_INPUT='{"command":"git push"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "bare push from main → ask"
out=$(TOOL_INPUT='{"command":"git push origin"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "git push origin from main → ask"
out=$(TOOL_INPUT='{"command":"git push -u origin main"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "explicit push origin main → ask"
out=$(TOOL_INPUT='{"command":"git push origin master"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "explicit push origin master → ask"
out=$(TOOL_INPUT='{"command":"git push origin production"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "explicit push origin production → ask"
out=$(TOOL_INPUT='{"command":"git push origin HEAD:main"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_ask "$out" "refspec HEAD:main → ask"

# Switch to feature branch → bare push allowed.
git checkout -q -b feature/safe-thing
out=$(TOOL_INPUT='{"command":"git push"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_allow "$out" "bare push from feature branch → allow"
out=$(TOOL_INPUT='{"command":"git push -u origin feature/safe-thing"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_allow "$out" "explicit feature push → allow"

# Opt-out.
git checkout -q main
out=$(CLAUDE_PLUGIN_OPTION_WARN_MAINPUSH=false TOOL_INPUT='{"command":"git push origin main"}' bash "$BIN/ops-warn-mainpush" 2>&1)
assert_allow "$out" "opt-out (env=false) bypasses hook"

cd / && rm -rf "$TMPREPO"

############################################
echo ""
echo "── Summary ──"
echo "  Passed: $pass"
echo "  Failed: $fail"
[[ $fail -eq 0 ]]
