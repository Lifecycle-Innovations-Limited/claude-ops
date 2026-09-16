#!/usr/bin/env bash
# test-ops-release-pr-sweep.sh — the pre-release pull-request sweep.
#
# Covers the behaviour the sweep exists for:
#   - a fork PR whose workflow runs sit at action_required gets them approved
#     (the defect that stalled two good external PRs behind checks that never ran)
#   - a good, green PR is merged
#   - a red PR is left open and reported
#   - a good draft is undrafted and then merged
#   - skipped / neutral / cancelled are NOT failures
#   - a PR the agent did not bless is left open
#   - a thin REST budget aborts the sweep instead of half-running it
#   - --no-sweep skips the whole stage
#
# `gh` is the repo's own mock, driven by fixture files in MOCK_GH_SWEEP_DIR.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="$PLUGIN_ROOT/bin/ops-release"
LIB="$PLUGIN_ROOT/scripts/lib/release-pr-sweep.sh"
MOCKS="$PLUGIN_ROOT/tests/mocks"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: ops-release pre-release PR sweep"
echo ""

# ---- static checks -----------------------------------------------------------

[ -f "$LIB" ] && ok "scripts/lib/release-pr-sweep.sh exists" \
             || { err "scripts/lib/release-pr-sweep.sh missing"; echo "Results: $pass passed, $fail failed"; exit 1; }

bash -n "$LIB"     && ok "the sweep library parses"      || err "the sweep library has a syntax error"
bash -n "$RELEASE" && ok "bin/ops-release still parses"  || err "bin/ops-release has a syntax error"

grep -q -- '--no-sweep)'   "$RELEASE" && ok "ops-release accepts --no-sweep"   || err "--no-sweep is not parsed"
grep -q -- '--sweep-only)' "$RELEASE" && ok "ops-release accepts --sweep-only" || err "--sweep-only is not parsed"

# The sweep has to land PRs BEFORE the bump, or the changelog and tag miss them.
sweep_line="$(grep -n 'release_pr_sweep "\$GH_REPO"' "$RELEASE" | head -1 | cut -d: -f1)"
bump_line="$(grep -n '^# ----- version base -----' "$RELEASE" | head -1 | cut -d: -f1)"
if [ -n "$sweep_line" ] && [ -n "$bump_line" ] && [ "$sweep_line" -lt "$bump_line" ]; then
  ok "the sweep runs before the version bump"
else
  err "the sweep does not run before the version bump"
fi

# The repo is public and there is a pii-gate CI job. The pattern is assembled at
# runtime so this check cannot match its own source line.
home_pat="/U""sers/|/ho""me/[a-z]"
if grep -qE "$home_pat" "$LIB"; then
  err "a home-directory path leaked into the sweep sources"
else
  ok "no home-directory paths in the sweep sources"
fi

# Never poll GitHub over GraphQL, and never merge past the protections.
# Comment lines are stripped first: the rules are also written down in prose.
CODE="$(grep -vE '^[[:space:]]*#' "$LIB")"
if printf '%s' "$CODE" | grep -qE 'gh pr (checks|view)'; then
  err "the sweep uses GraphQL (gh pr checks / gh pr view)"
else
  ok "the sweep reads GitHub over REST only"
fi
if printf '%s' "$CODE" | grep -q -- '--admin'; then
  err "the sweep can merge with --admin"
else
  ok "the sweep never merges with --admin"
fi

# shellcheck source=../scripts/lib/release-pr-sweep.sh
. "$LIB"

# ---- check verdict -----------------------------------------------------------

SWEEP_REQUIRED_CHECKS_DEFAULT='["build","test"]'

v() { sweep_check_verdict "$1"; }

got="$(v '[{"name":"build","status":"completed","conclusion":"success"},{"name":"test","status":"completed","conclusion":"success"}]')"
[ "$got" = green ] && ok "all successful -> green" || err "all successful gave '$got', wanted green"

got="$(v '[{"name":"build","status":"completed","conclusion":"skipped"},{"name":"test","status":"completed","conclusion":"neutral"}]')"
[ "$got" = green ] && ok "skipped + neutral are not failures" || err "skipped/neutral gave '$got', wanted green"

got="$(v '[{"name":"build","status":"completed","conclusion":"cancelled"},{"name":"test","status":"completed","conclusion":"success"}]')"
[ "$got" = green ] && ok "cancelled is not a failure" || err "cancelled gave '$got', wanted green"

for bad in failure timed_out action_required error; do
  got="$(v "[{\"name\":\"build\",\"status\":\"completed\",\"conclusion\":\"$bad\"},{\"name\":\"test\",\"status\":\"completed\",\"conclusion\":\"success\"}]")"
  [ "$got" = failed ] && ok "$bad is a failure" || err "$bad gave '$got', wanted failed"
done

got="$(v '[{"name":"build","status":"completed","conclusion":"success"}]')"
[ "$got" = pending ] && ok "a missing required check is pending, not green" || err "missing required gave '$got', wanted pending"

got="$(v '[{"name":"build","status":"in_progress","conclusion":""},{"name":"test","status":"completed","conclusion":"success"}]')"
[ "$got" = pending ] && ok "an unfinished check is pending" || err "in_progress gave '$got', wanted pending"

# ---- agent verdict -----------------------------------------------------------

tmp_out="$(mktemp)"
printf 'looks fine\nSWEEP_VERDICT: GOOD\n' >"$tmp_out"
[ "$(sweep_agent_verdict "$tmp_out")" = GOOD ] && ok "an explicit GOOD reads as GOOD" || err "GOOD was not recognised"
printf 'this is good, merge it\n' >"$tmp_out"
[ "$(sweep_agent_verdict "$tmp_out")" = SKIP ] && ok "prose praise without the verdict line is a SKIP" || err "prose was taken as approval"
: >"$tmp_out"
[ "$(sweep_agent_verdict "$tmp_out")" = SKIP ] && ok "a dead agent (empty transcript) is a SKIP" || err "an empty transcript was taken as approval"
rm -f "$tmp_out"

# ---- end-to-end sweep --------------------------------------------------------

FIX="$(mktemp -d)"
export MOCK_GH_SWEEP_DIR="$FIX"
export PATH="$MOCKS:$PATH"

# A fake review agent: verdict per PR from SWEEP_FAKE_<n>, defaulting to SKIP.
AGENT="$FIX/fake-agent"
cat >"$AGENT" <<'AGENTEOF'
#!/usr/bin/env bash
body="$(cat)"
num="$(printf '%s' "$body" | sed -n 's/.*pull request #\([0-9][0-9]*\).*/\1/p' | head -1)"
eval "verdict=\${SWEEP_FAKE_$num:-SKIP}"
if [ "$verdict" = "GOOD_UNDRAFT" ]; then
  gh pr ready "$num" --repo "$SWEEP_TEST_REPO" >/dev/null 2>&1
  verdict=GOOD
fi
echo "reviewed #$num"
echo "SWEEP_VERDICT: $verdict"
AGENTEOF
chmod +x "$AGENT"
export SWEEP_AGENT_CMD="$AGENT"
export SWEEP_TEST_REPO="octo-org/example"

reset_fixtures() {
  rm -f "$FIX"/*.json "$FIX"/*.log "$FIX"/approved-* "$FIX"/run-*.sha 2>/dev/null || true
  unset SWEEP_FAKE_1 SWEEP_FAKE_2 SWEEP_FAKE_3 SWEEP_FAKE_4 2>/dev/null || true
}

# 1. A fork PR held at action_required: the sweep approves the runs, the checks
#    then report green, and it merges.
reset_fixtures
cat >"$FIX/pulls.json" <<'EOF'
[{"number":1,"title":"external fix","draft":false,
  "head":{"sha":"sha1","label":"contributor:patch","repo":{"full_name":"contributor/example"}},
  "base":{"ref":"main","repo":{"full_name":"octo-org/example"}}}]
EOF
cat >"$FIX/checkruns-sha1.json" <<'EOF'
{"check_runs":[{"name":"build","status":"completed","conclusion":"action_required"}]}
EOF
cat >"$FIX/checkruns-sha1.after.json" <<'EOF'
{"check_runs":[{"name":"build","status":"completed","conclusion":"success"},
               {"name":"test","status":"completed","conclusion":"success"}]}
EOF
cat >"$FIX/runs-sha1.json" <<'EOF'
{"workflow_runs":[{"id":99,"status":"action_required","head_sha":"sha1"}]}
EOF
printf 'sha1' >"$FIX/run-99.sha"
cat >"$FIX/pr-1.json" <<'EOF'
{"number":1,"draft":false,"state":"open","head":{"sha":"sha1"},
 "base":{"ref":"main"},"mergeable":true,"mergeable_state":"clean"}
EOF
export SWEEP_FAKE_1=GOOD; release_pr_sweep "$SWEEP_TEST_REPO" >"$FIX/out1.txt" 2>&1

grep -q 'approve 99' "$FIX/approvals.log" 2>/dev/null \
  && ok "a fork PR's action_required run is approved" \
  || err "the held fork workflow run was never approved"
grep -q 'merge 1 ' "$FIX/merges.log" 2>/dev/null \
  && ok "a good, green PR is merged once its fork CI is unblocked" \
  || err "the good green PR was not merged"

# 2. A red PR is left open and reported; the release proceeds without it.
reset_fixtures
cat >"$FIX/pulls.json" <<'EOF'
[{"number":2,"title":"broken","draft":false,
  "head":{"sha":"sha2","label":"octo-org:broken","repo":{"full_name":"octo-org/example"}},
  "base":{"ref":"main","repo":{"full_name":"octo-org/example"}}}]
EOF
cat >"$FIX/checkruns-sha2.json" <<'EOF'
{"check_runs":[{"name":"build","status":"completed","conclusion":"failure"},
               {"name":"test","status":"completed","conclusion":"success"}]}
EOF
cat >"$FIX/pr-2.json" <<'EOF'
{"number":2,"draft":false,"state":"open","head":{"sha":"sha2"},
 "base":{"ref":"main"},"mergeable":true,"mergeable_state":"unstable"}
EOF
export SWEEP_FAKE_2=GOOD; release_pr_sweep "$SWEEP_TEST_REPO" >"$FIX/out2.txt" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "a red PR does not fail the release" || err "a red PR aborted the release (rc=$rc)"
grep -q 'merge 2 ' "$FIX/merges.log" 2>/dev/null \
  && err "a red PR was merged" \
  || ok "a red PR is left open"
grep -qi '#2 left open' "$FIX/out2.txt" \
  && ok "the red PR is reported" \
  || err "the red PR was skipped silently"

# 3. A good draft is undrafted by the agent, then merged.
reset_fixtures
cat >"$FIX/pulls.json" <<'EOF'
[{"number":3,"title":"draft work","draft":true,
  "head":{"sha":"sha3","label":"octo-org:draft","repo":{"full_name":"octo-org/example"}},
  "base":{"ref":"main","repo":{"full_name":"octo-org/example"}}}]
EOF
cat >"$FIX/checkruns-sha3.json" <<'EOF'
{"check_runs":[{"name":"build","status":"completed","conclusion":"success"},
               {"name":"test","status":"completed","conclusion":"skipped"}]}
EOF
# The re-read after review sees the undrafted PR — the point of re-reading.
cat >"$FIX/pr-3.json" <<'EOF'
{"number":3,"draft":false,"state":"open","head":{"sha":"sha3"},
 "base":{"ref":"main"},"mergeable":true,"mergeable_state":"clean"}
EOF
export SWEEP_FAKE_3=GOOD_UNDRAFT; release_pr_sweep "$SWEEP_TEST_REPO" >"$FIX/out3.txt" 2>&1
grep -q 'ready 3 ' "$FIX/ready.log" 2>/dev/null \
  && ok "a good draft is marked ready for review" \
  || err "the good draft was never undrafted"
grep -q 'merge 3 ' "$FIX/merges.log" 2>/dev/null \
  && ok "an undrafted, green PR is merged" \
  || err "the undrafted green PR was not merged"

# 4. Green, but the agent would not bless it: left open.
reset_fixtures
cat >"$FIX/pulls.json" <<'EOF'
[{"number":4,"title":"risky","draft":false,
  "head":{"sha":"sha4","label":"octo-org:risky","repo":{"full_name":"octo-org/example"}},
  "base":{"ref":"main","repo":{"full_name":"octo-org/example"}}}]
EOF
cat >"$FIX/checkruns-sha4.json" <<'EOF'
{"check_runs":[{"name":"build","status":"completed","conclusion":"success"},
               {"name":"test","status":"completed","conclusion":"success"}]}
EOF
cat >"$FIX/pr-4.json" <<'EOF'
{"number":4,"draft":false,"state":"open","head":{"sha":"sha4"},
 "base":{"ref":"main"},"mergeable":true,"mergeable_state":"clean"}
EOF
export SWEEP_FAKE_4=SKIP; release_pr_sweep "$SWEEP_TEST_REPO" >"$FIX/out4.txt" 2>&1
grep -q 'merge 4 ' "$FIX/merges.log" 2>/dev/null \
  && err "a green PR was merged although the agent did not bless it" \
  || ok "a green PR the agent did not bless is left open"

# 5. A thin REST budget aborts the sweep before it touches anything.
reset_fixtures
cat >"$FIX/pulls.json" <<'EOF'
[{"number":1,"title":"x","draft":false,
  "head":{"sha":"sha1","repo":{"full_name":"octo-org/example"}},
  "base":{"ref":"main","repo":{"full_name":"octo-org/example"}}}]
EOF
MOCK_GH_RATE_CORE=5 release_pr_sweep "$SWEEP_TEST_REPO" >"$FIX/out5.txt" 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "a thin REST budget aborts the sweep" || err "the sweep ran on a thin REST budget"
[ ! -f "$FIX/merges.log" ] && ok "nothing is merged on a thin REST budget" || err "the sweep merged on a thin REST budget"

# 6. --no-sweep skips the whole stage.
BLOCK="$(awk '/^# ----- pre-release PR sweep -----$/{f=1} f{print} /^# ----- version base -----$/{if(f)exit}' "$RELEASE" \
  | sed '$d')"
if [ -z "$BLOCK" ]; then
  err "the sweep stage block was not found in bin/ops-release"
else
  ok "the sweep stage block is present in bin/ops-release"
  ran="$FIX/stage-ran"
  release_pr_sweep() { : >"$ran"; }
  rm -f "$ran"
  ( do_sweep=0 dry_run=0 sweep_only=0 GH_REPO="$SWEEP_TEST_REPO"; eval "$BLOCK" ) >/dev/null 2>&1
  [ ! -f "$ran" ] && ok "--no-sweep skips the sweep stage" || err "--no-sweep still ran the sweep"
  rm -f "$ran"
  ( do_sweep=1 dry_run=0 sweep_only=0 GH_REPO="$SWEEP_TEST_REPO"; eval "$BLOCK" ) >/dev/null 2>&1
  [ -f "$ran" ] && ok "the sweep is on by default" || err "the sweep did not run by default"
  rm -f "$ran"
  ( do_sweep=1 dry_run=1 sweep_only=0 GH_REPO="$SWEEP_TEST_REPO"; eval "$BLOCK" ) >/dev/null 2>&1
  [ ! -f "$ran" ] && ok "--dry-run never merges anything" || err "--dry-run ran the real sweep"
fi

rm -rf "$FIX"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
