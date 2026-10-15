#!/usr/bin/env bash
# test-ops-update-parity.sh — ops-update's skill-parity contract.
#
#   - --check runs the read-only parity core: no catalogue pull (git is a
#     logging stub that must stay silent), no writes under HOME, the check's
#     own exit code, and it works without the claude CLI.
#   - --target is still an alias of --to (a VERSION); host selection is the
#     separate --host flag.
#   - A companion CLI that ends non-clean after the Claude Code update makes the
#     run "partial" (exit 3) with the per-target summary; the Claude step is
#     not undone. A clean companion sync still prints "upgrade complete", exit 0.
#     (approved partial-exit contract.)
#
# Throwaway git repos and stubs only; nothing touches a real install.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/ops-update"
PASS=0
FAIL=0
pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}
fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "== ops-update parity contract =="
for t in git jq node; do
  command -v "$t" >/dev/null 2>&1 || {
    fail "$t is required"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
  }
done

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/ops-update-parity.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT
git_quiet() { git -c init.defaultBranch=main -c user.email=ops-test -c user.name=t "$@" >/dev/null 2>&1; }

# GNU stat reads -f as "filesystem" (free blocks move with every write); pick by flavour.
if stat -c '%n' . >/dev/null 2>&1; then STAT_FMT=(-c '%n %s %Y %N'); else STAT_FMT=(-f '%N %z %m %Y'); fi
snapshot() { (cd "$1" && find . -print0 | LC_ALL=C sort -z | xargs -0 stat "${STAT_FMT[@]}"); }

# ── 1. --check: read-only, no pull, no claude needed ──────────────────────────
b="$tmpdir/check"
mkdir -p "$b/home/.claude/plugins/cache/ops-marketplace/ops/9.9.9/skills/ops" "$b/stub"
rel="$b/home/.claude/plugins/cache/ops-marketplace/ops/9.9.9"
mkdir -p "$rel/.claude-plugin"
printf '{"name":"ops","version":"9.9.9"}\n' >"$rel/.claude-plugin/plugin.json"
printf 'router\n' >"$rel/skills/ops/SKILL.md"
printf '{"version":2,"plugins":{"ops@ops-marketplace":[{"installPath":"%s","version":"9.9.9"}]}}\n' "$rel" \
  >"$b/home/.claude/plugins/installed_plugins.json"
cat >"$b/stub/git" <<'EOF'
#!/bin/bash
echo "git $*" >>"$OPS_TEST_LOG"
exit 1
EOF
chmod +x "$b/stub/git"
ln -s "$(command -v node)" "$b/stub/node"
before="$(snapshot "$b/home")"
out="$(env -i HOME="$b/home" PATH="$b/stub:/usr/bin:/bin" OPS_TEST_LOG="$b/git.log" bash "$BIN" --check 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && grep -q "claude  *MATCH" <<<"$out"; then
  pass "--check runs the parity core without the claude CLI (exit 0 on match)"
else
  fail "--check runs the parity core (rc=$rc: $(head -c 400 <<<"$out"))"
fi
[[ ! -s "$b/git.log" ]] && pass "--check does not pull or call git" || fail "--check called git: $(cat "$b/git.log")"
[[ "$(snapshot "$b/home")" == "$before" ]] && pass "--check leaves HOME byte-identical" || fail "--check wrote under HOME"
printf 'drift\n' >"$rel/skills/ops/SKILL.md"
mkdir -p "$b/home/.grok/installed-plugins/x/skills/ops"
printf '{"repos":{"x":{"path":"%s","plugins":{"ops":{}}}}}\n' "$b/home/.grok/installed-plugins/x" >"$b/home/.grok/installed-plugins/registry.json"
out="$(env -i HOME="$b/home" PATH="$b/stub:/usr/bin:/bin" OPS_TEST_LOG="$b/git.log" bash "$BIN" --check --host grok 2>&1)"
rc=$?
[[ $rc -eq 1 ]] && grep -q "grok  *DRIFT" <<<"$out" && ! grep -q "claude  *MATCH" <<<"$out" &&
  pass "--check --host limits the selection and returns the check's exit code (1 = drift)" ||
  fail "--check --host (rc=$rc: $(head -c 400 <<<"$out"))"
out="$(env -i HOME="$b/home" PATH="/usr/bin:/bin" bash "$BIN" --check 2>&1)"
rc=$?
[[ $rc -eq 5 ]] && grep -q "environment problem" <<<"$out" && pass "--check without node is an environment error (exit 5)" ||
  fail "--check without node (rc=$rc)"
env -i HOME="$b/home" PATH="/usr/bin:/bin" bash "$BIN" --host >/dev/null 2>&1
[[ $? -eq 2 ]] && pass "--host without a value is a usage error" || fail "--host without a value"

# ── fixture for full runs (same layout as test-ops-update-downgrade-guard.sh) ─
make_fixture() {
  local base="$1" catalogue_ver="$2" caches="$3"
  local remote="$base/remote" clone="$base/cfg/plugins/marketplaces/ops-marketplace"
  local cache_root="$base/cfg/plugins/cache/ops-marketplace/ops"
  mkdir -p "$remote" "$base/cfg/plugins/marketplaces" "$base/home" "$cache_root" "$base/stubbin"
  local c
  for c in ${caches//,/ }; do mkdir -p "$cache_root/$c"; done
  git_quiet init "$remote"
  mkdir -p "$remote/.claude-plugin"
  printf '{"plugins":[{"name":"ops","version":"%s"}]}\n' "$catalogue_ver" >"$remote/.claude-plugin/marketplace.json"
  git_quiet -C "$remote" add -A
  git_quiet -C "$remote" commit -m "v$catalogue_ver"
  git_quiet -C "$remote" tag "v$catalogue_ver"
  git_quiet clone "$remote" "$clone"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$base/stubbin/claude"
  chmod +x "$base/stubbin/claude"
}
RC=0
OUT=""
run_update() {
  local base="$1"
  shift
  env HOME="$base/home" NO_COLOR=1 TERM=dumb PATH="$base/stubbin:$PATH" \
    CLAUDE_CONFIG_DIR="$base/cfg" bash "$BIN" "$@" >"$base/out.txt" 2>&1
  RC=$?
  OUT="$(cat "$base/out.txt")"
}

# ── 2. --target is still a version alias ────────────────────────────────────────
b="$tmpdir/target"
make_fixture "$b" 3.10.28 3.10.20
run_update "$b" --dry-run --target 3.10.27
grep -q "target version:    3.10.27" <<<"$OUT" && pass "--target 3.10.27 still selects a version" ||
  fail "--target alias (rc=$RC: $(grep -m1 'target version' <<<"$OUT"))"
run_update "$b" --dry-run --to 3.10.28
grep -q "target version:    3.10.28" <<<"$OUT" && pass "--to keeps working" || fail "--to (rc=$RC)"

# ── 3. Companion sync non-clean → partial, exit 3; clean → complete, exit 0 ───
fake_sync() { # <cache dir> <exit code> <status>
  mkdir -p "$1/scripts"
  cat >"$1/scripts/sync-companion-clis.sh" <<EOF
#!/usr/bin/env bash
rec=""
while [[ \$# -gt 0 ]]; do case "\$1" in --record) rec="\$2"; shift 2 ;; *) shift ;; esac; done
cls=clean; [[ "$3" != MATCH ]] && cls=gap
[[ -n "\$rec" ]] && printf '{"target":"hermes","status":"%s","class":"%s"}\n' "$3" "\$cls" >>"\$rec"
echo "  hermes  $3"
exit $2
EOF
}
FLAGS=(--no-prune --no-patches --no-rewrite --no-localsync --no-companions)
b="$tmpdir/partial"
make_fixture "$b" 3.10.28 3.10.28
fake_sync "$b/cfg/plugins/cache/ops-marketplace/ops/3.10.28" 3 DEV_SOURCE
run_update "$b" "${FLAGS[@]}"
if [[ $RC -eq 3 ]] && grep -q "upgrade partial: Claude Code is on v3.10.28" <<<"$OUT" && grep -q "hermes" <<<"$(grep -A3 'companion CLIs:' <<<"$OUT")" &&
  ! grep -q "upgrade complete" <<<"$OUT"; then
  pass "a non-clean companion ends the run partial (exit 3) with the per-target summary"
else
  fail "partial exit (rc=$RC: $(tail -c 600 <<<"$OUT"))"
fi
grep -q "cache materialised" <<<"$OUT" && grep -q "10/11 Sync companion CLIs" <<<"$OUT" &&
  pass "the Claude step completed before the companion step (not rolled back)" || fail "step order"

b="$tmpdir/clean"
make_fixture "$b" 3.10.28 3.10.28
fake_sync "$b/cfg/plugins/cache/ops-marketplace/ops/3.10.28" 0 MATCH
run_update "$b" "${FLAGS[@]}"
[[ $RC -eq 0 ]] && grep -q "upgrade complete" <<<"$OUT" && pass "a clean companion sync keeps 'upgrade complete', exit 0" ||
  fail "clean run (rc=$RC: $(tail -c 400 <<<"$OUT"))"

echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
