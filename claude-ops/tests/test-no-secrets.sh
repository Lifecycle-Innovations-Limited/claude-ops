#!/usr/bin/env bash
# test-no-secrets.sh — Scans all files for leaked secrets/tokens/personal data
set -euo pipefail

# pwd -P, not pwd: `git rev-parse --show-toplevel` returns a physical path, and
# comparing it against a logical one silently matches nothing under a symlinked
# checkout — the sweep then reports PASS over an empty file list.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

pass=0
skipped=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }
# A check that could not run is neither PASS nor FAIL. Counting it as PASS is how
# a gate silently stops gating; SKIP keeps the summary honest.
skip() { echo "  SKIP: $1"; skipped=$((skipped+1)); }

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

# The list of tracked files to sweep, one path per line in a temp file.
#
# Why this exists: the sweeps below used `grep -r --include=*.ext`, which silently
# skipped every tracked file whose extension was not on the list — 320 of 1044
# files (30%), including all 122 extensionless `bin/*` executables, all 88 `.py`,
# and every .tsx/.service/.timer/.plist. Proved by injecting a home path into
# `bin/ops-doctor`: the suite reported 27 passed. The same string in a .md failed
# immediately. Driving the sweep from `git ls-files` means a new file type is
# covered the day it is added, with no list to maintain.
#
# The list lives in a FILE, not a variable: bash discards NUL bytes inside
# command substitution (with only a warning), so a NUL-separated list collapses
# into one concatenated path and grep silently matches nothing — a fix that looks
# like it works and gates nothing. Paths here contain no newlines, so line-based
# is safe and verifiable.
TRACKED_FILE="$(mktemp -t ops-no-secrets-tracked.XXXXXX)"
USE_TRACKED=0
build_tracked_list() {
  local root_git filter rel
  root_git="$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -z "$root_git" ]] && return 1
  filter="$(printf '%s\n' "${EXCLUDE_DIRS[@]}" | paste -sd '|' -)"
  (cd "$root_git" && git ls-files) \
    | grep -vE "(^|/)($filter)/" \
    | while IFS= read -r rel; do
        case "$root_git/$rel" in
          "$PLUGIN_ROOT"/*) printf '%s\n' "$root_git/$rel" ;;
        esac
      done > "$TRACKED_FILE"
  [[ -s "$TRACKED_FILE" ]]
}
if build_tracked_list; then
  USE_TRACKED=1
else
  skip "tracked-file sweep unavailable (not a git checkout)"
fi

# The three structural checks below sweep a WIDER list than the rest of this
# file: they include `tests/`, which EXCLUDE_DIRS drops. A client UUID pasted
# into a test fixture is a leak like any other, and the scanner's own directory
# being the one unscanned place is exactly the kind of hole this file exists to
# close. Only the four files that must be able to quote the shapes they forbid
# are exempt, by exact path: this script, its allowlist, and the two
# negative-control suites whose whole job is to plant a forbidden value and
# prove the gate refuses it. Per path, never per directory.
TRACKED_ALL_FILE="$(mktemp -t ops-no-secrets-all.XXXXXX)"
trap 'rm -f "$TRACKED_FILE" "$TRACKED_ALL_FILE"' EXIT
build_tracked_all_list() {
  local root_git rel
  root_git="$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -z "$root_git" ]] && return 1
  (cd "$root_git" && git ls-files) \
    | grep -vE '(^|/)(node_modules|\.git|\.claude|\.worktrees)/' \
    | grep -vE '(^|/)tests/(test-no-secrets\.sh|known-public-constants\.txt|test-pii-gate-fires\.sh|test-pre-commit-hook-blocks\.sh)$' \
    | while IFS= read -r rel; do
        case "$root_git/$rel" in
          "$PLUGIN_ROOT"/*) printf '%s\n' "$root_git/$rel" ;;
        esac
      done > "$TRACKED_ALL_FILE"
  [[ -s "$TRACKED_ALL_FILE" ]]
}
build_tracked_all_list || : > "$TRACKED_ALL_FILE"

# grep over every tracked file INCLUDING tests/, regardless of extension.
grep_tracked_all() {
  [[ -s "$TRACKED_ALL_FILE" ]] || return 0
  tr '\n' '\0' < "$TRACKED_ALL_FILE" | xargs -0 grep -IE "$@" 2>/dev/null || true
}

# grep over every tracked file, regardless of extension.
grep_tracked() {
  [[ "$USE_TRACKED" == "1" ]] || return 0
  # xargs -a keeps the file list out of the argv of this shell.
  tr '\n' '\0' < "$TRACKED_FILE" | xargs -0 grep -IE "$@" 2>/dev/null || true
}

# Helper: scan for a pattern, return matches (excluding placeholder/example patterns)
scan_pattern() {
  local label="$1"
  local pattern="$2"
  local allow_pattern="${3:-}"  # optional grep -v pattern for allowed false positives

  local results
  # shellcheck disable=SC2086
  results=$(grep_tracked "$pattern")

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
  '(APP_STORE_CONNECT_APP_IDS|[A-Z][A-Z0-9_]*_ASC_[A-Z_]*APP_ID|APP_IDS|appId).{0,80}["'\''][0-9]{9,12}["'\'']' \
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

# === Third-party identifiers (2026-09-09) ===
#
# Every identity check below this point until now was denylist-driven, and a
# denylist can only hold the OPERATOR's own terms. That is not a tuning gap, it
# is structural: nobody can enumerate a client's workspace UUIDs, team keys, or
# issue ids in advance, so no denylist will ever contain them. The consequence
# was ten of one client's Linear UUIDs, their team key in ~25 places plus a
# filename, and a set of their real issue ids sitting in a public repo while the
# scanner reported PASS.
#
# So these three checks invert the rule. They need no operator configuration and
# they never SKIP: an identifier-shaped literal FAILS unless it is listed in
# tests/known-public-constants.txt with a stated reason. Adding a client's id
# then requires arguing for it in a diff, which is the behaviour we want.

CONSTANTS_FILE="$PLUGIN_ROOT/tests/known-public-constants.txt"
allowed_constants() {
  # $1 = prefix ("uuid" or "issue-prefix"); prints one allowed value per line.
  [[ -f "$CONSTANTS_FILE" ]] || return 0
  grep -E "^$1:" "$CONSTANTS_FILE" 2>/dev/null | sed "s/^$1://" | grep -vE '^\s*$' || true
}

# --- UUID literals must be published vendor constants ---
# A UUID in source is either a public constant or somebody's private identifier,
# and the two are indistinguishable by shape. Default to refusing it.
third_party_uuid_check() {
  # Deliberately NOT gated on USE_TRACKED: the narrow list drops tests/, so a
  # tree whose only files live there would skip this check entirely. And a skip
  # here is an error, not a neutral outcome — there is no legitimate run of this
  # suite without a git file list, so refusing to run means refusing to gate.
  if [[ ! -s "$TRACKED_ALL_FILE" ]]; then
    err "UUID literal check could not run" \
      "no git file list — this check cannot be skipped; run the suite inside the checkout"
    return
  fi
  local allow hits
  allow=$(allowed_constants uuid)
  # A UUID whose first two groups are all zeroes is a hand-written fixture, not
  # anybody's identifier — that shape cannot be produced by a UUID generator.
  # This covers the plain nil UUID and counters like
  # 00000000-0000-4000-8000-000000000001 that test files use for ordering.
  hits=$(grep_tracked_all -oH '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' \
    | grep -viE ':(0{8}-0{4}|1{8}-1{4})-' || true)
  # Drop the documented constants. -F -x on the captured value only, so a real
  # id that merely CONTAINS an allowed one still fails.
  if [[ -n "$allow" && -n "$hits" ]]; then
    hits=$(echo "$hits" | awk -F: -v OFS=: '{v=$NF; print v"\t"$0}' \
      | grep -vFf <(echo "$allow") | cut -f2- || true)
  fi
  hits=$(echo "$hits" | grep -v '^$' || true)
  if [[ -n "$hits" ]]; then
    local count; count=$(echo "$hits" | wc -l | tr -d ' ')
    err "undocumented UUID literal(s)" \
      "$count match(es) — a third party's id belongs in the environment (docs/LOCAL-PREFS.md); a public vendor constant belongs in tests/known-public-constants.txt with a reason"
    echo "$hits" | head -5 | sed 's/^/    /'
  else
    ok "no undocumented UUID literals ($(echo "$allow" | grep -c . || true) documented)"
  fi
}
third_party_uuid_check

# --- Issue-tracker keys must use a neutral prefix ---
# A key like `<CLIENT>-1141` names one organisation's Linear workspace as
# surely as their
# hostname would. The placeholder is TEAM-<n>, from $LINEAR_CLIENT_TEAM_KEY.
third_party_issue_key_check() {
  if [[ ! -s "$TRACKED_ALL_FILE" ]]; then
    err "issue-tracker key check could not run" \
      "no git file list — this check cannot be skipped; run the suite inside the checkout"
    return
  fi
  local allow alt hits
  allow=$(allowed_constants issue-prefix)
  hits=$(grep_tracked_all -oH '\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}\b' || true)
  if [[ -n "$allow" ]]; then
    # Anchor on the captured token so `HEATEAM-1` cannot ride in on `TEAM`.
    alt=$(echo "$allow" | sed 's/[.[\*^$()+?{|]/\\&/g' | paste -sd '|' -)
    hits=$(echo "$hits" | grep -vE ":($alt)-[0-9]{1,6}$" || true)
  fi
  hits=$(echo "$hits" | grep -v '^$' || true)
  if [[ -n "$hits" ]]; then
    local count; count=$(echo "$hits" | wc -l | tr -d ' ')
    err "third-party issue-tracker key(s)" \
      "$count match(es) — use TEAM-<n> and read the real key from \$LINEAR_CLIENT_TEAM_KEY"
    echo "$hits" | head -5 | sed 's/^/    /'
  else
    ok "no third-party issue-tracker keys"
  fi
}
third_party_issue_key_check

# --- Operator locale must not be baked into code ---
# An IANA zone in a script says where the operator lives. Prose may name zones
# as examples (the setup guide lists several), so this covers executables and
# config only, and allows a zone that sits next to its own env-var default.
operator_timezone_check() {
  if [[ ! -s "$TRACKED_ALL_FILE" ]]; then
    err "timezone check could not run" \
      "no git file list — this check cannot be skipped; run the suite inside the checkout"
    return
  fi
  local code_list hits
  code_list="$(mktemp -t ops-no-secrets-code.XXXXXX)"
  grep -vE '\.(md|txt|mdx)$' "$TRACKED_ALL_FILE" > "$code_list" || true
  if [[ -s "$code_list" ]]; then
    hits=$(tr '\n' '\0' < "$code_list" | xargs -0 grep -InE \
      '\b(Africa|America|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z_]+' 2>/dev/null \
      | grep -vE '(OPS_TZ|TZ:-|TIMEZONE|timeZone|Etc/UTC|Europe/Asia)' || true)
  fi
  rm -f "$code_list"
  hits=$(echo "${hits:-}" | grep -v '^$' || true)
  if [[ -n "$hits" ]]; then
    local count; count=$(echo "$hits" | wc -l | tr -d ' ')
    err "hardcoded IANA timezone(s) in code/config" \
      "$count site(s) — express schedules in UTC and read the display zone from \$OPS_TZ"
    echo "$hits" | head -5 | sed 's/^/    /'
  else
    ok "no hardcoded operator timezone in code/config"
  fi
}
operator_timezone_check

# --- User preferences must never be tracked ---
# Preferences hold the operator's own identity, contacts, and channel config.
# .gitignore alone is not a guard: a file already tracked stays tracked, and
# `git add -f` bypasses it. This asserts the actual git index, which is the
# thing that ends up public.
prefs_tracked_check() {
  local tracked
  tracked=$(git -C "$PLUGIN_ROOT" ls-files 2>/dev/null | grep -iE \
    '(^|/)(preferences|ops-prefs|ops\.local|contact-registry|daemon-health|daemon-services|pii-denylist)\.(json|txt)$|(^|/)registry\.json$|\.local\.json$' \
    | grep -vE '\.(example|template|sample)\.json$|/registry\.templates/' || true)
  if [[ -n "$tracked" ]]; then
    local count; count=$(echo "$tracked" | wc -l | tr -d ' ')
    err "user preference file(s) tracked in git" "$count file(s) — move to \$PREFS_PATH or \$HOME/.config and git rm --cached"
    echo "$tracked" | head -5 | sed 's/^/    /'
  else
    ok "no user preference files tracked in git"
  fi
}
prefs_tracked_check

# --- Skills must not write preferences into the repo ---
# A skill that writes prefs next to its own source will commit the operator's
# identity on the next `git add -A`. Preferences go to the plugin data dir.
prefs_write_target_check() {
  local bad
  bad=$(grep -rnE '>[[:space:]]*"?\$?\{?(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|REPO_ROOT)\}?/[^"]*(preferences|prefs|registry)\.json' \
    $EXCLUDE_ARGS --include="*.sh" --include="*.mjs" --include="*.js" --include="*.py" \
    "$PLUGIN_ROOT" 2>/dev/null || true)
  if [[ -n "$bad" ]]; then
    local count; count=$(echo "$bad" | wc -l | tr -d ' ')
    err "preference written into the repo tree" "$count site(s) — write to \$PREFS_PATH instead"
    echo "$bad" | head -5 | sed 's/^/    /'
  else
    ok "no preference writes target the repo tree"
  fi
}
prefs_write_target_check

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
    # A check that verifies nothing must not report PASS. In CI there is no
    # operator denylist to load, so this branch is the normal CI path: report it
    # as SKIP so nobody reads "27 passed" as "identity was checked". Set
    # OPS_PII_DENYLIST_REQUIRED=1 (or run with a denylist) to make it a failure.
    if [[ "${OPS_PII_DENYLIST_REQUIRED:-0}" == "1" ]]; then
      err "operator identity denylist not configured" \
        "OPS_PII_DENYLIST_REQUIRED=1 but no denylist found"
      return
    fi
    skip "operator identity denylist NOT CHECKED (no denylist configured — set \$OPS_PII_DENYLIST or .pii-denylist)"
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

# --- Operator identity in tracked FILENAMES ---
# A content grep can never see this: a brand or personal name in a path leaks the
# same fact as one in a line. Found in the wild — a tracked asset filename carried
# the operator's company name while every content check reported PASS.
identity_filename_check() {
  local file="" terms=""
  for cand in "${OPS_PII_DENYLIST_FILE:-}" "$PLUGIN_ROOT/.pii-denylist" \
              "$PLUGIN_ROOT/../.pii-denylist" "$HOME/.config/claude-ops/pii-denylist.txt"; do
    [[ -n "$cand" && -f "$cand" ]] && { file="$cand"; break; }
  done
  [[ -n "$file" ]] && terms="$(grep -vE '^[[:space:]]*(#|$)' "$file" 2>/dev/null || true)"
  if [[ -n "${OPS_PII_DENYLIST:-}" ]]; then
    terms+=$'\n'"$(echo "$OPS_PII_DENYLIST" | tr ',[:space:]' '\n\n')"
  fi
  terms=$(echo "$terms" | grep -vE '^[[:space:]]*$' | sort -u || true)
  if [[ -z "$terms" ]]; then
    skip "operator identity in filenames NOT CHECKED (no denylist configured)"
    return
  fi
  if [[ "$USE_TRACKED" != "1" || ! -s "$TRACKED_ALL_FILE" ]]; then
    skip "operator identity in filenames NOT CHECKED (no tracked-file list)"
    return
  fi
  # Match REPO-RELATIVE paths only. The absolute path contains the checkout
  # location — which on a developer machine includes their own username, a live
  # denylist term — so scanning absolute paths flags every file in the repo.
  # That is a property of where the clone sits, not of what is committed.
  local hits
  hits=$(sed "s|^$PLUGIN_ROOT/||" "$TRACKED_FILE" \
    | grep -iF -f <(echo "$terms") 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    local count; count=$(echo "$hits" | wc -l | tr -d ' ')
    err "operator identity term(s) in tracked filename(s)" "$count path(s)"
    echo "$hits" | head -5 | sed 's/^/    /'
  else
    ok "no operator identity terms in tracked filenames"
  fi
}
identity_filename_check

echo ""
echo "---"
if [[ "${skipped:-0}" -gt 0 ]]; then
  echo "Results: $pass passed, $fail failed, $skipped skipped (a SKIP verified nothing)"
else
  echo "Results: $pass passed, $fail failed"
fi
echo ""

if (( fail > 0 )); then
  echo "ACTION: Remove or rotate any real secrets found above."
  exit 1
fi
exit 0
