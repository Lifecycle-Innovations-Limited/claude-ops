#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/aws-usage-cost.sh"

grep -q 'FINOPS_DOPPLER_PROJECT' "$SCRIPT"
grep -q 'AccessDenied.*not authorized.*Unable to locate credentials' "$SCRIPT"
grep -q 'doppler run --project' "$SCRIPT"
grep -q 'cat "$err" >&2' "$SCRIPT"

echo "aws usage helper fallback and truthful-error contract: ok"