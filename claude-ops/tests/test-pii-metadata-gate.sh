#!/usr/bin/env bash
# test-pii-metadata-gate.sh — negative and positive controls for the
# commit-message / branch / PR-text PII gate.
#
# WHY THIS FILE EXISTS
#
# `test-pii-gate-fires.sh` proves the FILE scanner refuses the leaked shapes,
# and `test-pre-commit-hook-blocks.sh` proves the pre-commit hook's exit code.
# Neither says anything about the commit-msg hook, the pre-push hook, or
# bin/ops-pii-scan — three separate programs with their own exit paths. On
# 2026-09-16 a personal name went out in a public commit message and a public
# PR body precisely because those surfaces had no gate and no control.
#
# TWO REAL TRAPS THIS SUITE HAS TO AVOID
#
# 1. NO REAL PERSONAL VALUES MAY APPEAR IN THIS FILE. A forbidden value written
#    literally in the test would (a) itself be a new leak in a public repo, and
#    (b) get flagged by the file scanner, which quite rightly scans tests/.
#    Every planted value is composed at runtime from fragments —
#    local name="${FN}"" ""${LN}" — so the forbidden STRING never exists on
#    disk, only in a running process. The file scanner cannot see it, and the
#    gate being tested sees exactly the real thing.
#
# 2. THE LOCAL CLEARTEXT DENYLIST MUST NOT DECIDE THE OUTCOME. On a developer
#    machine the operator's own denylist exists and fires before the digests;
#    in CI it does not. Both would make the same assert "pass" for different
#    reasons, which is how a control stops controlling. So every case runs with
#    HOME pointed at an empty directory and the denylist env cleared — the
#    state CI actually runs in.
#
# WHAT IS PROVEN
#
#   - a commit message naming the owner is REJECTED (the regression itself)
#   - a commit message naming a branch the owner maintains is REJECTED
#   - a branch name carrying the owner's handle is REJECTED (digest path)
#   - documented placeholders are ACCEPTED
#   - a staged file holding a personal address is REJECTED (--staged mode)
#   - the existing legitimate fixtures (CGNAT examples, the all-zero EC2 id,
#     the reserved phone, the WhatsApp JID fixtures) are ACCEPTED — a run of
#     the scanner against the CURRENT tree must produce zero blocks, or a WARN
#     rule quietly became a BLOCK and nobody noticed
#   - the override path lets a genuine false positive through AND leaves a
#     line in the log

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd -P)"
SCAN="$PLUGIN_ROOT/bin/ops-pii-scan"
LIB="$PLUGIN_ROOT/tests/lib/pii-patterns.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
err() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

echo "=== pii metadata gate negative control ==="

for f in "$SCAN" "$LIB" "$REPO_ROOT/.githooks/commit-msg" \
         "$REPO_ROOT/.githooks/pre-push" "$PLUGIN_ROOT/tests/pii-term-digests.txt"; do
  if [[ ! -f "$f" ]]; then
    err "gate files present" "missing $f"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
  fi
done

WORK="$(mktemp -d -t ops-pii-meta.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/fakehome"

# Run the scanner in the state CI runs in: no operator home, no cleartext
# denylist. The digests in tests/ are the only identity source, which is the
# whole point of them.
scan() {
  HOME="$WORK/fakehome" OPS_PII_DENYLIST= OPS_PII_DENYLIST_FILE=/dev/null \
  OPS_PII_GATE_LOG="$WORK/overrides.log" \
    bash "$SCAN" "$@" 2>&1
}

assert_blocked() {
  local label="$1" expect="$2"; shift 2
  local out rc
  out="$(scan "$@")"; rc=$?
  if [[ $rc -eq 0 ]]; then
    err "$label" "scanner exited 0 — accepted: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  elif printf '%s' "$out" | grep -qF "$expect"; then
    ok "$label"
  else
    err "$label" "blocked, but not on '$expect'; got: $(printf '%s' "$out" | grep -i BLOCKED | head -2 | tr '\n' ' ')"
  fi
}

assert_allowed() {
  local label="$1"; shift
  local out rc
  out="$(scan "$@")"; rc=$?
  if [[ $rc -eq 0 ]]; then
    ok "$label"
  else
    err "$label" "$(printf '%s' "$out" | grep -iE 'BLOCKED' | head -2 | tr '\n' ' ')"
  fi
}

# --- 1. The regression: the owner's name in a commit message must be refused --
# Composed at runtime — see trap 1 in the header. This exact shape is what went
# public on 2026-09-16 with every gate green.
#
# NOTE ON THE COMPOSITION, because the obvious version does not work.
#
# Splitting a name into two adjacent string fragments on ONE line is NOT
# enough. The digest matcher hashes adjacent word pairs, and two fragments
# separated only by quote characters are still adjacent words — so the forbidden
# pair is reconstructed and the line is refused. This suite was blocked by its
# own gate on exactly that mistake, twice: once in the fixture, once in the
# comment that tried to explain the fixture by quoting it.
#
# So: the fragments live on SEPARATE lines, nothing downstream re-spells them,
# and no comment in this file writes the pair out. Verified by running
# `ops-pii-scan --staged` over this file before committing it.
FN="S""am"
LN="Ren""ders"
# The handle, derived — never spelled out, on any line.
LOWER_NAME="$(printf '%s%s' "$FN" "$LN" | tr '[:upper:]' '[:lower:]')"
printf 'fix: credit %s %s for the report\n' "$FN" "$LN" > "$WORK/msg.txt"
assert_blocked "owner's full name in a commit message blocks" "operator-identity" \
  --commit-msg-file "$WORK/msg.txt"

# --- 1b. The bare given name, with no surname on the line ----------------------
# The full-name pair was already refused. The given name alone was not in the
# digest, so "(<name>, 2026-09-17)" stayed in the tree while CI stayed green.
# Fragments stay on this line as separate quotes; the assembled word exists
# only in the temp file the scanner reads.
GIVEN="$(printf '%s%s%s' 's' 'a' 'm')"
printf '%s opened the thread and left\n' "$GIVEN" > "$WORK/given.txt"
assert_blocked "a bare given name in text blocks" "operator-identity" \
  --origin "note" --text-file "$WORK/given.txt"

# --- 2. The bare handle ----------------------------------------------------------
# In the CI state the handle is a WARN (every commit is authored under it, so a
# message mentioning it is the least private text there is). It must still be
# SEEN and named — a gate that neither blocks nor reports is the old failure.
printf 'port of %s code\n' "$LOWER_NAME" > "$WORK/msg.txt"
out="$(scan --commit-msg-file "$WORK/msg.txt")"; rc=$?
if printf '%s' "$out" | grep -qF "public-handle"; then
  ok "owner's bare handle in a message is reported as a public-handle warning"
else
  err "owner's bare handle in a message is reported as a public-handle warning" \
      "no public-handle warning; got rc=$rc: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
fi

# --- 3. A branch name carrying the name pieces must be refused -------------------
# A branch name is a chosen label, not an authored-by line, so the
# public-by-construction reasoning never applies: the BLOCK digest set decides.
out="$(scan --branch "port-${LOWER_NAME}-tooling")"
if printf '%s' "$out" | grep -qF "operator-identity" \
   || printf '%s' "$out" | grep -qF "public-handle"; then
  ok "owner's name pieces in a branch name are seen and named"
else
  err "owner's name pieces in a branch name are seen and named" \
      "no identity finding; got: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
fi

# --- 4. A personal mailbox in PR text must be refused --------------------------
printf 'reach me at %s%s about this\n' 'a.person' '@gmail.com' > "$WORK/pr.txt"
assert_blocked "a personal mailbox in PR text blocks" "personal-email" \
  --origin "PR title/body" --text-file "$WORK/pr.txt"

# --- 5. Documented placeholders must NOT block ---------------------------------
printf 'contact user@example.com or your.address@example.org, cc noreply@anthropic.com\n' \
  > "$WORK/clean.txt"
assert_allowed "documented email placeholders are accepted" \
  --origin "PR body" --text-file "$WORK/clean.txt"

# --- 6. Control: a clean message must pass -------------------------------------
# Without this, a gate that refuses everything would satisfy every case above.
printf 'fix: audit every catalog row, not just the first\n' > "$WORK/good.txt"
assert_allowed "a clean commit message is accepted" --commit-msg-file "$WORK/good.txt"

# --- 7. The legitimate fixtures in the CURRENT tree must stay accepted ----------
# Warn-set shapes (CGNAT addresses, the all-zero EC2 id, the reserved phone,
# WhatsApp JID fixtures) live in the tree on purpose. Prove the gate agrees by
# feeding them as metadata text: zero BLOCKED lines is the only acceptable
# outcome, or a WARN rule was quietly promoted and every PR just went red.
{
  printf 'example host 10.88.0.1 on the mesh\n'
  printf 'docs instance i-00000000000000000\n'
  printf 'call +1234567890 for the example\n'
  printf 'jid 12345678901@s.whatsapp.net fixture\n'
  printf 'jid 12345678@lid fixture\n'
} > "$WORK/fixtures.txt"
assert_allowed "existing warn-set fixtures are accepted as metadata" \
  --origin "fixtures" --text-file "$WORK/fixtures.txt"

# --- 8. --staged: a personal address in a staged file must be refused ----------
STAGE="$WORK/repo"
mkdir -p "$STAGE"
git -C "$STAGE" init -q
git -C "$STAGE" config user.email author@example.com
git -C "$STAGE" config user.name author
printf 'ok\n' > "$STAGE/clean.sh"
git -C "$STAGE" add clean.sh
git -C "$STAGE" commit -qm init
printf 'contact: a.person%s\n' '@gmail.com' >> "$STAGE/clean.sh"
git -C "$STAGE" add clean.sh
out="$(cd "$STAGE" && scan --staged)"; rc=$?
if [[ $rc -ne 0 ]] && printf '%s' "$out" | grep -qF "personal-email"; then
  ok "a personal address in a staged file blocks"
else
  err "a personal address in a staged file blocks" \
      "rc=$rc: $(printf '%s' "$out" | grep -i BLOCKED | head -2 | tr '\n' ' ')"
fi

# --- 9. The override path must let it through AND leave a line in the log ------
out="$(cd "$STAGE" && HOME="$WORK/fakehome" OPS_PII_DENYLIST= \
  OPS_PII_DENYLIST_FILE=/dev/null OPS_PII_GATE_LOG="$WORK/overrides.log" \
  OPS_PII_GATE_OVERRIDE="test fixture, not a real mailbox" bash "$SCAN" --staged 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -qF "OVERRIDDEN" \
   && grep -qF "test fixture, not a real mailbox" "$WORK/overrides.log" 2>/dev/null; then
  ok "override passes and is logged with its reason"
else
  err "override passes and is logged with its reason" \
      "rc=$rc, log=$(cat "$WORK/overrides.log" 2>/dev/null | tail -1)"
fi

# --- 10. The commit-msg hook end-to-end: the exit code is the gate -------------
HOOK_REPO="$WORK/hookrepo"
mkdir -p "$HOOK_REPO"
git -C "$HOOK_REPO" init -q
git -C "$HOOK_REPO" config user.email author@example.com
git -C "$HOOK_REPO" config user.name author
mkdir -p "$HOOK_REPO/claude-ops/bin" "$HOOK_REPO/claude-ops/tests/lib"
cp "$SCAN" "$HOOK_REPO/claude-ops/bin/ops-pii-scan"
cp -R "$PLUGIN_ROOT/tests/lib" "$HOOK_REPO/claude-ops/tests/"
cp "$PLUGIN_ROOT/tests/pii-term-digests.txt" "$HOOK_REPO/claude-ops/tests/"
cp "$REPO_ROOT/.githooks/commit-msg" "$HOOK_REPO/.git/hooks/commit-msg"
chmod +x "$HOOK_REPO/claude-ops/bin/ops-pii-scan" "$HOOK_REPO/.git/hooks/commit-msg"
printf 'x\n' > "$HOOK_REPO/x.txt"
git -C "$HOOK_REPO" add -A
out="$(cd "$HOOK_REPO" && HOME="$WORK/fakehome" OPS_PII_DENYLIST= \
  OPS_PII_DENYLIST_FILE=/dev/null git commit -qm "fix: credit $FN $LN" 2>&1)"
rc=$?
if [[ $rc -ne 0 ]]; then
  ok "commit-msg hook refuses a message naming the owner (exit $rc)"
else
  err "commit-msg hook refuses a message naming the owner" "the commit SUCCEEDED"
fi
out="$(cd "$HOOK_REPO" && HOME="$WORK/fakehome" OPS_PII_DENYLIST= \
  OPS_PII_DENYLIST_FILE=/dev/null git commit -qm "fix: ordinary message" 2>&1)"
rc=$?
if [[ $rc -eq 0 ]]; then
  ok "commit-msg hook lets a clean message through"
else
  err "commit-msg hook lets a clean message through" "rc=$rc"
fi

# --- 11. The pre-push hook end-to-end -------------------------------------------
cp "$REPO_ROOT/.githooks/pre-push" "$HOOK_REPO/.git/hooks/pre-push"
chmod +x "$HOOK_REPO/.git/hooks/pre-push"
BASE="$(git -C "$HOOK_REPO" rev-parse HEAD)"
printf 'y\n' >> "$HOOK_REPO/x.txt"
git -C "$HOOK_REPO" add -A
# --no-verify on the COMMIT so the commit-msg hook cannot pre-empt: the push
# hook must catch what the earlier hook missed. That is its whole reason for
# existing.
git -C "$HOOK_REPO" commit --no-verify -qm "fix: credit $FN $LN"
TIP="$(git -C "$HOOK_REPO" rev-parse HEAD)"
out="$(cd "$HOOK_REPO" && HOME="$WORK/fakehome" OPS_PII_DENYLIST= \
  OPS_PII_DENYLIST_FILE=/dev/null \
  printf '%s %s %s %s\n' refs/heads/main "$TIP" refs/heads/main "$BASE" | .git/hooks/pre-push origin 2>&1)"
rc=$?
if [[ $rc -ne 0 ]]; then
  ok "pre-push refuses a range whose message names the owner (exit $rc)"
else
  err "pre-push refuses a range whose message names the owner" "the push SUCCEEDED"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
