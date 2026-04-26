#!/usr/bin/env bash
# test-no-secrets.sh — Scans all files for leaked secrets/tokens/personal data
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Scanning for secrets and personal data in: $PLUGIN_ROOT"
echo ""

# Directories/files to exclude from scanning.
# NOTE: `tests/` is intentionally excluded from the MAIN sweep because test files
# legitimately assemble runtime patterns (e.g., regex literals matching `sk_live_`)
# that look identical to real secrets. A separate, narrower `tests/`-only sweep
# below flags ONLY high-confidence string-literal secrets in tests.
EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  "tests"
)

build_exclude_args() {
  local args=()
  for d in "${EXCLUDE_DIRS[@]}"; do
    args+=("--exclude-dir=$d")
  done
  echo "${args[@]}"
}

EXCLUDE_ARGS=$(build_exclude_args)

# Helper: scan for a pattern, return matches (excluding placeholder/example patterns)
scan_pattern() {
  local label="$1"
  local pattern="$2"
  local allow_pattern="${3:-}"  # optional grep -v pattern for allowed false positives

  local results
  # shellcheck disable=SC2086
  results=$(grep -rE "$pattern" $EXCLUDE_ARGS \
    --include="*.sh" --include="*.md" --include="*.json" \
    --include="*.toml" --include="*.ts" --include="*.js" \
    --include="*.mjs" --include="*.yaml" --include="*.yml" \
    --include="*.env" --include="*.txt" \
    "$PLUGIN_ROOT" 2>/dev/null || true)

  # Filter out example/placeholder lines
  results=$(echo "$results" | grep -vE "(example|placeholder|your[-_]|<[A-Z_]+>|\[YOUR_|TODO|REPLACE|fake|dummy|test-token|sk_test_EXAMPLE)" || true)

  # Apply additional allowlist if provided
  if [[ -n "$allow_pattern" && -n "$results" ]]; then
    results=$(echo "$results" | grep -vE "$allow_pattern" || true)
  fi

  # Remove empty lines
  results=$(echo "$results" | grep -v "^$" || true)

  if [[ -n "$results" ]]; then
    local count
    count=$(echo "$results" | wc -l | tr -d ' ')
    err "$label" "$count match(es) found"
    echo "$results" | head -5 | sed 's/^/    /'
    return 1
  else
    ok "no $label found"
    return 0
  fi
}

# Stripe secret keys
scan_pattern "Stripe secret keys (sk_live_)" 'sk_live_[a-zA-Z0-9]{20,}'

# Stripe publishable keys
scan_pattern "Stripe publishable keys (pk_live_)" 'pk_live_[a-zA-Z0-9]{20,}'

# Shopify tokens
scan_pattern "Shopify tokens (shppa_, shpca_, shpat_)" 'shp(pa|ca|at)_[a-zA-Z0-9]{20,}'

# Slack tokens
scan_pattern "Slack tokens (xoxb-, xoxp-)" 'xox[bp]-[0-9]+-[a-zA-Z0-9-]+'

# Google API keys
scan_pattern "Google API keys (AIza)" 'AIza[0-9A-Za-z_-]{35}'

# GitHub tokens
scan_pattern "GitHub tokens (ghp_, gho_, ghs_)" 'gh[phos]_[a-zA-Z0-9]{36,}'

# Generic secret key patterns
scan_pattern "generic secret key patterns (gsk_)" 'gsk_[a-zA-Z0-9]{20,}'

# OpenAI tokens
scan_pattern "OpenAI tokens (sk-)" 'sk-[a-zA-Z0-9]{40,}' 'sk-\*|sk-proj-\*|sk-test'

# Personal email addresses (project-domain.ai, specific domains)
scan_pattern "project-specific email addresses" '[a-zA-Z0-9._%+-]+@project-domain\.ai' \
  '(abeeha|example|your-|<[A-Z]|\[|\]|#.*@)'

# AWS secret patterns
scan_pattern "AWS secret access keys" '(?i)aws.{0,20}secret.{0,20}[A-Za-z0-9/+=]{40}'

# Generic high-entropy tokens with common prefixes
scan_pattern "org_ prefixed tokens (often API keys)" 'org_[a-zA-Z0-9]{20,}'

# --- Tests-only narrow sweep ---
# We allow regex literals + assembled patterns in tests/ but flag anything that
# looks like a literal high-value secret embedded in a test file.
scan_tests_literal() {
  local label="$1"
  local pattern="$2"
  local results
  results=$(grep -rE "$pattern" \
    --include="*.sh" --include="*.ts" --include="*.js" --include="*.mjs" \
    "$PLUGIN_ROOT/tests" 2>/dev/null || true)
  # Strip lines where the pattern is wrapped in single/double quotes followed by
  # regex meta (`{`, `[`, `+`, `*`) — those are pattern definitions, not secrets.
  results=$(echo "$results" | grep -vE "['\"][a-z_]+_(\[|\\\\|\{|\+|\*)" || true)
  results=$(echo "$results" | grep -vE "(example|placeholder|your[-_]|<[A-Z_]+>|\[YOUR_|TODO|REPLACE|fake|dummy|test-token|sk_test_EXAMPLE)" || true)
  results=$(echo "$results" | grep -v "^$" || true)
  if [[ -n "$results" ]]; then
    local count
    count=$(echo "$results" | wc -l | tr -d ' ')
    err "tests/ literal $label" "$count match(es)"
    echo "$results" | head -3 | sed 's/^/    /'
  else
    ok "no tests/ literal $label"
  fi
}

scan_tests_literal "Stripe sk_live_" 'sk_live_[a-zA-Z0-9]{24,}'
scan_tests_literal "GitHub ghp_" 'ghp_[a-zA-Z0-9]{36,}'
scan_tests_literal "Slack xoxb-" 'xoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{20,}'

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  echo "ACTION: Remove or rotate any real secrets found above."
  exit 1
fi
exit 0
