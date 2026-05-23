#!/usr/bin/env bash
# aws-sg-ip-whitelist.sh — sync this machine's public IPv4 into an AWS Security
# Group ingress rule. Idempotent; safe to run on every network change.
#
# Behavior:
#   1. Fetch current public IPv4 via ifconfig.me / icanhazip.com / ipify.
#   2. If already present in SG with a "$DESC_PREFIX-*" description: no-op.
#   3. Otherwise revoke "$DESC_PREFIX-*" rules older than KEEP_RECENT count.
#   4. Authorize the new IP on the target port with a timestamped description.
#
# Configuration (env vars or claude-ops preferences):
#   IP_WHITELIST_SG_ID            REQUIRED — target Security Group ID (sg-...)
#   IP_WHITELIST_REGION           default: us-east-1
#   IP_WHITELIST_PORT             default: 22 (single TCP port)
#   IP_WHITELIST_DESC_PREFIX      default: <hostname-without-domain>-laptop
#   IP_WHITELIST_KEEP_RECENT      default: 2 (newest N rules retained pre-add)
#   IP_OVERRIDE                   explicit IP, skips public-IP detection
#
# Exit codes:
#   0  success (added or already present)
#   1  could not detect public IP / missing config
#   2  AWS CLI / SG mutation failure

set -euo pipefail

SG_ID="${IP_WHITELIST_SG_ID:-${SG_ID:-}}"
REGION="${IP_WHITELIST_REGION:-${REGION:-us-east-1}}"
PORT="${IP_WHITELIST_PORT:-${PORT:-22}}"
KEEP_RECENT="${IP_WHITELIST_KEEP_RECENT:-${KEEP_RECENT:-2}}"
DEFAULT_PREFIX="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo claude-ops)-laptop"
DESC_PREFIX="${IP_WHITELIST_DESC_PREFIX:-${DESC_PREFIX:-$DEFAULT_PREFIX}}"

log() { printf '[ip-whitelist] %s\n' "$*" >&2; }

if [[ -z "$SG_ID" ]]; then
  log "IP_WHITELIST_SG_ID is required (export it or run /ops:setup ip-whitelist)"
  exit 1
fi

detect_ip() {
  if [[ -n "${IP_OVERRIDE:-}" ]]; then echo "$IP_OVERRIDE"; return 0; fi
  for url in https://ifconfig.me https://icanhazip.com https://api.ipify.org; do
    ip=$(curl -s4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then echo "$ip"; return 0; fi
  done
  return 1
}

IP=$(detect_ip) || { log "could not detect public IP"; exit 1; }
log "current public IP: $IP"

RULES_JSON=$(aws ec2 describe-security-groups \
  --region "$REGION" --group-ids "$SG_ID" \
  --query "SecurityGroups[].IpPermissions[?FromPort==\`$PORT\`].IpRanges[]" \
  --output json 2>/dev/null) || { log "aws describe-security-groups failed"; exit 2; }

RULES_FLAT=$(echo "$RULES_JSON" | jq '[.[] | .[]?] // []')

if echo "$RULES_FLAT" | jq -e --arg ip "${IP}/32" '.[] | select(.CidrIp == $ip)' >/dev/null 2>&1; then
  log "IP $IP already whitelisted — no-op"
  exit 0
fi

mapfile -t STALE < <(
  echo "$RULES_FLAT" | jq -r --arg p "$DESC_PREFIX-" --argjson keep "$KEEP_RECENT" '
    [.[] | select(.Description // "" | startswith($p))]
    | sort_by(.Description) | reverse | .[$keep:]
    | .[] | "\(.CidrIp)|\(.Description)"
  '
)

for entry in "${STALE[@]}"; do
  [[ -z "$entry" ]] && continue
  cidr="${entry%%|*}"
  desc="${entry##*|}"
  log "revoking stale $desc ($cidr)"
  aws ec2 revoke-security-group-ingress \
    --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$cidr}]" \
    >/dev/null 2>&1 || log "  (revoke failed for $cidr — continuing)"
done

TIMESTAMP=$(date +%Y%m%d-%H%M)
NEW_DESC="${DESC_PREFIX}-${TIMESTAMP}"
log "authorizing $IP/32 as $NEW_DESC"

aws ec2 authorize-security-group-ingress \
  --region "$REGION" --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$IP/32,Description=$NEW_DESC}]" \
  >/dev/null 2>&1 || { log "authorize failed"; exit 2; }

log "OK $IP whitelisted as $NEW_DESC on $SG_ID"
