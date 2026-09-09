#!/usr/bin/env bash
# test-pii-gate-fires.sh — negative control for the third-party identifier gate.
#
# WHY THIS FILE EXISTS
#
# `test-no-secrets.sh` reports PASS on a clean tree. That tells you nothing: a
# check whose pattern never matches anything also reports PASS, forever, and a
# gate nobody has ever seen fail is not a gate. This suite is the other half —
# it plants the exact values that leaked into this public repo and asserts the
# scanner refuses them.
#
# The values below are the real shapes of the incident, with the client's
# identifiers replaced: ten workspace UUIDs, an issue-tracker key in prose and
# in a filename, and the operator's own IANA timezone in a cron comment. Each
# one sat in a public repository while the scanner said PASS, because every
# identity check was denylist-driven and a denylist can only ever hold the
# operator's OWN terms — never a third party's.
#
# Method: build a throwaway git repo, copy the scanner and its allowlist in,
# plant one poisoned file, and assert the scanner exits non-zero naming the
# right check. A control run with no poison must exit zero, so a scanner that
# fails on everything cannot pass this suite either.

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCANNER="$PLUGIN_ROOT/tests/test-no-secrets.sh"
CONSTANTS="$PLUGIN_ROOT/tests/known-public-constants.txt"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
err() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

echo "=== PII gate negative control ==="

for f in "$SCANNER" "$CONSTANTS"; do
  if [[ ! -f "$f" ]]; then
    err "scanner present" "missing $f"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
  fi
done

WORK="$(mktemp -d -t ops-pii-gate.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Build a minimal repo whose layout matches this plugin: the git root is the
# PARENT of claude-ops/, exactly as in the real checkout, so the scanner's
# `git ls-files` path filter behaves the way it does in production.
setup_repo() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo/claude-ops/tests" "$WORK/repo/claude-ops/scripts"
  cp "$SCANNER" "$WORK/repo/claude-ops/tests/test-no-secrets.sh"
  cp "$CONSTANTS" "$WORK/repo/claude-ops/tests/known-public-constants.txt"
  git -C "$WORK/repo" init -q
  git -C "$WORK/repo" config user.email test@example.com
  git -C "$WORK/repo" config user.name test
}

# Run the scanner inside the throwaway repo. Prints its output; returns its
# exit status. HOME is redirected so the operator's own denylist, which lives
# in $HOME/.config, cannot influence the result either way.
run_scanner() {
  git -C "$WORK/repo" add -A >/dev/null 2>&1
  HOME="$WORK/fakehome" bash "$WORK/repo/claude-ops/tests/test-no-secrets.sh" 2>&1
}

# --- Control: a clean tree must pass -----------------------------------------
# Without this, a scanner that failed on every input would satisfy every case
# below and prove nothing.
setup_repo
printf 'ok\n' > "$WORK/repo/claude-ops/scripts/clean.sh"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "control: clean tree passes"
else
  err "control: clean tree passes" \
    "scanner failed on a tree with nothing to find; every case below is meaningless: $(echo "$out" | grep -E '^  FAIL' | head -3)"
fi

# assert_fires <label> <expected substring in a FAIL line>
# The poisoned file must already be written into $WORK/repo before calling.
assert_fires() {
  local label="$1" expect="$2" out rc
  out="$(run_scanner)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    err "$label" "scanner exited 0 — the gate did not fire"
  elif echo "$out" | grep -E '^  FAIL' | grep -qF "$expect"; then
    ok "$label"
  else
    err "$label" \
      "scanner failed, but not on the expected check ($expect); got: $(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
  fi
}

# --- 1. A third party's workspace UUIDs --------------------------------------
# The shape that leaked: a block of client workspace ids pasted into a script.
# No denylist could ever have held these — nobody knows another organisation's
# UUIDs in advance. That is the whole reason the rule is inverted.
setup_repo
{
  echo '#!/usr/bin/env bash'
  echo 'CLIENT_TEAMS=('
  for n in 1 2 3 4 5 6 7 8 9 a; do
    echo "  \"3f2b81${n}c-77d4-4e19-9c2a-5be1077${n}f4a2\""
  done
  echo ')'
} > "$WORK/repo/claude-ops/scripts/leak.sh"
assert_fires "a client's workspace UUIDs fail the build" "undocumented UUID literal"

# --- 2. A single UUID is enough ----------------------------------------------
# Ten is not the threshold. One is.
setup_repo
echo 'const TEAM_ID = "8ad42c61-0b93-4f77-a1e6-2c9d40fb1e55";' \
  > "$WORK/repo/claude-ops/scripts/single.js"
assert_fires "one undocumented UUID is enough to fail" "undocumented UUID literal"

# --- 3. A UUID cannot be smuggled in through tests/ --------------------------
# EXCLUDE_DIRS drops tests/ for the older checks. If the structural checks
# inherited that, the scanner's own directory would be the one place a client
# id could sit unseen.
setup_repo
echo 'const WORKSPACE = "c41d9e70-52a8-4b6f-8e13-77af09c2d5b1";' \
  > "$WORK/repo/claude-ops/tests/fixture.mjs"
assert_fires "a UUID under tests/ still fails" "undocumented UUID literal"

# --- 4. A third party's issue-tracker key ------------------------------------
setup_repo
printf 'See ACME-1141 for the rollout plan.\n' \
  > "$WORK/repo/claude-ops/scripts/notes.md"
assert_fires "a client's issue key fails the build" "issue-tracker key"

# --- 5. An allowlisted prefix must not shelter a longer one ------------------
# TEAM is the documented placeholder. `HEATEAM-1` contains it as a substring;
# an unanchored filter would let a real key ride in on the back of a fake one.
setup_repo
printf 'Tracked as HEATEAM-1141.\n' \
  > "$WORK/repo/claude-ops/scripts/notes.md"
assert_fires "an allowlisted prefix does not shelter a longer key" "issue-tracker key"

# --- 6. The neutral placeholder must still pass ------------------------------
# A gate that refuses the documented replacement leaves the author no legal
# move, and an author with no legal move edits the gate.
setup_repo
printf 'See TEAM-1141; the real key comes from $LINEAR_CLIENT_TEAM_KEY.\n' \
  > "$WORK/repo/claude-ops/scripts/notes.md"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "the documented placeholder TEAM-<n> still passes"
else
  err "the documented placeholder TEAM-<n> still passes" \
    "$(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
fi

# --- 7. The operator's own timezone in code ----------------------------------
# This is the one the manual scrub missed three times: a cron comment that
# states where the operator lives.
setup_repo
printf '#!/usr/bin/env bash\n# Weekly Monday 10:00 Europe/Amsterdam\n' \
  > "$WORK/repo/claude-ops/scripts/cron.sh"
assert_fires "a hardcoded IANA timezone in code fails" "hardcoded IANA timezone"

# --- 8. A zone read from the environment must pass ---------------------------
setup_repo
printf '#!/usr/bin/env bash\nTZ="${OPS_TZ:-Europe/Amsterdam}"\n' \
  > "$WORK/repo/claude-ops/scripts/cron.sh"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "a zone defaulted from \$OPS_TZ still passes"
else
  err "a zone defaulted from \$OPS_TZ still passes" \
    "$(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
fi

# --- 9. Prose may name a zone as an example ----------------------------------
# The setup guide lists several zones. Refusing those would make the gate
# unusable and teach people to route around it.
setup_repo
printf 'Set OPS_TZ to your own zone, for example Europe/Amsterdam or Asia/Tokyo.\n' \
  > "$WORK/repo/claude-ops/scripts/README.md"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "prose may name a timezone as an example"
else
  err "prose may name a timezone as an example" \
    "$(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
fi

# --- 10. The documented vendor constants must not fail -----------------------
# Every entry in the allowlist has to actually work, or the file is decorative.
setup_repo
{
  echo '#!/usr/bin/env bash'
  grep -E '^uuid:' "$CONSTANTS" | sed 's/^uuid:/VALUE="/;s/$/"/'
} > "$WORK/repo/claude-ops/scripts/vendor.sh"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "every allowlisted vendor UUID passes"
else
  err "every allowlisted vendor UUID passes" \
    "an entry in known-public-constants.txt does not take effect: $(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
fi

# --- 11. A test fixture UUID must not be refused -----------------------------
# All-zero leading groups cannot come from a generator, so they are placeholders
# by construction. Refusing them would push authors to allowlist per-test values,
# which is how an allowlist turns into a dumping ground.
setup_repo
echo 'const id = "00000000-0000-4000-8000-000000000001";' \
  > "$WORK/repo/claude-ops/scripts/fixture.mjs"
out="$(run_scanner)"; rc=$?
if [[ $rc -eq 0 ]]; then
  ok "a nil-prefixed fixture UUID is accepted"
else
  err "a nil-prefixed fixture UUID is accepted" \
    "$(echo "$out" | grep -E '^  FAIL' | head -2 | tr '\n' ' ')"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
