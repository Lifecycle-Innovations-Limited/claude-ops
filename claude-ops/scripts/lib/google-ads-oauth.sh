#!/usr/bin/env bash
# google-ads-oauth.sh — Google Ads OAuth helper for ops-marketing-provision.
#
# Exports:
#   gads_authorize_url <client_id> <redirect_uri>
#       → echoes the full authorization URL to send the user through Google.
#
#   gads_localhost_capture <port> <timeout_seconds>
#       → starts a tiny Node HTTP server in the background, blocks until the
#         OAuth callback hits, echoes the captured `code` param to stdout,
#         then exits. Returns non-zero if the timeout elapses or Node is missing.
#
#   gads_exchange_code <code> <client_id> <client_secret> <redirect_uri>
#       → POSTs to https://oauth2.googleapis.com/token to exchange the
#         authorization code for { access_token, refresh_token, ... }.
#         Echoes the full JSON response.
#
#   gads_refresh_access_token <refresh_token> <client_id> <client_secret>
#       → POSTs grant_type=refresh_token to get a fresh access_token.
#         Echoes the access token (string only, no JSON).
#
#   gads_list_accessible_customers <access_token> <developer_token> [login_customer_id]
#       → GETs /v24/customers:listAccessibleCustomers. Echoes JSON response.
#
#   gads_get_customer_info <customer_id> <access_token> <developer_token> [login_customer_id]
#       → GETs /v24/customers/<id>:search with the customer.manager field so
#         the caller can decide whether to set login-customer-id for sub-calls.
#         Echoes JSON response.
#
# Endpoints validated against:
#   - Google OIDC discovery doc (accounts.google.com/.well-known/openid-configuration)
#   - Google Ads API OAuth Internals (developers.google.com/google-ads/api/docs/oauth/internals)
#   - List Accessible Customers v24 (developers.google.com/google-ads/api/docs/account-management/listing-accounts)
#
# All functions are side-effect-free except gads_localhost_capture which binds
# port 8080 by default. Caller is responsible for credentials (no secrets logged).

set -u

# ---------------------------------------------------------------------------
# Canonical endpoints (validated via openid-configuration on 2026-05-20)
# ---------------------------------------------------------------------------
GADS_AUTH_ENDPOINT="${GADS_AUTH_ENDPOINT:-https://accounts.google.com/o/oauth2/v2/auth}"
GADS_TOKEN_ENDPOINT="${GADS_TOKEN_ENDPOINT:-https://oauth2.googleapis.com/token}"
GADS_API_BASE="${GADS_API_BASE:-https://googleads.googleapis.com/v24}"
GADS_SCOPE="${GADS_SCOPE:-https://www.googleapis.com/auth/adwords}"

# ---------------------------------------------------------------------------
# gads_authorize_url <client_id> [redirect_uri]
# ---------------------------------------------------------------------------
gads_authorize_url() {
  local client_id="$1"
  local redirect_uri="${2:-http://localhost:8080}"
  local encoded_scope
  encoded_scope=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$GADS_SCOPE" 2>/dev/null \
    || printf '%s' "$GADS_SCOPE" | sed 's|:|%3A|g; s|/|%2F|g')
  printf '%s?client_id=%s&redirect_uri=%s&response_type=code&scope=%s&access_type=offline&prompt=consent' \
    "$GADS_AUTH_ENDPOINT" \
    "$client_id" \
    "$redirect_uri" \
    "$encoded_scope"
}

# ---------------------------------------------------------------------------
# gads_localhost_capture <port> <timeout_seconds>
# Blocks until OAuth callback is received or timeout elapses.
# Echoes the `code` query param on success; non-zero exit on failure.
# ---------------------------------------------------------------------------
gads_localhost_capture() {
  local port="${1:-8080}"
  local timeout="${2:-120}"

  command -v node >/dev/null 2>&1 || {
    printf '[google-ads-oauth] Node.js required for localhost OAuth capture\n' >&2
    return 2
  }

  # Single-shot HTTP server: accepts first request, extracts ?code=, exits.
  # Writes the code to stdout; exits 0 on success, 1 on timeout.
  node -e "
    const http = require('http');
    const server = http.createServer((req, res) => {
      const code = new URL(req.url, 'http://localhost').searchParams.get('code');
      const err  = new URL(req.url, 'http://localhost').searchParams.get('error');
      if (err) {
        res.writeHead(400, {'Content-Type': 'text/html'});
        res.end('<html><body><h1>OAuth error: ' + err + '</h1>You can close this tab.</body></html>');
        server.close();
        process.exit(1);
      }
      if (code) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><body><h1>Authorization received.</h1>You can close this tab and return to the terminal.</body></html>');
        process.stdout.write(code);
        server.close();
        process.exit(0);
      }
      res.writeHead(200);
      res.end('Waiting...');
    });
    server.listen($port, '127.0.0.1');
    setTimeout(() => { server.close(); process.exit(1); }, $timeout * 1000);
  "
}

# ---------------------------------------------------------------------------
# gads_exchange_code <code> <client_id> <client_secret> [redirect_uri]
# Echoes JSON: { access_token, refresh_token, expires_in, scope, token_type }
# ---------------------------------------------------------------------------
gads_exchange_code() {
  local code="$1"
  local client_id="$2"
  local client_secret="$3"
  local redirect_uri="${4:-http://localhost:8080}"

  curl -sS --max-time 15 -X POST "$GADS_TOKEN_ENDPOINT" \
    --data-urlencode "code=$code" \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "client_secret=$client_secret" \
    --data-urlencode "redirect_uri=$redirect_uri" \
    --data-urlencode "grant_type=authorization_code"
}

# ---------------------------------------------------------------------------
# gads_refresh_access_token <refresh_token> <client_id> <client_secret>
# Echoes the access_token string (or empty on failure).
# ---------------------------------------------------------------------------
gads_refresh_access_token() {
  local refresh_token="$1"
  local client_id="$2"
  local client_secret="$3"

  curl -sS --max-time 15 -X POST "$GADS_TOKEN_ENDPOINT" \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "client_secret=$client_secret" \
    --data-urlencode "refresh_token=$refresh_token" \
    --data-urlencode "grant_type=refresh_token" \
    | jq -r '.access_token // empty' 2>/dev/null
}

# ---------------------------------------------------------------------------
# gads_list_accessible_customers <access_token> <developer_token> [login_customer_id]
# Echoes JSON: { resourceNames: ["customers/1234567890", ...] }
# ---------------------------------------------------------------------------
gads_list_accessible_customers() {
  local access_token="$1"
  local developer_token="$2"
  local login_customer_id="${3:-}"

  local headers=(-H "Authorization: Bearer $access_token" -H "developer-token: $developer_token")
  [ -n "$login_customer_id" ] && headers+=(-H "login-customer-id: $login_customer_id")

  curl -sS --max-time 15 -X GET "$GADS_API_BASE/customers:listAccessibleCustomers" "${headers[@]}"
}

# ---------------------------------------------------------------------------
# gads_get_customer_info <customer_id> <access_token> <developer_token> [login_customer_id]
# Returns customer.manager + customer.descriptive_name + customer.currency_code
# Echoes JSON response (use jq downstream).
# ---------------------------------------------------------------------------
gads_get_customer_info() {
  local customer_id="$1"
  local access_token="$2"
  local developer_token="$3"
  local login_customer_id="${4:-}"

  local headers=(-H "Authorization: Bearer $access_token" -H "developer-token: $developer_token" -H "Content-Type: application/json")
  [ -n "$login_customer_id" ] && headers+=(-H "login-customer-id: $login_customer_id")

  curl -sS --max-time 15 -X POST "$GADS_API_BASE/customers/$customer_id/googleAds:search" "${headers[@]}" \
    --data-binary '{"query": "SELECT customer.id, customer.manager, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1"}'
}
