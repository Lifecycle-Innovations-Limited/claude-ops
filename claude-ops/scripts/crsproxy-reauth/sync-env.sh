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
#   - crsproxy user must have read access to /opt/crsproxy/
#
# This script is the canonical way to keep /opt/crsproxy/.env in sync with
# Doppler. No manual .env editing is needed — update the secret in Doppler
# (or Dashlane → Doppler) and re-run this script.
set -euo pipefail

cd /opt/crsproxy

TOKEN_FILE="/opt/crsproxy/.doppler-token"
ENV_FILE="/opt/crsproxy/.env"
PROJECT="crsproxy"
CONFIG="prd"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Token file $TOKEN_FILE not found" >&2
  exit 1
fi

export DOPPLER_TOKEN="$(cat "$TOKEN_FILE")"

# Download secrets in env format and write to a temp file
TMP_FILE=$(mktemp /opt/crsproxy/.env.XXXXXX)
doppler secrets download --project "$PROJECT" --config "$CONFIG" --format env --no-file > "$TMP_FILE"

# Atomic move (temp file + rename)
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"

echo "Synced $ENV_FILE from Doppler $PROJECT/$CONFIG ($(grep -c "=" "$ENV_FILE") keys)"
