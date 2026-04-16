#!/usr/bin/env bash
# ops-package.sh — MyParcel.nl shipping helper
# Subcommands: ship | label | track | list
# Auth: reads MYPARCEL_API_KEY from env, falls back to preferences.json /
#       Doppler. Never hardcode the key.
set -euo pipefail

PREFS="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
BASE_URL="https://api.myparcel.nl"

# ─── resolve key ──────────────────────────────────────────────────────────
resolve_key() {
  if [ -n "${MYPARCEL_API_KEY:-}" ]; then
    printf '%s' "$MYPARCEL_API_KEY"; return 0
  fi
  if [ -f "$PREFS" ]; then
    local k
    k=$(jq -r '.myparcel_api_key // empty' "$PREFS" 2>/dev/null)
    [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  fi
  if command -v doppler &>/dev/null; then
    local k
    k=$(doppler secrets get MYPARCEL_API_KEY --plain 2>/dev/null || true)
    [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  fi
  return 1
}

die_no_key() {
  cat >&2 <<EOF
ERROR: MYPARCEL_API_KEY not set.

  export MYPARCEL_API_KEY="<your-key>"

Get your key from https://backoffice.myparcel.nl → Settings → API.
Or store it in preferences.json under "myparcel_api_key", or in Doppler as MYPARCEL_API_KEY.
EOF
  exit 2
}

UA_HEADER="User-Agent: claude-ops/ops-package"

# Lazily resolve the key — only when a subcommand actually hits the API.
ensure_auth() {
  [ -n "${AUTH_HEADER:-}" ] && return 0
  API_KEY=$(resolve_key) || die_no_key
  AUTH_B64=$(printf '%s' "$API_KEY" | base64 | tr -d '\n')
  AUTH_HEADER="Authorization: basic $AUTH_B64"
}

# ─── helpers ──────────────────────────────────────────────────────────────

# parse_address "Name / Company, Street N, Postcode City, Country"
# Emits a jq-friendly JSON object on stdout.
parse_address() {
  local raw="$1"
  local person company street number number_suffix postcode city cc
  # Split on commas
  IFS=',' read -r p1 p2 p3 p4 <<<"$raw"
  p1=$(printf '%s' "${p1:-}" | sed -E 's/^ +//;s/ +$//')
  p2=$(printf '%s' "${p2:-}" | sed -E 's/^ +//;s/ +$//')
  p3=$(printf '%s' "${p3:-}" | sed -E 's/^ +//;s/ +$//')
  p4=$(printf '%s' "${p4:-}" | sed -E 's/^ +//;s/ +$//')

  # p1 can contain " / " splitting person and company
  if [[ "$p1" == *" / "* ]]; then
    person="${p1%% / *}"
    company="${p1##* / }"
  else
    person="$p1"
    company=""
  fi

  # p2 = "Street <number>[suffix]"
  # capture trailing number + optional suffix letters
  if [[ "$p2" =~ ^(.+[^[:space:]])[[:space:]]+([0-9]+)([A-Za-z]{0,4})$ ]]; then
    street="${BASH_REMATCH[1]}"
    number="${BASH_REMATCH[2]}"
    number_suffix="${BASH_REMATCH[3]}"
  else
    street="$p2"
    number=""
    number_suffix=""
  fi

  # p3 = "<postcode> <city>" (NL postcode = 4 digits + 2 letters, optional space)
  if [[ "$p3" =~ ^([0-9]{4}[[:space:]]?[A-Za-z]{2})[[:space:]]+(.+)$ ]]; then
    postcode=$(printf '%s' "${BASH_REMATCH[1]}" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
    city="${BASH_REMATCH[2]}"
  else
    # fallback: first token = postcode, rest = city
    postcode=$(printf '%s' "$p3" | awk '{print $1}')
    city=$(printf '%s' "$p3" | cut -d' ' -f2-)
  fi

  cc=$(printf '%s' "${p4:-NL}" | tr '[:lower:]' '[:upper:]' | sed -E 's/^ +//;s/ +$//')
  case "$cc" in
    NETHERLANDS|NEDERLAND|HOLLAND) cc=NL ;;
    BELGIUM|BELGIE|BELGIUM) cc=BE ;;
    GERMANY|DEUTSCHLAND) cc=DE ;;
    FRANCE) cc=FR ;;
  esac
  [ -z "$cc" ] && cc=NL

  jq -n \
    --arg person "$person" \
    --arg company "$company" \
    --arg street "$street" \
    --arg number "$number" \
    --arg number_suffix "$number_suffix" \
    --arg postcode "$postcode" \
    --arg city "$city" \
    --arg cc "$cc" \
    '{
      person: $person,
      company: ($company // ""),
      street: $street,
      number: $number,
      number_suffix: $number_suffix,
      postal_code: $postcode,
      city: $city,
      cc: $cc
    }'
}

# ─── subcommand: ship ─────────────────────────────────────────────────────
cmd_ship() {
  local to_raw="" from_raw="" weight="" pkg_type="1" signature="false" insurance="0" description="" pickup="false"
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) to_raw="$2"; shift 2 ;;
      --from) from_raw="$2"; shift 2 ;;
      --weight) weight="$2"; shift 2 ;;
      --package-type) pkg_type="$2"; shift 2 ;;
      --signature) signature="true"; shift ;;
      --insurance) insurance="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --pickup) pickup="true"; shift ;;
      *) echo "ship: unknown flag: $1" >&2; return 64 ;;
    esac
  done

  if [ -z "$to_raw" ]; then
    echo 'ship: --to is required, e.g. --to "Jane Doe, Kerkstraat 12A, 1011AB Amsterdam, NL"' >&2
    return 64
  fi

  local to_json; to_json=$(parse_address "$to_raw")

  # Build recipient block
  local recipient
  recipient=$(jq -n --argjson a "$to_json" '{
    cc: $a.cc,
    person: $a.person,
    company: (if $a.company == "" then null else $a.company end),
    street: $a.street,
    number: $a.number,
    number_suffix: (if $a.number_suffix == "" then null else $a.number_suffix end),
    postal_code: $a.postal_code,
    city: $a.city
  } | with_entries(select(.value != null))')

  # Sender — only include if provided. Otherwise MyParcel uses the account default.
  local sender_block='null'
  if [ -n "$from_raw" ]; then
    local from_json; from_json=$(parse_address "$from_raw")
    sender_block=$(jq -n --argjson a "$from_json" '{
      cc: $a.cc,
      person: $a.person,
      company: (if $a.company == "" then null else $a.company end),
      street: $a.street,
      number: $a.number,
      number_suffix: (if $a.number_suffix == "" then null else $a.number_suffix end),
      postal_code: $a.postal_code,
      city: $a.city
    } | with_entries(select(.value != null))')
  fi

  # options
  local options
  options=$(jq -n \
    --argjson pkg "$pkg_type" \
    --argjson sig "$(printf '%s' "$signature" | sed 's/true/1/;s/false/0/')" \
    --argjson ins "$insurance" \
    --arg desc "$description" \
    '{
      package_type: $pkg,
      signature: $sig,
      label_description: (if $desc == "" then null else $desc end),
      insurance: (if $ins > 0 then {amount: ($ins * 100), currency: "EUR"} else null end)
    } | with_entries(select(.value != null))')

  # physical_properties
  local phys='null'
  if [ -n "$weight" ]; then
    phys=$(jq -n --argjson w "$weight" '{weight: $w}')
  fi

  # pickup block
  local pickup_block='null'
  if [ "$pickup" = "true" ] && [ "$sender_block" != "null" ]; then
    pickup_block=$(jq -n --argjson s "$sender_block" '$s + {location_name: $s.company}')
  elif [ "$pickup" = "true" ]; then
    pickup_block=$(jq -n '{}')
  fi

  # Assemble shipment
  local shipment
  shipment=$(jq -n \
    --argjson recipient "$recipient" \
    --argjson sender "$sender_block" \
    --argjson options "$options" \
    --argjson phys "$phys" \
    --argjson pickup "$pickup_block" \
    '{
      recipient: $recipient,
      options: $options,
      carrier: 1,
      sender: (if $sender == null then null else $sender end),
      physical_properties: (if $phys == null then null else $phys end),
      pickup: (if $pickup == null then null else $pickup end)
    } | with_entries(select(.value != null))')

  local payload
  payload=$(jq -n --argjson s "$shipment" '{data: {shipments: [$s]}}')

  ensure_auth
  local resp
  resp=$(curl -sS -X POST "$BASE_URL/shipments" \
    -H "$AUTH_HEADER" \
    -H "$UA_HEADER" \
    -H "Content-Type: application/vnd.shipment+json;version=1.1;charset=utf-8" \
    -H "Accept: application/json;charset=utf-8" \
    --data-binary "$payload")

  local shipment_id
  shipment_id=$(printf '%s' "$resp" | jq -r '.data.ids[0].id // empty')
  if [ -z "$shipment_id" ]; then
    echo "ship: failed — response:" >&2
    printf '%s\n' "$resp" | jq . >&2 2>/dev/null || printf '%s\n' "$resp" >&2
    return 1
  fi

  jq -n --arg id "$shipment_id" --argjson resp "$resp" '{shipment_id: $id, response: $resp}'
}

# ─── subcommand: label ────────────────────────────────────────────────────
cmd_label() {
  local id="${1:-}"
  [ -z "$id" ] && { echo "label: shipment id required" >&2; return 64; }

  local out="/tmp/myparcel_label_${id}.pdf"
  local tmp_headers; tmp_headers=$(mktemp)
  ensure_auth
  curl -sS -D "$tmp_headers" -o "$out" \
    -H "$AUTH_HEADER" \
    -H "$UA_HEADER" \
    -H "Accept: application/pdf" \
    "$BASE_URL/shipment_labels/${id}?format=A4&positions=1"

  local ctype
  ctype=$(awk -F': *' 'tolower($1)=="content-type"{print tolower($2)}' "$tmp_headers" | tr -d '\r' | tail -1)
  rm -f "$tmp_headers"

  if [[ "$ctype" == application/pdf* ]]; then
    # Open only if interactive (Darwin)
    if [[ "$(uname)" == "Darwin" ]] && [ -t 1 ]; then
      open "$out" >/dev/null 2>&1 || true
    fi
    jq -n --arg p "$out" '{status: "ok", label_pdf: $p}'
  else
    # Not a PDF — likely payment_instructions JSON
    local body; body=$(cat "$out")
    local pay_url
    pay_url=$(printf '%s' "$body" | jq -r '.data.payment_instructions.payment_url // empty' 2>/dev/null)
    if [ -n "$pay_url" ]; then
      if [[ "$(uname)" == "Darwin" ]] && [ -t 1 ]; then
        open "$pay_url" >/dev/null 2>&1 || true
      fi
      jq -n --arg u "$pay_url" '{status: "payment_required", payment_url: $u}'
    else
      echo "label: unexpected response (content-type=$ctype):" >&2
      printf '%s\n' "$body" >&2
      rm -f "$out"
      return 1
    fi
    rm -f "$out"
  fi
}

# ─── subcommand: track ────────────────────────────────────────────────────
cmd_track() {
  local id="${1:-}"
  [ -z "$id" ] && { echo "track: shipment id required" >&2; return 64; }

  ensure_auth
  curl -sS \
    -H "$AUTH_HEADER" \
    -H "$UA_HEADER" \
    -H "Accept: application/json;charset=utf-8" \
    "$BASE_URL/shipments/${id}" \
  | jq '{
      id: .data.shipments[0].id,
      status: .data.shipments[0].status,
      barcode: .data.shipments[0].barcode,
      tracking_url: .data.shipments[0].tracking_url,
      recipient: .data.shipments[0].recipient,
      created: .data.shipments[0].created,
      updated: .data.shipments[0].modified
    }'
}

# ─── subcommand: list ─────────────────────────────────────────────────────
cmd_list() {
  ensure_auth
  curl -sS \
    -H "$AUTH_HEADER" \
    -H "$UA_HEADER" \
    -H "Accept: application/json;charset=utf-8" \
    "$BASE_URL/shipments?size=10&page=1" \
  | jq '[.data.shipments[] | {
      id,
      status,
      barcode,
      recipient: (.recipient.person + " — " + .recipient.city + " (" + .recipient.cc + ")"),
      created
    }]'
}

# ─── dispatch ─────────────────────────────────────────────────────────────
sub="${1:-}"; shift || true
case "$sub" in
  ship)  cmd_ship "$@" ;;
  label) cmd_label "$@" ;;
  track) cmd_track "$@" ;;
  list)  cmd_list "$@" ;;
  ""|-h|--help)
    cat <<EOF
ops-package.sh — MyParcel.nl shipping

Usage:
  ops-package.sh ship --to "<addr>" [--from "<addr>"] [--weight <g>]
                      [--package-type 1|2|3] [--signature] [--insurance <EUR>]
                      [--description "<text>"] [--pickup]
  ops-package.sh label <shipment-id>
  ops-package.sh track <shipment-id>
  ops-package.sh list

Address format:
  "Person / Company, Street 12A, 1011AB Amsterdam, NL"
  (company segment is optional — omit the "/ Company" part if none)

Env:
  MYPARCEL_API_KEY — required, plain (NOT base64). Script encodes it.
EOF
    ;;
  *) echo "ops-package.sh: unknown subcommand '$sub' (try ship|label|track|list)" >&2; exit 64 ;;
esac
