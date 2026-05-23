#!/usr/bin/env bash
# ssh-auto-whitelist.sh — SSH wrapper that self-heals on connection failure.
#
# When SSH times out or is refused (likely the bastion's Security Group dropped
# your IP after a network change), this wrapper calls aws-sg-ip-whitelist.sh to
# add the current public IP to the target SG, then retries SSH once.
#
# Usage:
#   ssh-auto-whitelist.sh <host-alias> [ssh-args...]
#   ssh-auto-whitelist.sh <host-alias> "remote command"
#
# Requires IP_WHITELIST_SG_ID to be set (or the user's SG config provided via
# /ops:setup ip-whitelist).
#
# Exit code = the final SSH invocation's exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHITELIST_SCRIPT="${SCRIPT_DIR}/aws-sg-ip-whitelist.sh"

HOST="${1:-}"
[[ -z "$HOST" ]] && { echo "usage: $0 <ssh-host-alias> [ssh-args...|command]" >&2; exit 2; }
shift

log() { printf '[ssh-auto] %s\n' "$*" >&2; }

try_ssh() {
  local timeout=$1; shift
  ssh -o ConnectTimeout="$timeout" -o BatchMode=no "$HOST" "$@"
}

if try_ssh 5 "$@"; then
  exit 0
fi

rc=$?
# 255 = SSH-level failure (timeout, refused, unreachable). Anything else is the remote command's exit.
if [[ $rc -ne 255 ]]; then exit $rc; fi

log "SSH failed (likely IP blocked) — refreshing SG whitelist…"
if ! bash "$WHITELIST_SCRIPT"; then
  log "whitelist refresh failed — aborting"
  exit $rc
fi

# Brief settle so SG mutation propagates
sleep 2

log "retrying SSH…"
try_ssh 10 "$@"
