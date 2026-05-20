#!/usr/bin/env bash
set -euo pipefail

# ops-marketing-auth-prewarm.sh
# Scans all Doppler projects + env + keychain for marketing credentials
# and writes a structured cache for /ops:marketing setup auto-linking.
#
# Env:
#   OPS_DATA_DIR        - override cache dir (default: ~/.claude/plugins/data/ops-ops-marketplace)
#   OPS_PREWARM_DRY_RUN - if set to 1, print output to stderr only (no file write)

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
OUTPUT_FILE="$DATA_DIR/marketing-auth-prewarm.json"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── category regex patterns ────────────────────────────────────────────────────
MARKETING_PATTERN='KLAVIYO|META_|FACEBOOK|INSTAGRAM|TIKTOK|LINKEDIN|REDDIT|BING|APPLOVIN|TWITTER|PINTEREST|SNAPCHAT|YOUTUBE|GOOGLE_ADS|GADS|GA4|MEASUREMENT_PROTOCOL|GSC|SEARCH_CONSOLE|AHREFS|APOLLO|RESEND|MAILCHIMP|SENDGRID|POSTMARK|MAILGUN|CUSTOMER_IO|CUSTOMERIO|BRAZE|ITERABLE|SHOPIFY|RECHARGE|SHIPBOB|SHIPSTATION|HUBSPOT|SEGMENT|MIXPANEL|AMPLITUDE|POSTHOG|APPSFLYER|ADJUST|BRANCH_IO|SINGULAR|TWILIO|MAILERLITE|CONVERTKIT|ACTIVECAMPAIGN|TYPEFORM|CALENDLY|SALESFORCE|PIPEDRIVE|INTERCOM|ZENDESK|RUDDERSTACK|PLAUSIBLE|UMAMI|FATHOM|TRIPLEWHALE|NORTHBEAM|DUB_API|STRIPE_|SENTRY_AUTH|LINEAR_API|VERCEL_TOKEN|CLOUDFLARE_API_TOKEN'

# ── classify key → category ───────────────────────────────────────────────────
classify_key() {
  local key="${1^^}"  # uppercase
  case "$key" in
    *META_*|*FACEBOOK*|*INSTAGRAM*)           echo "ads_meta" ;;
    *GOOGLE_ADS*|*GADS*|*GA4*|*MEASUREMENT_PROTOCOL*|*GSC*|*SEARCH_CONSOLE*|*YOUTUBE*) echo "analytics_ga4" ;;
    *TIKTOK*)                                 echo "ads_tiktok" ;;
    *LINKEDIN*)                               echo "ads_linkedin" ;;
    *REDDIT*)                                 echo "ads_reddit" ;;
    *PINTEREST*)                              echo "ads_pinterest" ;;
    *BING*|*MICROSOFT*)                       echo "ads_microsoft" ;;
    *APPLOVIN*|*SNAPCHAT*|*TWITTER*)          echo "ads_other" ;;
    *SEGMENT*|*RUDDERSTACK*)                  echo "analytics_segment" ;;
    *MIXPANEL*)                               echo "analytics_mixpanel" ;;
    *AMPLITUDE*)                              echo "analytics_amplitude" ;;
    *POSTHOG*|*PLAUSIBLE*|*UMAMI*|*FATHOM*)  echo "analytics_posthog" ;;
    *RESEND*)                                 echo "email_resend" ;;
    *KLAVIYO*)                                echo "email_klaviyo" ;;
    *MAILCHIMP*)                              echo "email_mailchimp" ;;
    *SENDGRID*)                               echo "email_sendgrid" ;;
    *POSTMARK*)                               echo "email_postmark" ;;
    *MAILGUN*)                                echo "email_mailgun" ;;
    *CUSTOMER_IO*|*CUSTOMERIO*)               echo "email_customerio" ;;
    *BRAZE*)                                  echo "email_braze" ;;
    *ITERABLE*)                               echo "email_iterable" ;;
    *MAILERLITE*|*CONVERTKIT*|*ACTIVECAMPAIGN*) echo "email_other" ;;
    *TWILIO*)                                 echo "sms_twilio" ;;
    *STRIPE_*)                                echo "payments_stripe" ;;
    *SHOPIFY*)                                echo "ecommerce_shopify" ;;
    *RECHARGE*)                               echo "ecommerce_recharge" ;;
    *SHIPBOB*)                                echo "fulfillment_shipbob" ;;
    *SHIPSTATION*)                            echo "fulfillment_shipstation" ;;
    *HUBSPOT*)                                echo "crm_hubspot" ;;
    *SALESFORCE*)                             echo "crm_salesforce" ;;
    *PIPEDRIVE*)                              echo "crm_pipedrive" ;;
    *INTERCOM*)                               echo "crm_intercom" ;;
    *ZENDESK*)                                echo "support_zendesk" ;;
    *APPSFLYER*)                              echo "mta_appsflyer" ;;
    *ADJUST*)                                 echo "mta_adjust" ;;
    *BRANCH_IO*)                              echo "mta_branch" ;;
    *SINGULAR*)                               echo "mta_singular" ;;
    *SENTRY_AUTH*)                            echo "errors_sentry" ;;
    *LINEAR_API*)                             echo "issues_linear" ;;
    *CLOUDFLARE_API_TOKEN*)                   echo "infra_cloudflare" ;;
    *VERCEL_TOKEN*)                           echo "infra_vercel" ;;
    *AHREFS*)                                 echo "seo_ahrefs" ;;
    *APOLLO*)                                 echo "prospect_apollo" ;;
    *TYPEFORM*|*CALENDLY*)                    echo "tools_forms" ;;
    *TRIPLEWHALE*|*NORTHBEAM*|*DUB_API*)     echo "analytics_attribution" ;;
    *)                                        echo "_unmatched" ;;
  esac
}

# ── extract project hint from doppler project name + key name ─────────────────
extract_project_hint() {
  local doppler_project="$1"
  local key="$2"
  local key_lower="${key,,}"
  local proj_lower="${doppler_project,,}"

  # strip common suffixes/prefixes from doppler project name to get product hint
  # e.g. "healify-api" → "healify", "claude-ops" → "claude-ops"
  local base_project
  base_project=$(echo "$proj_lower" | sed 's/-api$//' | sed 's/-backend$//' | sed 's/-frontend$//' | sed 's/-web$//' | sed 's/-app$//')

  # look for product name embedded in the key itself
  # e.g. META_HEALIFY_ACCESS_TOKEN → healify
  local known_products=("healify" "alwaysbright" "stagery" "inboxassist" "fiberinternet" "shannon" "talktoyourhouse" "claude-ops" "claudeops")
  for prod in "${known_products[@]}"; do
    local prod_stripped="${prod//-/}"
    if echo "$key_lower" | grep -qi "$prod_stripped"; then
      echo "$prod_stripped"
      return
    fi
  done

  # fall back to base doppler project name
  echo "$base_project"
}

# ── accumulate entries into a temp JSON lines file ────────────────────────────
TMP_ENTRIES="$(mktemp)"
trap 'rm -f "$TMP_ENTRIES"' EXIT

append_entry() {
  local source="$1"
  local doppler_project="$2"
  local config="$3"
  local key="$4"
  local category
  local project_hint
  category=$(classify_key "$key")
  project_hint=$(extract_project_hint "$doppler_project" "$key")
  printf '%s\n' "{\"source\":\"$source\",\"doppler_project\":\"$doppler_project\",\"config\":\"$config\",\"key\":\"$key\",\"category\":\"$category\",\"project\":\"$project_hint\"}" >> "$TMP_ENTRIES"
}

# ── 1. Doppler scan ───────────────────────────────────────────────────────────
DOPPLER_PROJECTS_SCANNED=0

if command -v doppler &>/dev/null; then
  projects_json=$(doppler projects --json 2>/dev/null || echo "[]")
  mapfile -t project_slugs < <(echo "$projects_json" | jq -r '.[].id // .[].slug' 2>/dev/null || true)

  DOPPLER_PROJECTS_SCANNED="${#project_slugs[@]}"

  for slug in "${project_slugs[@]}"; do
    echo "[prewarm] scanning doppler: $slug" >&2
    secrets_json=$(doppler secrets --project "$slug" --config prd --json 2>/dev/null || true)
    if [[ -z "$secrets_json" || "$secrets_json" == "null" ]]; then
      continue
    fi
    # extract key names that match the pattern
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      append_entry "doppler" "$slug" "prd" "$key"
    done < <(echo "$secrets_json" | jq -r 'keys[]' 2>/dev/null | grep -iE "$MARKETING_PATTERN" || true)
  done
else
  echo "[prewarm] doppler CLI not found — skipping Doppler scan" >&2
fi

# ── 2. Environment variables scan ────────────────────────────────────────────
echo "[prewarm] scanning environment variables" >&2
while IFS= read -r line; do
  key="${line%%=*}"
  [[ -z "$key" ]] && continue
  append_entry "env" "_env" "" "$key"
done < <(printenv | grep -iE "^[A-Z_]*($MARKETING_PATTERN)[A-Z_0-9]*=" || true)

# ── 3. Shell profiles scan ────────────────────────────────────────────────────
echo "[prewarm] scanning shell profiles" >&2
profile_files=("$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.envrc")
for profile in "${profile_files[@]}"; do
  [[ -f "$profile" ]] || continue
  while IFS= read -r line; do
    # match export KEY=... or KEY=...
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)= ]]; then
      key="${BASH_REMATCH[2]}"
      if echo "$key" | grep -qiE "$MARKETING_PATTERN"; then
        append_entry "profile" "$(basename "$profile")" "" "$key"
      fi
    fi
  done < "$profile"
done

# ── 4. macOS Keychain scan ────────────────────────────────────────────────────
if command -v security &>/dev/null && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[prewarm] scanning keychain" >&2
  # known marketing tool service names in keychain
  keychain_services=(
    "klaviyo" "meta" "facebook" "tiktok" "linkedin" "google-ads"
    "shopify" "stripe" "hubspot" "salesforce" "segment" "mixpanel"
    "amplitude" "twilio" "sendgrid" "mailchimp" "resend" "postmark"
    "intercom" "zendesk" "appsflyer" "adjust" "branch.io" "sentry"
    "linear" "vercel" "cloudflare" "ahrefs" "apollo"
  )
  for svc in "${keychain_services[@]}"; do
    result=$(security find-generic-password -s "$svc" 2>/dev/null || true)
    if [[ -n "$result" ]]; then
      # derive a synthetic key name from service
      synthetic_key="${svc^^}"
      synthetic_key="${synthetic_key//-/_}"
      synthetic_key="${synthetic_key//./_}"
      synthetic_key="${synthetic_key}_TOKEN"
      append_entry "keychain" "_keychain" "" "$synthetic_key"
    fi
  done
fi

# ── 5. GCP service account / OAuth JSON scan ──────────────────────────────────
if [[ -d "$HOME/.gcp" ]]; then
  echo "[prewarm] scanning ~/.gcp/*.json" >&2
  while IFS= read -r gcp_file; do
    file_type=$(jq -r '.type // "unknown"' "$gcp_file" 2>/dev/null || echo "unknown")
    project_id=$(jq -r '.project_id // .client_id // "unknown"' "$gcp_file" 2>/dev/null || echo "unknown")
    key="GCP_${file_type^^}_${project_id^^}"
    key="${key// /_}"
    key="${key//-/_}"
    if echo "$key" | grep -qiE "OAUTH|SERVICE_ACCOUNT|GA4|GOOGLE"; then
      append_entry "gcp_json" "$(basename "$gcp_file")" "" "GCP_OAUTH_CLIENT"
    fi
  done < <(find "$HOME/.gcp" -name "*.json" -maxdepth 3 2>/dev/null || true)
fi

# ── build output JSON ─────────────────────────────────────────────────────────
echo "[prewarm] building output JSON" >&2

# read all entries (newline-delimited JSON objects) and build by_project + by_category
# wrap the NDJSON into a JSON array first, then process
output_json=$(
  (echo '['; sed '$!s/$/,/' "$TMP_ENTRIES"; echo ']') 2>/dev/null \
  | jq --arg gen "$GENERATED_AT" --argjson scanned "$DOPPLER_PROJECTS_SCANNED" '
    . as $all |

    # by_project: {project: {category: [{source,doppler_project,config,key}]}}
    (
      $all | group_by(.project) |
      [.[] | {
        key: .[0].project,
        value: (
          group_by(.category) |
          [.[] | {
            key: .[0].category,
            value: [.[] | {source, doppler_project, config, key}]
          }] | from_entries
        )
      }] | from_entries
    ) as $by_project |

    # by_category: {category: {project: count}}
    (
      $all | group_by(.category) |
      [.[] | {
        key: .[0].category,
        value: (
          group_by(.project) |
          [.[] | {key: .[0].project, value: length}] | from_entries
        )
      }] | from_entries
    ) as $by_category |

    {
      generated_at: $gen,
      doppler_projects_scanned: $scanned,
      by_project: $by_project,
      by_category: $by_category
    }
  ' 2>/dev/null \
  || echo '{"error":"jq build failed","generated_at":"'"$GENERATED_AT"'","doppler_projects_scanned":'"$DOPPLER_PROJECTS_SCANNED"',"by_project":{},"by_category":{}}'
)

# ── write or dry-run ──────────────────────────────────────────────────────────
if [[ "${OPS_PREWARM_DRY_RUN:-0}" == "1" ]]; then
  echo "[prewarm] DRY RUN — output:" >&2
  echo "$output_json" >&2
else
  mkdir -p "$DATA_DIR"
  echo "$output_json" > "$OUTPUT_FILE"
  echo "[prewarm] wrote $OUTPUT_FILE" >&2
  category_count=$(echo "$output_json" | jq '.by_category | length' 2>/dev/null || echo 0)
  echo "[prewarm] categories found: $category_count" >&2
fi
