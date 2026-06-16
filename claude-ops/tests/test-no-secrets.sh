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
  ".claude"
  ".worktrees"
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

# === Owner / personal PII (added 2026-06-07) ===
# This class — a contributor's macOS username, personal email addresses, home
# paths, and an internal AWS account id — leaked into history before there was a
# gate for it. These checks fail CI if any of it reappears in the tree.
# Allowlists keep generic placeholders (user, <user>, $HOME, runner) and the
# project's own public maintainer contact (info@lifecycleinnovations.limited).

# macOS home-directory paths with a real-looking username
scan_pattern "macOS home paths (/Users/<name>)" '/Users/[a-z][a-zA-Z0-9_.-]+' \
  '/Users/(user|username|users|you|your[-_]?user|runner|shared|example|admin)([/"'\''[:space:]]|$)|/Users/[<$\{]'

# Linux home-directory paths with a real-looking username
scan_pattern "Linux home paths (/home/<name>)" '/home/[a-z][a-zA-Z0-9_.-]+/' \
  '/home/(user|username|users|you|your[-_]?user|runner|ubuntu|ec2-user|ops|node|app|shared|example)/|/home/[<$\{]'

# Personal / webmail email addresses
scan_pattern "personal webmail addresses" \
  '[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|proton|protonmail|hey)\.(com|net|org|me)' \
  '@(example|test|localhost|noreply|anthropic)\.|\b(your|your\.address|youremail|someone|somebody|you|me|name|firstname|lastname|user|username|first\.last)@'

# Owner brand-domain personal emails (the specific domains that leaked)
scan_pattern "owner brand-domain emails" \
  '[a-zA-Z0-9._%+-]+@(account-a|account-main|account-records|example)\.[a-z.]+'

# AWS account IDs embedded in ARNs (12 digits)
scan_pattern "AWS account IDs (ARN context)" \
  'arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}:' \
  '(:000000000000:|:123456789012:)'

# Bare AWS account IDs OUTSIDE ARN context — a real 12-digit id leaked in a
# bucket name, "account <id>" prose, or a config value. Restricted to lines that
# mention account/bucket/aws/arn so we don't flag every 12-digit number; allows
# the canonical docs placeholders and all-zero. (Closes the gap where a real id
# in `claude-account-leases-<id>` or `account <id>` slipped past the ARN check.)
scan_pattern "bare AWS account IDs (account/bucket context)" \
  '([Aa]ccount|[Bb]ucket|aws|AWS|arn).{0,40}\b[0-9]{12}\b|\b[0-9]{12}\b.{0,40}([Aa]ccount|[Bb]ucket)' \
  '(123456789012|000000000000|111111111111|[0-9]{13,})'

# App Store Connect account identifiers and numeric app IDs. These are not
# secrets alone, but they identify a real app/account and must be supplied by
# local env/config for this public plugin.
scan_pattern "App Store Connect issuer UUID literals" \
  '(APP_STORE_CONNECT_ISSUER_ID|ISSUER_ID|issuer).{0,80}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' \
  '(example|placeholder|00000000-0000-0000-0000-000000000000|<)'

scan_pattern "App Store Connect numeric app ID literals" \
  '(APP_STORE_CONNECT_APP_IDS|HEALIFY_ASC_[A-Z_]*APP_ID|APP_IDS|appId).{0,80}["'\''][0-9]{9,12}["'\'']' \
  '(example|placeholder|<)'

scan_pattern "hardcoded sentry-cli org values" \
  'sentry-cli.{0,120}--org[ =]["'\'']?[A-Za-z0-9_-]+' \
  '(SENTRY_ORG|example|placeholder|<)'

# International phone numbers (allow reserved example ranges: 555-xxxx, 1234567, all-zero)
scan_pattern "phone numbers (+<cc><digits>)" '\+[1-9][0-9]{1,3}[ -]?[0-9]{6,14}' \
  '(555[0-9]{4}|1234567|\+1234567890|\+0000000000|\+15551234567|\+10000000000|\+1[ -]?555)'

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

# --- Operator identity denylist (OUT-OF-REPO) ---
# A public scanner cannot hardcode the operator's own brand names, personal
# names, or private hostnames — that list would itself be the PII it's meant to
# block. Instead, load denylist terms from a gitignored / out-of-repo file so
# each operator can block THEIR identity terms without committing them.
#
# Sources (first found wins), one term per line, '#' comments allowed:
#   $OPS_PII_DENYLIST_FILE
#   ./.pii-denylist            (gitignored — repo-local, never committed)
#   $HOME/.config/claude-ops/pii-denylist.txt
# Or inline via $OPS_PII_DENYLIST (comma/space/newline separated).
identity_denylist_check() {
  local file="" terms=""
  for cand in "${OPS_PII_DENYLIST_FILE:-}" "$PLUGIN_ROOT/.pii-denylist" \
              "$PLUGIN_ROOT/../.pii-denylist" "$HOME/.config/claude-ops/pii-denylist.txt"; do
    [[ -n "$cand" && -f "$cand" ]] && { file="$cand"; break; }
  done
  if [[ -n "$file" ]]; then
    terms+=$'\n'"$(grep -vE '^\s*(#|$)' "$file" 2>/dev/null || true)"
  fi
  if [[ -n "${OPS_PII_DENYLIST:-}" ]]; then
    terms+=$'\n'"$(echo "$OPS_PII_DENYLIST" | tr ',[:space:]' '\n\n')"
  fi
  terms=$(echo "$terms" | grep -vE '^\s*$' | sort -u || true)
  if [[ -z "$terms" ]]; then
    ok "operator identity denylist (none configured — set \$OPS_PII_DENYLIST or .pii-denylist to enable)"
    return
  fi
  local alt
  alt=$(echo "$terms" | sed 's/[.[\*^$()+?{|]/\\&/g' | paste -sd '|' -)
  local hits
  hits=$(grep -riE "$alt" $EXCLUDE_ARGS \
    --include="*.sh" --include="*.md" --include="*.json" --include="*.toml" \
    --include="*.ts" --include="*.js" --include="*.mjs" --include="*.py" \
    --include="*.yaml" --include="*.yml" --include="*.env" --include="*.txt" \
    --include="*.prompt" --include="*.service" --include="*.plist" \
    "$PLUGIN_ROOT" 2>/dev/null | grep -vE "(example|placeholder|your[-_]|<[A-Z_]+>)" || true)
  if [[ -n "$hits" ]]; then
    local count; count=$(echo "$hits" | wc -l | tr -d ' ')
    err "operator identity term(s) leaked" "$count match(es) for configured denylist"
    echo "$hits" | head -5 | sed 's/^/    /'
  else
    ok "no operator identity terms (denylist: $(echo "$terms" | wc -l | tr -d ' ') term(s))"
  fi
}
identity_denylist_check

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  echo "ACTION: Remove or rotate any real secrets found above."
  exit 1
fi
exit 0
