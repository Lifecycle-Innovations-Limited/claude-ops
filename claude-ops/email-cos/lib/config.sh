#!/usr/bin/env bash
# lib/config.sh — universal config loader for email-cos scripts.
#
# Resolution order:
#   1. $EMAIL_COS_CONFIG (explicit path)
#   2. $EMAIL_COS_ROOT/config.sh (repo-local; gitignored at email-cos root)
#   3. ~/.config/email-cos/config.sh (install default)
#
# Sources the chosen file with set -a so ${HOME} and other vars expand in a real shell
# (systemd EnvironmentFile does not perform shell expansion).

_EMAIL_COS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_EMAIL_COS_ROOT="$(cd "$_EMAIL_COS_LIB_DIR/.." && pwd)"

if [ -n "${EMAIL_COS_CONFIG:-}" ]; then
  _cfg="$EMAIL_COS_CONFIG"
elif [ -f "$_EMAIL_COS_ROOT/config.sh" ]; then
  _cfg="$_EMAIL_COS_ROOT/config.sh"
elif [ -f "${HOME}/.config/email-cos/config.sh" ]; then
  _cfg="${HOME}/.config/email-cos/config.sh"
else
  echo "email-cos: no config found. Set EMAIL_COS_CONFIG or create ~/.config/email-cos/config.sh (see email-cos.config.example.sh)" >&2
  exit 1
fi

export EMAIL_COS_CONFIG_DIR="$(dirname "$_cfg")"
set -a
# shellcheck disable=SC1090
. "$_cfg"
set +a
