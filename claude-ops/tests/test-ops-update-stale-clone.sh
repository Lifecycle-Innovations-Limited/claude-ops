#!/usr/bin/env bash
# Contract tests for bin/ops-update's stale-marketplace-clone guard.
#
# Regression: `claude plugin marketplace update` exits 0 and prints
# "Successfully updated marketplace" even when the underlying clone did not
# move (a dirty worktree blocks the fast-forward). ops-update trusted that exit
# code, resolved its target version from the stale catalogue, and reported
# "already on <ver>" — so a freshly published release silently never reached the
# machine. Found 2026-09-05 with the clone 28 commits behind on v3.10.3 while
# v3.10.5 was published.
#
# These tests build throwaway git repos and stub `claude` on PATH, so nothing
# touches a real install. Public plugin: no real host paths or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/ops-update"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "== ops-update stale-catalogue guard =="

if ! command -v git >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "  SKIP: git and jq are both required"
  echo "test-ops-update-stale-clone.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

git_quiet() { git -c init.defaultBranch=main -c user.email=t@example.com -c user.name=t "$@" >/dev/null 2>&1; }

# A bare "remote" catalogue at 9.9.9, and a clone pinned one commit behind at 9.9.8.
# Laid out exactly as ops-update expects under $CLAUDE_CONFIG_DIR, so the test
# drives the real path resolution instead of a bespoke override.
make_fixture() {
  local base="$1" behind="$2"
  local remote="$base/remote" clone="$base/cfg/plugins/marketplaces/ops-marketplace"
  mkdir -p "$remote" "$base/cfg/plugins/marketplaces" "$base/cfg/plugins/cache/ops-marketplace/ops/1.0.0"
  git_quiet init "$remote"
  mkdir -p "$remote/.claude-plugin"
  printf '{"plugins":[{"name":"ops","version":"9.9.8"}]}\n' >"$remote/.claude-plugin/marketplace.json"
  git_quiet -C "$remote" add -A
  git_quiet -C "$remote" commit -m "v9.9.8"
  printf '{"plugins":[{"name":"ops","version":"9.9.9"}]}\n' >"$remote/.claude-plugin/marketplace.json"
  git_quiet -C "$remote" add -A
  git_quiet -C "$remote" commit -m "v9.9.9"
  git_quiet clone "$remote" "$clone"
  if [ "$behind" = "behind" ]; then
    git_quiet -C "$clone" reset --hard HEAD~1
  fi
  echo "$clone"
}

# Stub `claude` so `marketplace update` is a no-op that still exits 0 — exactly
# the upstream behaviour this guard exists to catch.
make_stub_path() {
  local base="$1"
  mkdir -p "$base/stubbin"
  cat >"$base/stubbin/claude" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "plugin" ] && [ "${2:-}" = "marketplace" ] && [ "${3:-}" = "update" ]; then
  echo "Successfully updated marketplace: ${4:-}"
  exit 0
fi
exit 0
STUB
  chmod +x "$base/stubbin/claude"
  echo "$base/stubbin"
}

run_update() {
  local base="$1" stub="$2"
  shift 2
  env HOME="$base/home" NO_COLOR=1 TERM=dumb \
      PATH="$stub:$PATH" \
      CLAUDE_CONFIG_DIR="$base/cfg" \
      bash "$BIN" "$@" 2>&1 || true
}

# The guard's own phrase. Deliberately distinct from step 6's "stale
# version-pinned paths", which is unrelated and prints on healthy runs — a bare
# grep for "stale" matches that too and gives a false positive.
MARKER="marketplace clone is STALE"

# ── 1. A clone behind its remote must fail loudly, not report "already on".
b1="$tmpdir/case-behind"
mkdir -p "$b1/home"
make_fixture "$b1" behind >/dev/null
stub1="$(make_stub_path "$b1")"
out1="$(run_update "$b1" "$stub1" --dry-run)"
if grep -qF "$MARKER" <<<"$out1"; then
  pass "a clone behind its remote is reported STALE"
else
  fail "a clone behind its remote is reported STALE (got: $(head -c 300 <<<"$out1"))"
fi
if grep -qE "target version: *9\.9\.8" <<<"$out1"; then
  fail "must not resolve a target from the stale catalogue"
else
  pass "does not resolve a target from the stale catalogue"
fi

# ── 2. A dirty worktree is named as the cause, since that is the actual fix.
b2="$tmpdir/case-dirty"
mkdir -p "$b2/home"
clone2="$(make_fixture "$b2" behind)"
echo "local edit" >>"$clone2/.claude-plugin/marketplace.json"
stub2="$(make_stub_path "$b2")"
out2="$(run_update "$b2" "$stub2" --dry-run)"
if grep -qi "local changes" <<<"$out2"; then
  pass "a dirty worktree is named as the cause"
else
  fail "a dirty worktree is named as the cause (got: $(head -c 300 <<<"$out2"))"
fi

# ── 3. A clone already at its remote tip must NOT trip the guard.
b3="$tmpdir/case-current"
mkdir -p "$b3/home"
make_fixture "$b3" current >/dev/null
stub3="$(make_stub_path "$b3")"
out3="$(run_update "$b3" "$stub3" --dry-run)"
if grep -qF "$MARKER" <<<"$out3"; then
  fail "an up-to-date clone must not be flagged stale (got: $(head -c 300 <<<"$out3"))"
else
  pass "an up-to-date clone is not flagged stale"
fi
if grep -qE "target version: *9\.9\.9" <<<"$out3"; then
  pass "resolves the real published version from a current catalogue"
else
  fail "resolves the real published version from a current catalogue (got: $(head -c 300 <<<"$out3"))"
fi

echo ""
echo "test-ops-update-stale-clone.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
