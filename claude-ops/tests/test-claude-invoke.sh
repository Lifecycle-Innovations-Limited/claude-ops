#!/usr/bin/env bash
# test-claude-invoke.sh — unit tests for scripts/lib/claude-invoke.sh
#
# Tests:
#   T1: CLAUDE_OPS_USE_CREDIT_POOL unset  -> calls `claude` directly, preserving args
#   T2: CLAUDE_OPS_USE_CREDIT_POOL=0      -> calls `claude` directly, preserving args
#   T3: CLAUDE_OPS_USE_CREDIT_POOL=1      -> calls `node .../claude-p-as.mjs --` with the telegram disable prepended
#   T4: CLAUDE_OPS_USE_CREDIT_POOL=1 but wrapper missing -> falls back to `claude`, exits non-zero
#       (warning printed to stderr, direct claude called)
#   T5: direct invocation strips API-key env so the OAuth credential wins
NO_TG='{"enabledPlugins":{"telegram@claude-plugins-official":false}}'
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$PLUGIN_ROOT/scripts/lib/claude-invoke.sh"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# ---------------------------------------------------------------------------
# Helpers — build a temp dir with stub binaries for each test
# ---------------------------------------------------------------------------

make_stubs() {
  local tmpdir="$1"
  # Stub claude: records argv to a capture file and exits 0
  cat > "$tmpdir/claude" <<'SH'
#!/usr/bin/env bash
if [[ "${CAPTURE_ENV:-0}" = "1" ]]; then
  echo "env api=${ANTHROPIC_API_KEY-unset} claude_api=${CLAUDE_API_KEY-unset} oauth=${CLAUDE_CODE_OAUTH_TOKEN-unset}" >> "$CAPTURE_FILE"
fi
echo "claude $*" >> "$CAPTURE_FILE"
if [[ "$1" == --settings && -f "$2" ]]; then cat "$2" >> "$CAPTURE_FILE"; fi
exit 0
SH
  chmod +x "$tmpdir/claude"

  # Stub node: records argv to a capture file and exits 0
  cat > "$tmpdir/node" <<'SH'
#!/usr/bin/env bash
echo "node $*" >> "$CAPTURE_FILE"
if [[ "$3" == --settings && -f "$4" ]]; then cat "$4" >> "$CAPTURE_FILE"; fi
exit 0
SH
  chmod +x "$tmpdir/node"
}

run_invoke() {
  # Runs claude_invoke in a clean subshell with PATH restricted to stubs.
  # Args: env-var assignments (as separate args), then -- then claude_invoke args.
  local env_args=()
  while [[ "$1" != "--" ]]; do
    env_args+=("$1")
    shift
  done
  shift  # consume --

  local tmpdir capture
  tmpdir="$(mktemp -d)"
  capture="$(mktemp)"
  trap 'rm -rf "$tmpdir" "$capture"' RETURN

  make_stubs "$tmpdir"

  # Run in a subshell: set env, prepend stubs to PATH, source helper, call claude_invoke
  (
    export PATH="$tmpdir:$PATH"
    export CAPTURE_FILE="$capture"
    unset CLAUDE_OPS_USE_CREDIT_POOL
    unset ANTHROPIC_API_KEY
    unset CLAUDE_API_KEY
    unset CLAUDE_CODE_OAUTH_TOKEN
    for kv in "${env_args[@]:-}"; do
      export "$kv"
    done
    # Point PLUGIN_ROOT at the real plugin so wrapper resolution works
    export PLUGIN_ROOT="$PLUGIN_ROOT"
    export CLAUDE_OPS_ROOT="$PLUGIN_ROOT"
    # shellcheck source=../scripts/lib/claude-invoke.sh
    . "$HELPER"
    claude_invoke "$@"
  ) 2>/dev/null || true

  cat "$capture"
}

# ---------------------------------------------------------------------------
# T1: gate unset -> direct claude
# ---------------------------------------------------------------------------
echo "T1: gate unset -> direct claude"
result=$(run_invoke -- -p --model custom-model --no-session-persistence)
expected="claude --settings $NO_TG -p --model custom-model --no-session-persistence"
if [[ "$result" == "$expected" ]]; then
  ok "called claude directly without rewriting model args"
else
  err "expected '$expected', got: '$result'"
fi

# ---------------------------------------------------------------------------
# T2: gate=0 -> direct claude
# ---------------------------------------------------------------------------
echo "T2: gate=0 -> direct claude"
result=$(run_invoke CLAUDE_OPS_USE_CREDIT_POOL=0 -- -p --model custom-model)
expected="claude --settings $NO_TG -p --model custom-model"
if [[ "$result" == "$expected" ]]; then
  ok "called claude directly with CREDIT_POOL=0"
else
  err "expected '$expected', got: '$result'"
fi

# ---------------------------------------------------------------------------
# T3: gate=1 -> node .../claude-p-as.mjs -- <args>
# ---------------------------------------------------------------------------
echo "T3: gate=1 -> node ...claude-p-as.mjs -- <args>"
result=$(run_invoke CLAUDE_OPS_USE_CREDIT_POOL=1 -- -p --model custom-model --no-session-persistence)
wrapper_path="$PLUGIN_ROOT/scripts/account-rotation/claude-p-as.mjs"
expected="node $wrapper_path -- --settings $NO_TG -p --model custom-model --no-session-persistence"
if [[ "$result" == "$expected" ]]; then
  ok "routed through claude-p-as.mjs with telegram plugin disabled"
else
  err "expected: '$expected'"
  err "     got: '$result'"
fi

# ---------------------------------------------------------------------------
# T4: gate=1, wrapper missing -> warning to stderr, falls back to claude
# ---------------------------------------------------------------------------
echo "T4: gate=1, wrapper missing -> fallback to claude"
tmpdir_missing="$(mktemp -d)"
capture_missing="$(mktemp)"
trap 'rm -rf "$tmpdir_missing" "$capture_missing"' EXIT

make_stubs "$tmpdir_missing"

stderr_out=$(
  (
    export PATH="$tmpdir_missing:$PATH"
    export CAPTURE_FILE="$capture_missing"
    export CLAUDE_OPS_USE_CREDIT_POOL=1
    # Point to a non-existent root so wrapper lookup fails
    export CLAUDE_OPS_ROOT="/nonexistent-root-$$"
    unset PLUGIN_ROOT
    # shellcheck source=../scripts/lib/claude-invoke.sh
    . "$HELPER"
    claude_invoke -p --model custom-model
  ) 2>&1 >/dev/null || true
)

fallback_result=$(cat "$capture_missing")
expected_fallback="claude --settings $NO_TG -p --model custom-model"
if [[ "$fallback_result" == "$expected_fallback" ]]; then
  ok "fell back to direct claude when wrapper missing"
else
  err "fallback: expected '$expected_fallback', got: '$fallback_result'"
fi
if echo "$stderr_out" | grep -q "WARNING"; then
  ok "emitted WARNING to stderr"
else
  err "no WARNING in stderr output: '$stderr_out'"
fi

# ---------------------------------------------------------------------------
# T5: direct invocation strips API-key env
# ---------------------------------------------------------------------------
echo "T5: direct claude strips conflicting API-key env"
result=$(run_invoke ANTHROPIC_API_KEY=bad CLAUDE_API_KEY=bad CLAUDE_CODE_OAUTH_TOKEN=bad CAPTURE_ENV=1 -- -p --model custom-model)
if echo "$result" | grep -q "env api=unset claude_api=unset oauth=unset"; then
  ok "stripped conflicting API-key env"
else
  err "expected API-key env to be stripped, got: '$result'"
fi

# Settings regression: the CLI consumes only the last additional document.
settings='{"env":{"AUTH_MODE":"oauth"},"hooks":{"PreToolUse":[{"matcher":"Bash"}]},"enabledPlugins":{"other@test":true,"telegram@claude-plugins-official":true}}'
settings_file="$tmpdir_missing/caller settings.json"
printf '%s' "$settings" > "$settings_file"
for gate in 0 1; do
  for form in inline file equals; do
    case "$form" in
      inline) args=(--settings "$settings");;
      file) args=(--settings "$settings_file");;
      equals) args=("--settings=$settings");;
    esac
    result=$(run_invoke CLAUDE_OPS_USE_CREDIT_POOL="$gate" -- -p "${args[@]}" --model custom-model)
    if [[ "$result" == *'"AUTH_MODE":"oauth"'* && "$result" == *'"PreToolUse"'* && "$result" == *'"other@test":true'* && "$result" == *'"telegram@claude-plugins-official":false'* && "$result" != *'"telegram@claude-plugins-official":true'* ]]; then
      ok "settings $form gate=$gate preserves OAuth, infra hook and other plugins"
    else
      err "settings $form gate=$gate lost composition: $result"
    fi
  done
done

# Exercise the account wrapper's pure argument builder, never its auth/ledger CLI.
node --input-type=module - "$PLUGIN_ROOT" "$settings_file" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, unlinkSync, statSync } from 'node:fs';
const [root, file] = process.argv.slice(2);
const { headlessArgs } = await import(pathToFileURL(`${root}/scripts/account-rotation/claude-p-as.mjs`));
const original = readFileSync(file, 'utf8');
const input = JSON.parse(original);
for (const flags of [['--settings', original], ['--settings', file], [`--settings=${original}`], [`--settings=${file}`]]) {
  const args = headlessArgs(['-p', ...flags, '--model', 'custom-model']);
  assert.equal(args.filter(a => a === '--settings' || a.startsWith('--settings=')).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(args[1], 'utf8')), {...input, enabledPlugins: {...input.enabledPlugins, 'telegram@claude-plugins-official': false}});
  assert.equal(statSync(args[1]).mode & 0o777, 0o600);
  assert.equal(args.join(' ').includes('AUTH_MODE'), false);
  unlinkSync(args[1]);
  assert.deepEqual(args.slice(2), ['-p', '--model', 'custom-model']);
}
assert.equal(readFileSync(file, 'utf8'), original, 'caller file remains unchanged');
assert.throws(() => headlessArgs(['--settings']), /requires a value/);
assert.throws(() => headlessArgs(['--settings', '{invalid}']), /settings/);
assert.deepEqual(headlessArgs(['--', '--settings', 'literal']).slice(2), ['--', '--settings', 'literal']);
console.log('Account wrapper settings composition: PASS (inline/file/equals, invalid, separator, file unchanged)');
JS

python3 -I "$PLUGIN_ROOT/tests/test-settings-transaction.py"
python3 -I "$PLUGIN_ROOT/tests/test-settings-transaction-crash.py"
node "$PLUGIN_ROOT/tests/test-router-crash-owner.mjs"
node "$PLUGIN_ROOT/tests/test-settings-os-lock.mjs"
node "$PLUGIN_ROOT/tests/test-settings-crash-recovery.mjs"
node "$PLUGIN_ROOT/tests/test-job-settings-concurrency.mjs"
node "$PLUGIN_ROOT/tests/test-settings-signal-group.mjs"
node "$PLUGIN_ROOT/tests/test-job-settings-security.mjs"
python3 -I "$PLUGIN_ROOT/tests/test-pocket-settings-context.py"
node "$PLUGIN_ROOT/tests/test-job-settings-lifecycle.mjs"
node "$PLUGIN_ROOT/tests/test-headless-settings-privacy.mjs"
node "$PLUGIN_ROOT/tests/test-headless-router-settings.mjs"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] && exit 0 || exit 1
