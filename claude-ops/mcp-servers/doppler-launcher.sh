#!/usr/bin/env bash
# doppler-launcher.sh — resolve a Doppler token, then exec the Doppler MCP server.
#
# Why this exists:
#   The plugin wires the Doppler MCP as
#       env: { "DOPPLER_TOKEN": "${user_config.doppler_token}" }
#   and the doppler_token userConfig field defaults to "". Its description tells
#   users they may "leave blank — runtime resolves automatically". That promise
#   was false: a blank value was passed straight to `npx doppler-mcp` as
#   DOPPLER_TOKEN="", which (a) clobbered any inherited token and (b) made the
#   server exit "Not authenticated", so the MCP showed as Failed to connect on
#   every box that didn't paste a literal token.
#
# This launcher makes the documented behavior true. Resolution order:
#   1. $DOPPLER_TOKEN_CONFIG — the pasted userConfig token (if non-empty).
#   2. $DOPPLER_TOKEN already present in the spawn env (if non-empty).
#   3. `doppler configure get token --plain` — the token from a prior
#      `doppler login` / service-token setup (the common case).
# If none yield a token we DO NOT export an empty DOPPLER_TOKEN — we exec the
# server with the token unset so it can fall back to its own `doppler login`
# store and report its real auth state, instead of being force-failed by "".
#
# Deliberately does not export a static token into anything but this server's
# own process env (keeps `doppler login` token rotation in shells unmasked).
set -euo pipefail

token=""
if [[ -n "${DOPPLER_TOKEN_CONFIG:-}" ]]; then
  token="${DOPPLER_TOKEN_CONFIG}"
elif [[ -n "${DOPPLER_TOKEN:-}" ]]; then
  token="${DOPPLER_TOKEN}"
elif command -v doppler >/dev/null 2>&1; then
  token="$(doppler configure get token --plain 2>/dev/null || true)"
fi

if [[ -n "${token}" ]]; then
  export DOPPLER_TOKEN="${token}"
else
  unset DOPPLER_TOKEN || true
fi
# DOPPLER_TOKEN_CONFIG is an internal hint — never leak it to the child.
unset DOPPLER_TOKEN_CONFIG || true

exec npx -y -p @dopplerhq/mcp-server doppler-mcp
