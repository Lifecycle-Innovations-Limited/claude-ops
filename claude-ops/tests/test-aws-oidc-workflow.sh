#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/aws-oidc-production-smoke.yml"

pass=0
fail=0

ok() {
  printf 'PASS: %s\n' "$1"
  pass=$((pass + 1))
}

bad() {
  printf 'FAIL: %s\n' "$1" >&2
  fail=$((fail + 1))
}

expect_fixed() {
  local description="$1"
  local pattern="$2"
  if grep -Fq -- "$pattern" "$WORKFLOW"; then
    ok "$description"
  else
    bad "$description"
  fi
}

expect_absent() {
  local description="$1"
  local pattern="$2"
  if grep -Fq -- "$pattern" "$WORKFLOW"; then
    bad "$description"
  else
    ok "$description"
  fi
}

expect_fixed "workflow can be run on demand" "workflow_dispatch:"
expect_fixed "OIDC token permission is present" "id-token: write"
expect_fixed "production environment limits the token subject" "environment: production"
expect_fixed "AWS credentials come from the pinned OIDC action" "uses: aws-actions/configure-aws-credentials@a03048d87541d1d9fcf2ecf528a4a65ba9bd7838 # v5.0.0"
expect_absent "AWS credentials action is not pinned to a mutable tag" "uses: aws-actions/configure-aws-credentials@v5"
expect_fixed "the role ARN comes from a repository variable" 'role-to-assume: ${{ vars.AWS_ROLE_TO_ASSUME }}'
expect_fixed "the log group comes from a repository variable" 'vars.AWS_SMOKE_LOG_GROUP'
expect_fixed "missing variables fail the job" "Set repository variable AWS_ROLE_TO_ASSUME"
expect_absent "no hardcoded account ARN" "arn:aws:iam::"
expect_absent "no literal log-group path" "--log-group-name /"
expect_absent "no static access key is referenced" 'secrets.AWS_ACCESS_KEY_ID'
expect_absent "no static secret key is referenced" 'secrets.AWS_SECRET_ACCESS_KEY'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
