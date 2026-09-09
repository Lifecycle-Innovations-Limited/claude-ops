#!/usr/bin/env bash
# test-pre-commit-hook-blocks.sh — negative control for the pre-commit hook.
#
# WHY THIS FILE EXISTS
#
# On 2026-09-09 the hook printed three BLOCKED lines and then committed anyway.
# The cause was an amnesty applied to $FAILED *after* every check had run: if
# the only email hits were example domains it reset the flag to 0, wiping every
# other check that had already failed. So the hook was loud and inert at the
# same time — the worst shape a gate can have, because the output looks like
# enforcement.
#
# `test-pii-gate-fires.sh` proves the scanner refuses the leaked shapes. It says
# nothing about the hook, which is a separate program with its own copy of the
# patterns and its own exit path. This suite asserts the hook's exit status,
# through a real `git commit`, because the exit status is the only part of a
# hook that actually stops anything.
#
# Case 6 is the regression itself: a forbidden identifier in the same commit as
# a harmless example address must still be refused.

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd -P)"
HOOK="$REPO_ROOT/.githooks/pre-commit"
SCANNER="$PLUGIN_ROOT/tests/test-no-secrets.sh"
CONSTANTS="$PLUGIN_ROOT/tests/known-public-constants.txt"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
err() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

echo "=== pre-commit hook negative control ==="

for f in "$HOOK" "$SCANNER" "$CONSTANTS"; do
  if [[ ! -f "$f" ]]; then
    err "hook and scanner present" "missing $f"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
  fi
done

WORK="$(mktemp -d -t ops-hook-gate.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# A throwaway repo whose layout matches this one: git root is the PARENT of
# claude-ops/, and the hook is installed where git will actually run it.
setup_repo() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo/claude-ops/tests" "$WORK/repo/claude-ops/scripts"
  cp "$SCANNER"   "$WORK/repo/claude-ops/tests/test-no-secrets.sh"
  cp "$CONSTANTS" "$WORK/repo/claude-ops/tests/known-public-constants.txt"
  git -C "$WORK/repo" init -q
  git -C "$WORK/repo" config user.email author@example.com
  git -C "$WORK/repo" config user.name author
  mkdir -p "$WORK/repo/.git/hooks"
  cp "$HOOK" "$WORK/repo/.git/hooks/pre-commit"
  chmod +x "$WORK/repo/.git/hooks/pre-commit"
  # HOME is redirected so the operator's own denylist cannot decide the outcome.
  mkdir -p "$WORK/fakehome"
}

# Attempt a real commit. Prints hook output; returns git's exit status.
try_commit() {
  git -C "$WORK/repo" add -A >/dev/null 2>&1
  HOME="$WORK/fakehome" git -C "$WORK/repo" commit -q -m "test" 2>&1
}

# assert_blocked <label> <expected substring of a BLOCKED line>
assert_blocked() {
  local label="$1" expect="$2" out rc
  out="$(try_commit)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    err "$label" "the commit SUCCEEDED — the hook printed at most a warning: $(echo "$out" | grep -i BLOCKED | tr '\n' ' ')"
  elif echo "$out" | grep -qF "$expect"; then
    ok "$label"
  else
    err "$label" "blocked, but not on the expected check ($expect); got: $(echo "$out" | head -3 | tr '\n' ' ')"
  fi
}

# assert_allowed <label>
assert_allowed() {
  local label="$1" out rc
  out="$(try_commit)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    ok "$label"
  else
    err "$label" "$(echo "$out" | grep -iE 'BLOCKED|FAIL' | head -2 | tr '\n' ' ')"
  fi
}

# --- 1. Control: a clean commit must go through -------------------------------
# Without this, a hook that refused everything would satisfy every case below.
setup_repo
printf 'ok\n' > "$WORK/repo/claude-ops/scripts/clean.sh"
assert_allowed "control: a clean commit is allowed"

# --- 2. An undocumented UUID must block --------------------------------------
setup_repo
echo 'const TEAM_ID = "8ad42c61-0b93-4f77-a1e6-2c9d40fb1e55";' \
  > "$WORK/repo/claude-ops/scripts/leak.js"
assert_blocked "a UUID in a staged line blocks the commit" "undocumented UUID literal"

# --- 3. A third party's issue key must block ---------------------------------
setup_repo
printf 'See ACME-1141 for the plan.\n' > "$WORK/repo/claude-ops/scripts/notes.md"
assert_blocked "an issue-tracker key blocks the commit" "third-party issue-tracker key"

# --- 4. A real work email must block -----------------------------------------
setup_repo
printf 'contact: owner@somecompany.com\n' > "$WORK/repo/claude-ops/scripts/notes.md"
assert_blocked "a non-example work email blocks the commit" "Non-example work emails"

# --- 5. An example address alone must NOT block ------------------------------
# The amnesty had a legitimate purpose. Filtering it at the check preserves that
# purpose; what it must not do is reach across to the other checks.
setup_repo
printf 'contact: user@example.com\n' > "$WORK/repo/claude-ops/scripts/notes.md"
assert_allowed "an @example.com address alone is allowed"

# --- 6. THE REGRESSION: a forbidden id beside an example address -------------
# This is the exact commit that got through. The example address satisfied the
# post-hoc amnesty, which cleared the UUID and issue-key failures with it.
setup_repo
{
  printf 'contact: user@example.com\n'
  printf 'workspace: c41d9e70-52a8-4b6f-8e13-77af09c2d5b1\n'
} > "$WORK/repo/claude-ops/scripts/notes.md"
assert_blocked "a UUID beside an example address still blocks" "undocumented UUID literal"

# --- 7. The exempt files may quote the shapes they forbid --------------------
# The negative-control suite must contain forbidden values by construction. If
# the hook refused it, the only way to keep the tests would be --no-verify,
# which trains everyone to skip the hook.
setup_repo
{
  echo '#!/usr/bin/env bash'
  echo '# planted by the negative control:'
  echo 'echo "c41d9e70-52a8-4b6f-8e13-77af09c2d5b1 ACME-1141"'
} > "$WORK/repo/claude-ops/tests/test-pii-gate-fires.sh"
assert_allowed "the negative-control suite may hold forbidden shapes"

# --- 8. …and no other test file may -----------------------------------------
# The exemption is four files by exact path, not the tests/ directory. A
# directory-wide exemption would leave the one place a client id could hide.
setup_repo
echo 'const WORKSPACE = "c41d9e70-52a8-4b6f-8e13-77af09c2d5b1";' \
  > "$WORK/repo/claude-ops/tests/fixture.mjs"
assert_blocked "another file under tests/ is still scanned" "undocumented UUID literal"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
