#!/usr/bin/env bash
# scripts/lib/stripe-revenue.sh — normalized Stripe revenue pulls per project
#
# Public functions:
#   stripe_revenue_7d <project>            — 7-day revenue, MRR, UTM breakdown
#   stripe_revenue_all_projects            — fan out across configured projects
#
# Sourcing convention:
#   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   . "${PLUGIN_ROOT}/lib/registry-path.sh"
#   . "${PLUGIN_ROOT}/scripts/lib/stripe-revenue.sh"
#
# Contract:
#   - All HTTP via `curl -sS --max-time 12 ...`. Every function returns 0.
#   - Missing key -> echo `null`.
#   - PUBLIC REPO: no hardcoded project names / tokens.
#
# Requires: bash, jq, curl. doppler optional (used by resolve_cred for doppler: refs).

[ -n "${_STRIPE_REVENUE_LOADED:-}" ] && return 0
_STRIPE_REVENUE_LOADED=1

set -u

_STRIPE_REV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${_STRIPE_REV_DIR}/ga4-resolve.sh"

_stripe_prefs_path() {
  printf '%s' "${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
}

# ── _stripe_resolve_key <project> ─────────────────────────────────────────────
# Resolution order:
#   1) marketing.projects.<p>.stripe.secret_key (via resolve_cred — env/doppler/literal)
#   2) Doppler key STRIPE_<PROJECT_UPPER>_SECRET_KEY (from any project/config the doppler CLI is configured for)
#   3) Doppler key STRIPE_<PROJECT_UPPER>_API_SECRET_KEY
# Echoes the key (or empty if none).
_stripe_resolve_key() {
  local proj="${1:-}"
  [ -z "$proj" ] && return 0

  local prefs; prefs="$(_stripe_prefs_path)"
  local key=""

  if [ -f "$prefs" ]; then
    local ref
    ref="$(_prefs_marketing "$proj" "stripe" "secret_key")"
    if [ -n "$ref" ] && [ "$ref" != "null" ]; then
      key="$(resolve_cred "$ref" 2>/dev/null || true)"
    fi
  fi

  if [ -n "$key" ]; then
    printf '%s' "$key"
    return 0
  fi

  # Doppler fallbacks. Project upper, dashes -> underscores.
  local upper
  upper="$(printf '%s' "$proj" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"

  if command -v doppler >/dev/null 2>&1; then
    key="$(doppler secrets get "STRIPE_${upper}_SECRET_KEY" --plain 2>/dev/null || true)"
    if [ -n "$key" ] && [ "$key" != "null" ]; then
      printf '%s' "$key"
      return 0
    fi
    key="$(doppler secrets get "STRIPE_${upper}_API_SECRET_KEY" --plain 2>/dev/null || true)"
    if [ -n "$key" ] && [ "$key" != "null" ]; then
      printf '%s' "$key"
      return 0
    fi
  fi

  # Final env fallback.
  local env_a="STRIPE_${upper}_SECRET_KEY" env_b="STRIPE_${upper}_API_SECRET_KEY"
  if [ -n "${!env_a:-}" ]; then printf '%s' "${!env_a}"; return 0; fi
  if [ -n "${!env_b:-}" ]; then printf '%s' "${!env_b}"; return 0; fi
}

# ── stripe_revenue_7d <project> ───────────────────────────────────────────────
stripe_revenue_7d() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local key
  key="$(_stripe_resolve_key "$proj" 2>/dev/null || true)"
  if [ -z "$key" ]; then
    printf 'null'
    return 0
  fi

  local now seven_days_ago
  now="$(date +%s)"
  seven_days_ago=$((now - 7 * 86400))

  # ── Charges (last 7d) ──
  local charges_resp
  charges_resp="$(curl -sS --max-time 12 -G "https://api.stripe.com/v1/charges" \
    --data-urlencode "created[gte]=${seven_days_ago}" \
    --data-urlencode "limit=100" \
    -u "${key}:" 2>/dev/null || echo '{}')"

  # Error check.
  local err_type
  err_type="$(printf '%s' "$charges_resp" | jq -r '.error.type // empty' 2>/dev/null || true)"
  if [ -n "$err_type" ]; then
    printf 'null'
    return 0
  fi

  local revenue_cents charge_count refund_count currency
  revenue_cents="$(printf '%s' "$charges_resp" | jq '[.data[]? | select(.status == "succeeded") | .amount // 0] | add // 0' 2>/dev/null || echo 0)"
  charge_count="$(printf '%s' "$charges_resp" | jq '[.data[]? | select(.status == "succeeded")] | length' 2>/dev/null || echo 0)"
  refund_count="$(printf '%s' "$charges_resp" | jq '[.data[]? | select(.refunded == true)] | length' 2>/dev/null || echo 0)"
  currency="$(printf '%s' "$charges_resp" | jq -r '.data[0].currency // "usd"' 2>/dev/null || echo 'usd')"

  # ── UTM breakdown ──
  # Group by metadata.utm_source (case-insensitive). Build [{utm_source,revenue,count}].
  local by_utm
  by_utm="$(printf '%s' "$charges_resp" | jq -c '
    [.data[]?
      | select(.status == "succeeded")
      | {
          utm_source: ((.metadata.utm_source // .metadata.UTM_SOURCE // "") | ascii_downcase),
          amount: (.amount // 0)
        }
      | select(.utm_source != "")
    ]
    | group_by(.utm_source)
    | map({
        utm_source: .[0].utm_source,
        revenue: ((map(.amount) | add // 0) / 100 | . * 100 | round / 100 | tostring),
        count: length
      })
  ' 2>/dev/null || echo '[]')"
  [ -z "$by_utm" ] && by_utm='[]'

  # ── Subscriptions (active) → MRR ──
  local subs_resp
  subs_resp="$(curl -sS --max-time 12 -G "https://api.stripe.com/v1/subscriptions" \
    --data-urlencode "status=active" \
    --data-urlencode "limit=100" \
    -u "${key}:" 2>/dev/null || echo '{}')"

  # MRR: for each subscription, sum items.data[].price.unit_amount * items.data[].quantity,
  # then normalize to monthly based on price.recurring.interval.
  local active_mrr_cents active_sub_count
  active_mrr_cents="$(printf '%s' "$subs_resp" | jq '
    def per_month(unit; qty; interval; count):
      (unit * qty) as $line
      | (count // 1) as $ic
      | if interval == "month" then ($line / $ic)
        elif interval == "year" then ($line / 12 / $ic)
        elif interval == "week" then ($line * 52 / 12 / $ic)
        elif interval == "day" then ($line * 30 / $ic)
        else 0
        end;
    [
      .data[]?
      | .items.data[]? as $it
      | per_month(
          ($it.price.unit_amount // 0);
          ($it.quantity // 1);
          ($it.price.recurring.interval // "month");
          ($it.price.recurring.interval_count // 1)
        )
    ] | add // 0 | round
  ' 2>/dev/null || echo 0)"
  active_sub_count="$(printf '%s' "$subs_resp" | jq '[.data[]?] | length' 2>/dev/null || echo 0)"

  jq -nc \
    --arg p "$proj" \
    --argjson rev_cents "$revenue_cents" \
    --argjson cnt "$charge_count" \
    --argjson refunds "$refund_count" \
    --argjson mrr_cents "$active_mrr_cents" \
    --argjson sub_cnt "$active_sub_count" \
    --argjson utm "$by_utm" \
    --arg ccy "$currency" '
    {
      surface: "stripe",
      project: $p,
      revenue_7d: (($rev_cents / 100) * 100 | round / 100 | tostring),
      charge_count: $cnt,
      refund_count: $refunds,
      active_mrr: (($mrr_cents / 100) * 100 | round / 100 | tostring),
      active_sub_count: $sub_cnt,
      by_utm_source: $utm,
      window_days: 7,
      currency: $ccy
    }
  ' 2>/dev/null || printf 'null'
}

# ── stripe_revenue_all_projects ───────────────────────────────────────────────
stripe_revenue_all_projects() {
  local prefs; prefs="$(_stripe_prefs_path)"
  if [ ! -f "$prefs" ]; then
    printf '[]'
    return 0
  fi

  # Enumerate marketing.projects.* — include those with EITHER:
  #   - marketing.projects.<p>.stripe.secret_key declared in prefs, OR
  #   - any other entry under marketing.projects.<p>.* (fallback: try Doppler key lookup).
  local projects
  projects="$(jq -r '.marketing.projects // {} | keys[]?' "$prefs" 2>/dev/null || true)"

  local results=()
  local p out
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    out="$(stripe_revenue_7d "$p" 2>/dev/null || printf 'null')"
    [ -z "$out" ] && out="null"
    if [ "$out" != "null" ]; then
      results+=("$out")
    fi
  done <<EOF
${projects}
EOF

  if [ ${#results[@]} -eq 0 ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "${results[@]}" | jq -sc '.' 2>/dev/null || printf '[]'
}
