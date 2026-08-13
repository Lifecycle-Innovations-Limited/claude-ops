#!/usr/bin/env bash
# sync-env.sh — Sync /opt/crsproxy/.env from Doppler
#
# Downloads all secrets from the Doppler crsproxy/prd config and writes them
# to /opt/crsproxy/.env atomically (temp file + rename). The Doppler service
# token is read from /opt/crsproxy/.doppler-token (mode 600, owner crsproxy).
#
# Usage: sudo -u crsproxy /opt/crsproxy/sync-env.sh
#
# Requirements:
#   - Doppler CLI installed on hub (/usr/bin/doppler)
#   - Service token stored at /opt/crsproxy/.doppler-token
#   - crsproxy user must have write and execute access to /opt/crsproxy/
#
# This script is the canonical way to keep /opt/crsproxy/.env in sync with
# Doppler. No manual .env editing is needed — update the secret in Doppler
# (or Dashlane → Doppler) and re-run this script.
set -euo pipefail

MOBILE=0
if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" || "${OPS_MOBILE:-0}" == "1" || ( "${COLUMNS:-80}" =~ ^[0-9]+$ && "${COLUMNS:-80}" -lt 80 ) ]]; then
  MOBILE=1
fi

cd /opt/crsproxy

TOKEN_FILE="/opt/crsproxy/.doppler-token"
ENV_FILE="/opt/crsproxy/.env"
PROJECT="crsproxy"
CONFIG="prd"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Token file $TOKEN_FILE not found" >&2
  exit 1
fi
if [ ! -r "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
  echo "ERROR: Token file $TOKEN_FILE must be readable and non-empty" >&2
  exit 1
fi
if ! DOPPLER_TOKEN="$(<"$TOKEN_FILE")" || [ -z "$DOPPLER_TOKEN" ]; then
  echo "ERROR: Could not read a non-empty token from $TOKEN_FILE" >&2
  exit 1
fi
export DOPPLER_TOKEN

# Download secrets in env format and write to a temp file
TMP_FILE=$(mktemp /opt/crsproxy/.env.XXXXXX)
cleanup() {
  [ -n "${TMP_FILE:-}" ] && rm -f -- "$TMP_FILE"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
doppler secrets download --project "$PROJECT" --config "$CONFIG" --format env --no-file > "$TMP_FILE"

if [ ! -s "$TMP_FILE" ] || ! grep -Eq '^BROWSER_USE_API_KEY=.+$' "$TMP_FILE"; then
  echo "ERROR: Doppler output is empty or missing BROWSER_USE_API_KEY" >&2
  exit 1
fi
key_count=$(grep -c "=" "$TMP_FILE")

# Atomic move (temp file + rename)
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"
TMP_FILE=""
if [ "$MOBILE" -eq 1 ]; then
  echo "env synced: ${key_count} keys"
else
  echo "Synced $ENV_FILE from Doppler $PROJECT/$CONFIG (${key_count} keys)"
fi
