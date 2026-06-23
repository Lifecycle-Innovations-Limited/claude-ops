#!/usr/bin/env bash
# test-claude-invoke.sh — unit tests for scripts/lib/claude-invoke.sh
#
# Tests:
#   T1: CLAUDE_OPS_USE_CREDIT_POOL unset  -> calls `claude` directly, upgrading Haiku to Sonnet
#   T2: CLAUDE_OPS_USE_CREDIT_POOL=0      -> calls `claude` directly, upgrading Haiku to Sonnet
#   T3: CLAUDE_OPS_USE_CREDIT_POOL=1      -> calls `node .../claude-p-as.mjs --` with sanitized args
#   T4: CLAUDE_OPS_USE_CREDIT_POOL=1 but wrapper missing -> falls back to `claude`, exits non-zero
#       (warning printed to stderr, direct claude called)
#   T5: direct invocation strips API-key env so CRS auth token wins
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
exit 0
SH
  chmod +x "$tmpdir/claude"

  # Stub node: records argv to a capture file and exits 0
  cat > "$tmpdir/node" <<'SH'
#!/usr/bin/env bash
echo "node $*" >> "$CAPTURE_FILE"
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
result=$(run_invoke -- -p --model haiku --no-session-persistence)
if [[ "$result" == "claude -p --model claude-sonnet-4-6 --no-session-persistence" ]]; then
  ok "called claude directly with correct args"
else
  err "expected 'claude -p --model claude-sonnet-4-6 --no-session-persistence', got: '$result'"
fi

# ---------------------------------------------------------------------------
# T2: gate=0 -> direct claude
# ---------------------------------------------------------------------------
echo "T2: gate=0 -> direct claude"
result=$(run_invoke CLAUDE_OPS_USE_CREDIT_POOL=0 -- -p --model haiku)
if [[ "$result" == "claude -p --model claude-sonnet-4-6" ]]; then
  ok "called claude directly with CREDIT_POOL=0"
else
  err "expected 'claude -p --model claude-sonnet-4-6', got: '$result'"
fi

# ---------------------------------------------------------------------------
# T3: gate=1 -> node .../claude-p-as.mjs -- <args>
# ---------------------------------------------------------------------------
echo "T3: gate=1 -> node ...claude-p-as.mjs -- <args>"
result=$(run_invoke CLAUDE_OPS_USE_CREDIT_POOL=1 -- -p --model haiku --no-session-persistence)
wrapper_path="$PLUGIN_ROOT/scripts/account-rotation/claude-p-as.mjs"
expected="node $wrapper_path -- -p --model claude-sonnet-4-6 --no-session-persistence"
if [[ "$result" == "$expected" ]]; then
  ok "routed through claude-p-as.mjs with correct args after --"
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
    claude_invoke -p --model haiku
  ) 2>&1 >/dev/null || true
)

fallback_result=$(cat "$capture_missing")
if [[ "$fallback_result" == "claude -p --model claude-sonnet-4-6" ]]; then
  ok "fell back to direct claude when wrapper missing"
else
  err "fallback: expected 'claude -p --model claude-sonnet-4-6', got: '$fallback_result'"
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
result=$(run_invoke ANTHROPIC_API_KEY=bad CLAUDE_API_KEY=bad CLAUDE_CODE_OAUTH_TOKEN=bad CAPTURE_ENV=1 -- -p --model sonnet)
if echo "$result" | grep -q "env api=unset claude_api=unset oauth=unset"; then
  ok "stripped conflicting API-key env"
else
  err "expected API-key env to be stripped, got: '$result'"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] && exit 0 || exit 1
