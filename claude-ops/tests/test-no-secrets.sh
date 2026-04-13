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

# Directories/files to exclude from scanning
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

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  echo "ACTION: Remove or rotate any real secrets found above."
  exit 1
fi
exit 0
