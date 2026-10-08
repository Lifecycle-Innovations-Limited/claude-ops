#!/usr/bin/env bash
# test-companion-cli-sync.sh — coverage for scripts/sync-companion-clis.sh.
#
# WHY THIS FILE EXISTS
#
# PR #986 made `ops-update` fire automatically on any skill call, so this
# script runs unattended. A regression in it would silently stop propagating
# updates to every non-Claude harness while the update reported success.
#
# CONTRACT CHANGE (approved skill-parity plan, approved 2026-10-08)
#
# This suite used to assert "the script exits 0 even when a harness is
# broken". That assertion is replaced, not deleted: the Claude Code step in
# ops-update is already finished when this runs, so a non-zero exit here can
# no longer abort it (ops-update captures the code and ends "partial"). What
# must hold now is that every target is processed, a failed target keeps its
# previous registration, each target gets a record, and the exit code says
# so (3 = partial, 6 = only locked, 4 = usage).
#
# WHAT IS ASSERTED
#
#   - not installed -> NOT_CONFIGURED, exit 0
#   - Hermes copy: the release lands byte-exact (same-length version bump in
#     the same second: rsync's size+mtime quick check would skip it), the skill
#     tree is bundled, __pycache__ is not copied, an ownership manifest is
#     written, a pre-manifest file is kept (it is not provably ours)
#   - repeat run: MATCH with zero writes (full snapshot)
#   - a file dropped upstream is pruned once it is manifest-owned; a user
#     file next to it survives
#   - a local edit of an OPS file, or a user file at a release path, is
#     OWNERSHIP_CONFLICT and nothing changes
#   - dev-checkout symlink -> DEV_SOURCE, untouched; other symlink -> DRIFT
#   - HERMES_HOME is honoured; --dry-run writes nothing anywhere under HOME
#   - crash before the swap keeps the old plugin; crash mid-swap is restored
#     by the next run
#   - a held lock -> LOCKED (exit 6), target untouched
#   - first / middle / last target failure: the others keep their result,
#     aggregate exit 3, one JSON record per target
#   - Cursor is never removed/re-added (UNSUPPORTED_SAFE_APPLY)
#   - the bash status table equals lib/parity/status.json; lock keys match
#
# Every path is under a throwaway HOME; no real personal value appears here.

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT="$PLUGIN_ROOT/scripts/sync-companion-clis.sh"

PASS=0
FAIL=0
ok() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}
err() {
  echo "  FAIL: $1"
  echo "        $2"
  FAIL=$((FAIL + 1))
}

echo "=== companion CLI sync ==="

if [[ ! -f "$SCRIPT" ]]; then
  err "sync script present" "missing $SCRIPT"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi
command -v rsync >/dev/null 2>&1 || {
  err "rsync available" "the Hermes path cannot be exercised without rsync"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
}
NODE_BIN="$(command -v node || true)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ops-companion-sync.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A fake plugin root: hermes-plugin/, skills/, plugin.json and the parity core.
FAKE_ROOT="$WORK/plugin"
mkdir -p "$FAKE_ROOT/scripts" "$FAKE_ROOT/hermes-plugin/__pycache__" \
  "$FAKE_ROOT/skills/ops" "$FAKE_ROOT/skills/ops-a/references" \
  "$FAKE_ROOT/.claude-plugin" "$FAKE_ROOT/lib/parity"
cp "$SCRIPT" "$FAKE_ROOT/scripts/sync-companion-clis.sh"
cp "$PLUGIN_ROOT/lib/parity/check.mjs" "$PLUGIN_ROOT/lib/parity/status.json" "$FAKE_ROOT/lib/parity/"
printf '{"name":"ops","version":"9.9.9"}\n' >"$FAKE_ROOT/.claude-plugin/plugin.json"
printf 'name: ops\nversion: "9.9.9"\n' >"$FAKE_ROOT/hermes-plugin/plugin.yaml"
printf 'new\n' >"$FAKE_ROOT/hermes-plugin/__init__.py"
printf 'stale bytecode\n' >"$FAKE_ROOT/hermes-plugin/__pycache__/old.pyc"
printf -- '---\nname: ops\n---\nrouter\n' >"$FAKE_ROOT/skills/ops/SKILL.md"
printf -- '---\nname: ops-a\n---\nalpha\n' >"$FAKE_ROOT/skills/ops-a/SKILL.md"
printf 'ref\n' >"$FAKE_ROOT/skills/ops-a/references/r.md"
SYNC="$FAKE_ROOT/scripts/sync-companion-clis.sh"

BASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
# Run with a throwaway HOME and no companion CLIs (and no node) on PATH.
run_sync() {
  local home="$1"
  shift
  env -i PATH="$BASE_PATH" HOME="$home" ${HH:+HERMES_HOME="$HH"} ${FAULT:+OPS_SYNC_FAULT="$FAULT"} \
    bash "$SYNC" "$@" 2>&1
}
snapshot() {
  (cd "$1" && find . -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 stat -f '%N %z %m %p %Y' 2>/dev/null)
}
ver() { grep -m1 version "$1" 2>/dev/null; }
# Legacy (pre-manifest) Hermes copy at version 1.0.0, same file length as 9.9.9.
legacy_hermes() {
  mkdir -p "$1/.hermes/plugins/ops"
  printf 'name: ops\nversion: "1.0.0"\n' >"$1/.hermes/plugins/ops/plugin.yaml"
  printf 'old\n' >"$1/.hermes/plugins/ops/__init__.py"
  printf 'dropped upstream\n' >"$1/.hermes/plugins/ops/gone.py"
  touch -t 202601010000 "$1/.hermes/plugins/ops/plugin.yaml"
}

# --- 1. Nothing installed -----------------------------------------------------
H="$WORK/home-empty"
mkdir -p "$H"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 0 ]] && grep -q "hermes  NOT_CONFIGURED" <<<"$out" && grep -q "grok    NOT_CONFIGURED" <<<"$out"; then
  ok "nothing installed: every target NOT_CONFIGURED, exit 0"
else
  err "nothing installed: every target NOT_CONFIGURED, exit 0" "rc=$rc: $(tr '\n' ' ' <<<"$out")"
fi

# --- 2. Legacy Hermes copy is replaced by the staged release -------------------
H="$WORK/home-hermes"
legacy_hermes "$H"
D="$H/.hermes/plugins/ops"
out="$(run_sync "$H" --record "$WORK/rec2.jsonl")"
rc=$?
if [[ $rc -eq 0 ]] && grep -q '9\.9\.9' <<<"$(ver "$D/plugin.yaml")"; then
  ok "the release lands byte-exact over a same-length older version (APPLIED, exit 0)"
else
  err "the release lands byte-exact over a same-length older version" "rc=$rc plugin.yaml: $(ver "$D/plugin.yaml") $(tr '\n' ' ' <<<"$out")"
fi
[[ -f "$D/skills/ops-a/references/r.md" && -f "$D/.ops-manifest" ]] &&
  ok "skill tree bundled under plugins/ops/skills/ and .ops-manifest written" ||
  err "skill tree bundled and manifest written" "$(ls -R "$D" | tr '\n' ' ')"
[[ ! -e "$D/__pycache__" ]] && ok "__pycache__ is not copied" || err "__pycache__ is not copied" "found $D/__pycache__"
if [[ -f "$D/gone.py" ]] && grep -q "user file(s) kept" <<<"$out" && grep -q "pre-manifest" <<<"$out"; then
  ok "a pre-manifest file is kept, not deleted (ownership unknown), and reported"
else
  err "a pre-manifest file is kept and reported" "$(tr '\n' ' ' <<<"$out")"
fi
ls "$H/.hermes/plugins" | grep -q '^ops$' && [[ "$(ls -A "$H/.hermes/plugins")" == "ops" ]] &&
  ok "no staging dirs inside plugins/ (Hermes would load them)" ||
  err "no staging dirs inside plugins/" "$(ls -A "$H/.hermes/plugins" | tr '\n' ' ')"

# --- 3. Repeat run is idempotent ---------------------------------------------
before="$(snapshot "$H")"
out="$(run_sync "$H")"
rc=$?
after="$(snapshot "$H")"
# The lock dir under ~/.local/state is created and removed again; compare the plugin tree.
if [[ $rc -eq 0 ]] && grep -q "hermes  MATCH" <<<"$out" &&
  [[ "$(grep -v '/.local' <<<"$before")" == "$(grep -v '/.local' <<<"$after")" ]]; then
  ok "second run is MATCH with zero writes to the target"
else
  err "second run is MATCH with zero writes" "rc=$rc $(tr '\n' ' ' <<<"$out") diff: $(diff <(grep -v '/.local' <<<"$before") <(grep -v '/.local' <<<"$after") | head -5 | tr '\n' ' ')"
fi

# --- 4. Upstream drops a file: pruned once manifest-owned; user file survives ---
printf 'will be dropped\n' >"$FAKE_ROOT/hermes-plugin/extra.py"
run_sync "$H" >/dev/null
rm "$FAKE_ROOT/hermes-plugin/extra.py"
printf 'my notes\n' >"$D/my-notes.md"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 0 && ! -e "$D/extra.py" ]] && grep -q "pruned" <<<"$out"; then
  ok "a manifest-owned file dropped upstream is pruned"
else
  err "a manifest-owned file dropped upstream is pruned" "rc=$rc extra.py exists=$([[ -e $D/extra.py ]] && echo y) $(tr '\n' ' ' <<<"$out")"
fi
[[ "$(cat "$D/my-notes.md" 2>/dev/null)" == "my notes" ]] &&
  ok "a user file in the target survives the sync" ||
  err "a user file in the target survives the sync" "my-notes.md gone or changed"

# --- 5. Local edit of an OPS file -> OWNERSHIP_CONFLICT, nothing changes ---------
printf 'name: ops\nversion: "9.9.9"\n# local tweak\n' >"$D/plugin.yaml"
printf 'v2\n' >"$FAKE_ROOT/hermes-plugin/__init__.py"
before="$(snapshot "$D")"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 3 ]] && grep -q "OWNERSHIP_CONFLICT" <<<"$out" && grep -q "plugin.yaml (edited)" <<<"$out" && [[ "$(snapshot "$D")" == "$before" ]]; then
  ok "a locally edited OPS file is OWNERSHIP_CONFLICT (exit 3) and the target is byte-identical"
else
  err "a locally edited OPS file is OWNERSHIP_CONFLICT" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi
printf 'name: ops\nversion: "9.9.9"\n' >"$D/plugin.yaml"
printf 'new\n' >"$FAKE_ROOT/hermes-plugin/__init__.py"

# --- 6. User file at a path the release ships ---------------------------------
printf 'mine\n' >"$FAKE_ROOT/hermes-plugin/collide.py"
printf 'user version\n' >"$D/collide.py"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 3 ]] && grep -q "collide.py (user file)" <<<"$out" && [[ "$(cat "$D/collide.py")" == "user version" ]]; then
  ok "a user file at a release path is OWNERSHIP_CONFLICT and kept"
else
  err "a user file at a release path is OWNERSHIP_CONFLICT" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi
rm -f "$FAKE_ROOT/hermes-plugin/collide.py" "$D/collide.py"

# --- 7. Symlinked installs are never clobbered --------------------------------
H="$WORK/home-symlink"
mkdir -p "$H/.hermes/plugins" "$WORK/checkout/.git" "$WORK/checkout/claude-ops/hermes-plugin" "$WORK/plain"
printf 'name: ops\nversion: "0.0.1-local"\n' >"$WORK/checkout/claude-ops/hermes-plugin/plugin.yaml"
ln -s "$WORK/checkout/claude-ops/hermes-plugin" "$H/.hermes/plugins/ops"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 3 && -L "$H/.hermes/plugins/ops" ]] && grep -q "DEV_SOURCE" <<<"$out" && grep -q '0\.0\.1-local' <<<"$(ver "$WORK/checkout/claude-ops/hermes-plugin/plugin.yaml")"; then
  ok "a dev-checkout symlink is DEV_SOURCE, untouched, and makes the run partial"
else
  err "a dev-checkout symlink is DEV_SOURCE and untouched" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi
rm "$H/.hermes/plugins/ops"
ln -s "$WORK/plain" "$H/.hermes/plugins/ops"
out="$(run_sync "$H")"
grep -q "hermes  DRIFT" <<<"$out" && [[ -L "$H/.hermes/plugins/ops" ]] &&
  ok "a symlink to another non-git dir is DRIFT and untouched" ||
  err "a symlink to another dir is DRIFT" "$(tr '\n' ' ' <<<"$out")"
ln -sfn "$FAKE_ROOT/hermes-plugin" "$H/.hermes/plugins/ops"
out="$(run_sync "$H")"
grep -q "hermes  MATCH" <<<"$out" && ok "a symlink to this release is MATCH" || err "symlink to this release is MATCH" "$(tr '\n' ' ' <<<"$out")"

# --- 8. HERMES_HOME is honoured -----------------------------------------------
H="$WORK/home-nondefault"
ALT="$WORK/hermes-primary"
mkdir -p "$H" "$ALT/plugins/ops"
printf 'name: ops\nversion: "1.0.0"\n' >"$ALT/plugins/ops/plugin.yaml"
out="$(HH="$ALT" run_sync "$H")"
if grep -q '9\.9\.9' <<<"$(ver "$ALT/plugins/ops/plugin.yaml")"; then
  ok "HERMES_HOME is honoured instead of assuming ~/.hermes"
else
  err "HERMES_HOME is honoured" "$(ver "$ALT/plugins/ops/plugin.yaml") $(tr '\n' ' ' <<<"$out")"
fi

# --- 9. --dry-run writes nothing anywhere under HOME ----------------------------
H="$WORK/home-dry"
legacy_hermes "$H"
before="$(snapshot "$H")"
out="$(run_sync "$H" --dry-run)"
rc=$?
if [[ $rc -eq 0 && "$(snapshot "$H")" == "$before" ]]; then
  ok "--dry-run leaves the whole HOME untouched (no lock, no work dir)"
else
  err "--dry-run leaves HOME untouched" "rc=$rc $(diff <(echo "$before") <(snapshot "$H") | head -5 | tr '\n' ' ')"
fi

# --- 10. Broken target: recorded, others processed, partial exit (the partial-exit decision) --------
H="$WORK/home-broken"
mkdir -p "$H/.hermes/plugins"
printf 'not a directory\n' >"$H/.hermes/plugins/ops"
out="$(run_sync "$H" --record "$WORK/rec10.jsonl")"
rc=$?
n_rec="$(wc -l <"$WORK/rec10.jsonl" | tr -d ' ')"
if [[ $rc -eq 3 && "$n_rec" == "4" ]] && grep -q "OWNERSHIP_CONFLICT" <<<"$out" &&
  [[ "$(cat "$H/.hermes/plugins/ops")" == "not a directory" ]] && grep -q "companion sync: partial" <<<"$out"; then
  ok "a broken target is OWNERSHIP_CONFLICT, left alone, all 4 targets recorded, exit 3 with a partial summary"
else
  err "broken target -> partial exit with records" "rc=$rc records=$n_rec $(tr '\n' ' ' <<<"$out")"
fi
if python3 - "$WORK/rec10.jsonl" <<'PY'; then
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
need = {"target", "status", "class", "detail", "cause", "next", "docs"}
assert all(need <= set(r) for r in rows), rows
assert {r["target"] for r in rows} == {"grok", "cursor", "codex", "hermes"}
assert all(r["docs"].startswith("docs/skill-parity.md#status-") for r in rows)
PY
  ok "--record writes one valid JSON record per target with docs anchors"
else
  err "--record JSON records" "$(cat "$WORK/rec10.jsonl")"
fi
# An old ops-update swallows this exit code (`|| warn non-fatal`); the summary
# line above is what such an updater still shows the user.

# --- 11. Missing hermes-plugin/ in the source ------------------------------------
NOSRC="$WORK/plugin-nosrc"
mkdir -p "$NOSRC/scripts"
cp "$SCRIPT" "$NOSRC/scripts/sync-companion-clis.sh"
H="$WORK/home-nosrc"
mkdir -p "$H/.hermes/plugins/ops"
out="$(env -i PATH="$BASE_PATH" HOME="$H" bash "$NOSRC/scripts/sync-companion-clis.sh" 2>&1)"
rc=$?
if [[ $rc -eq 3 ]] && grep -q "MISSING_REFERENCE" <<<"$out"; then
  ok "a missing hermes-plugin/ source is MISSING_REFERENCE, not silently skipped"
else
  err "missing hermes-plugin/ source is reported" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi

# --- 12. Crash before the swap keeps the old plugin -------------------------------
H="$WORK/home-crash"
legacy_hermes "$H"
before="$(snapshot "$H/.hermes/plugins")"
out="$(FAULT=before-swap run_sync "$H")"
rc=$?
if [[ $rc -eq 3 && "$(snapshot "$H/.hermes/plugins")" == "$before" ]] && ! ls -d "$H/.hermes/.ops-sync"/stage.* >/dev/null 2>&1; then
  ok "a crash between staging and swap leaves the previous registration intact and no stage behind"
else
  err "crash before swap keeps the old plugin" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi

# --- 13. Crash mid-swap is restored by the next run -----------------------------
out="$(FAULT=mid-swap run_sync "$H")"
gone=0
[[ ! -e "$H/.hermes/plugins/ops" ]] && gone=1
out2="$(run_sync "$H")"
rc=$?
if [[ $gone -eq 1 && $rc -eq 0 ]] && grep -q "restored the previous registration" <<<"$out2" && grep -q '9\.9\.9' <<<"$(ver "$H/.hermes/plugins/ops/plugin.yaml")"; then
  ok "an interrupted swap is restored and completed by the next run"
else
  err "interrupted swap recovery" "gone=$gone rc=$rc $(tr '\n' ' ' <<<"$out2")"
fi

# --- 14. A held lock -> LOCKED, target untouched ---------------------------------
H="$WORK/home-locked"
legacy_hermes "$H"
key="$(printf '%s' "$H/.hermes/plugins/ops" | sed 's/[^A-Za-z0-9._-]/_/g')"
mkdir -p "$H/.local/state/claude-ops/locks/$key.lock"
echo $$ >"$H/.local/state/claude-ops/locks/$key.lock/pid"
before="$(snapshot "$H/.hermes")"
out="$(run_sync "$H")"
rc=$?
if [[ $rc -eq 6 ]] && grep -q "LOCKED" <<<"$out" && [[ "$(snapshot "$H/.hermes")" == "$before" ]]; then
  ok "a lock held by a live run gives LOCKED (exit 6) and no writes"
else
  err "held lock -> LOCKED" "rc=$rc $(tr '\n' ' ' <<<"$out")"
fi
echo 999999 >"$H/.local/state/claude-ops/locks/$key.lock/pid"
out="$(run_sync "$H")"
rc=$?
[[ $rc -eq 0 ]] && grep -q "hermes  APPLIED" <<<"$out" && ok "a lock left by a dead pid is reclaimed" ||
  err "dead-pid lock reclaimed" "rc=$rc $(tr '\n' ' ' <<<"$out")"

# --- 15-17. Stubbed Grok + Cursor: first / middle / last failure ------------------
if [[ -z "$NODE_BIN" ]]; then
  err "node available for the multi-target cases" "node not on PATH"
else
  STUB="$WORK/stubs"
  mkdir -p "$STUB"
  ln -s "$NODE_BIN" "$STUB/node"
  cat >"$STUB/grok" <<'EOF'
#!/bin/bash
echo "grok $*" >>"$HOME/calls.log"
[[ -f "$HOME/grok-fail" ]] && { echo "network error"; exit 1; }
rsync -a --delete --exclude lib --exclude scripts "$OPS_FAKE_ROOT/" "$HOME/.grok/installed-plugins/claude-ops-0000/"
echo "updated ops"
EOF
  cat >"$STUB/cursor-agent" <<'EOF'
#!/bin/bash
echo "cursor-agent $*" >>"$HOME/calls.log"
EOF
  chmod +x "$STUB/grok" "$STUB/cursor-agent"
  world() {
    local h="$1"
    mkdir -p "$h/.grok/installed-plugins/claude-ops-0000/skills" "$h/.cursor/plugins/cache/ops-marketplace/ops/abc"
    printf '{"repos":{"claude-ops-0000":{"path":"%s","plugins":{"ops":{"version":"9.9.8"}}}}}\n' \
      "$h/.grok/installed-plugins/claude-ops-0000" >"$h/.grok/installed-plugins/registry.json"
    rsync -a --exclude lib --exclude scripts "$FAKE_ROOT/" "$h/.cursor/plugins/cache/ops-marketplace/ops/abc/"
    legacy_hermes "$h"
  }
  multi() {
    env -i PATH="$STUB:$BASE_PATH" HOME="$1" OPS_FAKE_ROOT="$FAKE_ROOT" bash "$SYNC" --record "$1/rec.jsonl" 2>&1
  }
  statuses() { python3 -c 'import json,sys; print(" ".join(json.loads(l)["target"]+"="+json.loads(l)["status"] for l in open(sys.argv[1])))' "$1/rec.jsonl"; }

  # first fails (grok), cursor already matches, hermes applies
  H="$WORK/multi-first"
  world "$H"
  touch "$H/grok-fail"
  out="$(multi "$H")"
  rc=$?
  st="$(statuses "$H")"
  if [[ $rc -eq 3 && "$st" == "grok=APPLY_FAILED cursor=MATCH codex=NOT_CONFIGURED hermes=APPLIED" ]]; then
    ok "first target fails: later targets still apply, exit 3"
  else
    err "first target fails" "rc=$rc $st"
  fi

  # middle fails (cursor drift -> UNSUPPORTED_SAFE_APPLY), first and last succeed
  H="$WORK/multi-middle"
  world "$H"
  printf 'drifted\n' >"$H/.cursor/plugins/cache/ops-marketplace/ops/abc/skills/ops/SKILL.md"
  out="$(multi "$H")"
  rc=$?
  st="$(statuses "$H")"
  if [[ $rc -eq 3 && "$st" == "grok=APPLIED cursor=UNSUPPORTED_SAFE_APPLY codex=NOT_CONFIGURED hermes=APPLIED" ]]; then
    ok "middle target fails: first and last keep their result, exit 3"
  else
    err "middle target fails" "rc=$rc $st $(tr '\n' ' ' <<<"$out")"
  fi
  if ! grep -q "cursor-agent" "$H/calls.log" 2>/dev/null && [[ "$(cat "$H/.cursor/plugins/cache/ops-marketplace/ops/abc/skills/ops/SKILL.md")" == "drifted" ]]; then
    ok "Cursor is never removed/re-added; its previous registration is kept"
  else
    err "Cursor untouched" "$(cat "$H/calls.log" 2>/dev/null | tr '\n' ' ')"
  fi

  # last fails (hermes ownership conflict), earlier ones succeed
  H="$WORK/multi-last"
  world "$H"
  printf 'x\n' >"$H/.hermes/plugins/ops/.ops-manifest"
  printf 'user\n' >"$H/.hermes/plugins/ops/__init__.py"
  out="$(multi "$H")"
  rc=$?
  st="$(statuses "$H")"
  if [[ $rc -eq 3 && "$st" == "grok=APPLIED cursor=MATCH codex=NOT_CONFIGURED hermes=OWNERSHIP_CONFLICT" ]]; then
    ok "last target fails: earlier targets keep their result, exit 3"
  else
    err "last target fails" "rc=$rc $st $(tr '\n' ' ' <<<"$out")"
  fi

  # lock keys: bash == node
  p="$WORK/some dir/with:odd+chars"
  b="$(printf '%s' "$p" | sed 's/[^A-Za-z0-9._-]/_/g')"
  n="$(OPS_P="$p" "$NODE_BIN" --input-type=module -e "const m = await import('$PLUGIN_ROOT/lib/parity/check.mjs'); console.log(m.lockKey(process.env.OPS_P))")"
  [[ "$b" == "$n" ]] && ok "bash and node compute the same lock key" || err "lock key parity" "bash=$b node=$n"
fi

# --- 18. Status table: bash == status.json ---------------------------------------
if python3 - "$PLUGIN_ROOT/lib/parity/status.json" "$(bash "$SCRIPT" --print-status-table)" <<'PY'; then
import json, sys
t = json.load(open(sys.argv[1]))
want = sorted([f"status {k} {v['class']}" for k, v in t["statuses"].items()] +
              [f"exit {k} {v}" for k, v in t["exit_codes"].items()])
got = sorted(l for l in sys.argv[2].splitlines() if l.strip())
assert want == got, set(want) ^ set(got)
PY
  ok "bash status/exit table equals lib/parity/status.json"
else
  err "bash status table equals status.json" "see diff above"
fi

# --- 19. Usage ----------------------------------------------------------------------
bash "$SCRIPT" --host nope >/dev/null 2>&1
[[ $? -eq 4 ]] && ok "an unknown --host is a usage error (exit 4)" || err "unknown host exit 4" "rc=$?"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
