#!/usr/bin/env bash
# Contract tests for bin/ops-update's downgrade guards.
#
# Regression (2026-09-11): the local marketplace clone sat on the commit for
# 3.10.13 with a dirty worktree while the remote had v3.10.15. `claude plugin
# marketplace update` reported success without moving it, the stale-clone guard
# returned "not stale" because one of its git calls failed (fail-open), step 2
# resolved 3.10.13, step 5 pruned the installed 3.10.14 and 3.10.15 caches, and
# the summary printed "3.10.15 → 3.10.13 ... ✓ upgrade complete". A downgrade
# dressed as an upgrade.
#
# Three guards now stand in the way, each tested here:
#   1. the clone check is fail-CLOSED (an unverifiable clone aborts; --offline warns)
#   2. the catalogue version may not be behind the newest remote tag
#   3. the target may not sort below the installed version (--allow-downgrade overrides)
#
# Throwaway git repos and a stubbed `claude` on PATH; nothing touches a real
# install. Public plugin: no real host paths or personal data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/ops-update"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "== ops-update downgrade guards =="

if ! command -v git >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "  SKIP: git and jq are both required"
  echo "test-ops-update-downgrade-guard.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

git_quiet() { git -c init.defaultBranch=main -c user.email=t@example.com -c user.name=t "$@" >/dev/null 2>&1; }

# Fixture: a "remote" whose main says $catalogue_ver, tagged with each of
# $tags (comma-separated, may be empty), and a clone of it at main's tip laid
# out under $CLAUDE_CONFIG_DIR exactly as ops-update resolves it. Installed
# cache dirs are $caches (comma-separated).
make_fixture() {
  local base="$1" catalogue_ver="$2" tags="$3" caches="$4"
  local remote="$base/remote" clone="$base/cfg/plugins/marketplaces/ops-marketplace"
  local cache_root="$base/cfg/plugins/cache/ops-marketplace/ops"
  mkdir -p "$remote" "$base/cfg/plugins/marketplaces" "$base/home" "$cache_root"
  local c; for c in ${caches//,/ }; do mkdir -p "$cache_root/$c"; done
  git_quiet init "$remote"
  mkdir -p "$remote/.claude-plugin"
  printf '{"plugins":[{"name":"ops","version":"%s"}]}\n' "$catalogue_ver" >"$remote/.claude-plugin/marketplace.json"
  git_quiet -C "$remote" add -A
  git_quiet -C "$remote" commit -m "v$catalogue_ver"
  local t; for t in ${tags//,/ }; do git_quiet -C "$remote" tag "$t"; done
  git_quiet clone "$remote" "$clone"
  echo "$clone"
}

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

# Runs ops-update; output lands in $OUT, exit code in $RC. (Not a $(...)
# capture: that would run in a subshell and lose $RC.)
RC=0; OUT=""
run_update() {
  local base="$1"; shift
  local stub; stub="$(make_stub_path "$base")"
  set +e
  env HOME="$base/home" NO_COLOR=1 TERM=dumb \
      PATH="$stub:$PATH" \
      CLAUDE_CONFIG_DIR="$base/cfg" \
      bash "$BIN" "$@" >"$tmpdir/out.txt" 2>&1
  RC=$?
  set -e
  OUT="$(cat "$tmpdir/out.txt")"
}

# ── 1. Catalogue behind the newest remote tag → refuse, even with the clone at tip.
b1="$tmpdir/tag-behind"
make_fixture "$b1" 3.10.13 "v3.10.13,v3.10.15" 3.10.13 >/dev/null
run_update "$b1" --dry-run; out1="$OUT"
if [ "$RC" -ne 0 ]; then
  pass "catalogue behind remote tag exits non-zero"
else
  fail "catalogue behind remote tag exits non-zero (rc=$RC)"
fi
if grep -qF "catalogue behind remote tag v3.10.15 (catalogue says 3.10.13)" <<<"$out1"; then
  pass "names the remote tag and the catalogue version"
else
  fail "names the remote tag and the catalogue version (got: $(head -c 400 <<<"$out1"))"
fi
if grep -qE "target version:" <<<"$out1"; then
  fail "must not reach target resolution behind a stale catalogue"
else
  pass "does not reach target resolution behind a stale catalogue"
fi

# ── 2. Catalogue equal to the newest tag → passes the tag check.
b2="$tmpdir/tag-equal"
make_fixture "$b2" 3.10.15 "v3.10.14,v3.10.15" 3.10.15 >/dev/null
run_update "$b2" --dry-run; out2="$OUT"
if grep -qF "catalogue 3.10.15 matches newest remote tag v3.10.15" <<<"$out2"; then
  pass "catalogue equal to the newest tag passes the tag check"
else
  fail "catalogue equal to the newest tag passes the tag check (got: $(head -c 400 <<<"$out2"))"
fi

# ── 3. Installed 3.10.15, catalogue 3.10.13 (tags consistent) → DOWNGRADE refused.
b3="$tmpdir/downgrade"
make_fixture "$b3" 3.10.13 "v3.10.13" 3.10.14,3.10.15 >/dev/null
run_update "$b3" --dry-run; out3="$OUT"
if [ "$RC" -ne 0 ] && grep -qF "refusing to DOWNGRADE 3.10.15 → 3.10.13" <<<"$out3"; then
  pass "installed 3.10.15 with catalogue 3.10.13 is refused as a DOWNGRADE"
else
  fail "installed 3.10.15 with catalogue 3.10.13 is refused as a DOWNGRADE (rc=$RC, got: $(head -c 400 <<<"$out3"))"
fi
if grep -qF -- "--to 3.10.13 --allow-downgrade" <<<"$out3"; then
  pass "hint names the explicit override"
else
  fail "hint names the explicit override (got: $(head -c 400 <<<"$out3"))"
fi
if grep -qE "pruned cache 3\.10\.1[45]" <<<"$out3"; then
  fail "must not reach the prune step on a refused downgrade"
else
  pass "does not reach the prune step on a refused downgrade"
fi

# ── 4. --to below installed, without --allow-downgrade → still refused.
run_update "$b3" --dry-run --to 3.10.13; out4="$OUT"
if [ "$RC" -ne 0 ] && grep -qF "refusing to DOWNGRADE 3.10.15 → 3.10.13" <<<"$out4"; then
  pass "--to below the installed version is refused without --allow-downgrade"
else
  fail "--to below the installed version is refused without --allow-downgrade (rc=$RC)"
fi

# ── 5. --to below installed WITH --allow-downgrade, --dry-run → proceeds, exits 0.
run_update "$b3" --dry-run --to 3.10.13 --allow-downgrade; out5="$OUT"
if [ "$RC" -eq 0 ]; then
  pass "--to 3.10.13 --allow-downgrade --dry-run exits 0"
else
  fail "--to 3.10.13 --allow-downgrade --dry-run exits 0 (rc=$RC, got: $(tail -c 400 <<<"$out5"))"
fi
if grep -qF "DOWNGRADE 3.10.15 → 3.10.13 permitted by --allow-downgrade" <<<"$out5"; then
  pass "an allowed downgrade is announced as one"
else
  fail "an allowed downgrade is announced as one (got: $(head -c 400 <<<"$out5"))"
fi
if grep -qE "\[dry-run\] rm -rf .*3\.10\.15" <<<"$out5"; then
  pass "with --allow-downgrade the newer cache would be pruned"
else
  fail "with --allow-downgrade the newer cache would be pruned (got: $(grep -n prune <<<"$out5" | head -3))"
fi

# ── 6. Same version installed and in catalogue → not a downgrade, exits 0.
b6="$tmpdir/same"
make_fixture "$b6" 3.10.15 "v3.10.15" 3.10.15 >/dev/null
run_update "$b6" --dry-run; out6="$OUT"
if [ "$RC" -eq 0 ] && ! grep -qF "DOWNGRADE" <<<"$out6"; then
  pass "same version is not treated as a downgrade"
else
  fail "same version is not treated as a downgrade (rc=$RC, got: $(head -c 400 <<<"$out6"))"
fi

# ── 7. Remote unreachable → fail-CLOSED; --offline warns and continues.
b7="$tmpdir/offline"
make_fixture "$b7" 3.10.15 "v3.10.15" 3.10.15 >/dev/null
rm -rf "$b7/remote"
run_update "$b7" --dry-run; out7="$OUT"
if [ "$RC" -ne 0 ] && grep -qF "could not verify the marketplace clone against its remote" <<<"$out7"; then
  pass "an unreachable remote aborts the run (fail-closed)"
else
  fail "an unreachable remote aborts the run (rc=$RC, got: $(head -c 400 <<<"$out7"))"
fi
run_update "$b7" --dry-run --offline; out7b="$OUT"
if [ "$RC" -eq 0 ] && grep -qF -- "--offline: could not verify" <<<"$out7b" && grep -qE "target version: *3\.10\.15" <<<"$out7b"; then
  pass "--offline turns the unreachable remote into a warning and continues"
else
  fail "--offline turns the unreachable remote into a warning and continues (rc=$RC, got: $(head -c 400 <<<"$out7b"))"
fi

# ── 8. --offline does not license a downgrade.
b8="$tmpdir/offline-downgrade"
make_fixture "$b8" 3.10.13 "v3.10.13" 3.10.15 >/dev/null
rm -rf "$b8/remote"
run_update "$b8" --dry-run --offline; out8="$OUT"
if [ "$RC" -ne 0 ] && grep -qF "refusing to DOWNGRADE 3.10.15 → 3.10.13" <<<"$out8"; then
  pass "--offline still refuses a downgrade"
else
  fail "--offline still refuses a downgrade (rc=$RC, got: $(head -c 400 <<<"$out8"))"
fi

echo ""
echo "test-ops-update-downgrade-guard.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
