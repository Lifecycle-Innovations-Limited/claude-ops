#!/usr/bin/env bash
###############################################################################
# ops-aws-audit.sh — read-only AWS account hygiene, security & cost audit
#
# Part of the claude-ops "ops" plugin (skill: /ops:ops-aws-audit).
#
# DESIGN PRINCIPLES
#   * READ-ONLY: only describe/list/get + Cost Explorer. Never mutates AWS.
#     (Destructive cleanup stays human-gated in the skill, never automated.)
#   * NO SECRETS: credentials come from the standard AWS chain (AWS_PROFILE /
#     instance role / SSO). Nothing is hardcoded or written to the report.
#   * TEMPLATEABLE: everything tunable via env vars (see CONFIG).
#   * MACHINE + HUMAN OUTPUT: findings.json (severity-tagged) + report.md.
#
# Usage:
#   ops-aws-audit.sh                 # audit default+configured regions
#   AUDIT_REGIONS=us-east-1,eu-central-1 ops-aws-audit.sh
#   AUDIT_PROFILE=prod AUDIT_OUTPUT_DIR=~/audits ops-aws-audit.sh
#   ops-aws-audit.sh --quiet         # only write files, minimal stdout
###############################################################################
set -uo pipefail

# ----------------------------------------------------------------- CONFIG ----
# Only pass --profile when AUDIT_PROFILE is explicitly set; otherwise use the
# standard credential chain (env keys / instance role / SSO). This avoids
# breaking when AWS_PROFILE points at a non-existent named profile.
PROFILE="${AUDIT_PROFILE:-}"
PROFILE_ARG=(); [ -n "$PROFILE" ] && PROFILE_ARG=(--profile "$PROFILE")
PRIMARY_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AUDIT_REGIONS="${AUDIT_REGIONS:-}"   # empty ⇒ auto-discover ALL enabled regions
AUDIT_OUTPUT_DIR="${AUDIT_OUTPUT_DIR:-$HOME/.aws-audit-history/audit-$(date +%Y%m%d-%H%M%S)}"
KEY_AGE_DAYS="${AUDIT_KEY_AGE_DAYS:-90}"      # flag active access keys older than this
COST_DAYS="${AUDIT_COST_DAYS:-7}"             # cost comparison window
QUIET=0; [ "${1:-}" = "--quiet" ] && QUIET=1

RAW="$AUDIT_OUTPUT_DIR/raw"
FINDINGS_JSONL="$AUDIT_OUTPUT_DIR/findings.jsonl"
FINDINGS_JSON="$AUDIT_OUTPUT_DIR/findings.json"
REPORT="$AUDIT_OUTPUT_DIR/report.md"
LOG="$AUDIT_OUTPUT_DIR/audit.log"

# Colours (disabled when not a TTY)
if [ -t 1 ]; then C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[1;33m'; C_B='\033[0;34m'; C_N='\033[0m'
else C_R=''; C_G=''; C_Y=''; C_B=''; C_N=''; fi

# --------------------------------------------------------------- HELPERS -----
log()  { echo "[$(date +%H:%M:%S)] $*" >>"$LOG"; [ "$QUIET" = 1 ] || echo -e "$*"; }
sec()  { log "${C_B}== $* ==${C_N}"; }
ok()   { log "${C_G}  ✓ $*${C_N}"; }
warn() { log "${C_Y}  ⚠ $*${C_N}"; }
err()  { log "${C_R}  ✗ $*${C_N}"; }

AWS() { command aws "${PROFILE_ARG[@]}" --no-cli-pager "$@"; }
AWSR(){ local r="$1"; shift; command aws "${PROFILE_ARG[@]}" --region "$r" --no-cli-pager "$@"; }

# epoch helper: ISO8601 -> epoch seconds (GNU date)
epoch() { date -d "$1" +%s 2>/dev/null || echo 0; }
NOW=$(date +%s)
age_days() { echo $(( (NOW - $(epoch "$1")) / 86400 )); }

# finding SEV SERVICE REGION RESOURCE ISSUE RECOMMENDATION [EST_MONTHLY_USD]
finding() {
  jq -nc --arg sev "$1" --arg svc "$2" --arg reg "$3" --arg res "$4" \
         --arg iss "$5" --arg rec "$6" --argjson usd "${7:-0}" \
    '{severity:$sev,service:$svc,region:$reg,resource:$res,issue:$iss,recommendation:$rec,est_monthly_usd:$usd}' \
    >>"$FINDINGS_JSONL"
}

require() {
  command -v aws >/dev/null || { echo "FATAL: aws CLI not found"; exit 2; }
  command -v jq  >/dev/null || { echo "FATAL: jq not found";      exit 2; }
}

# ------------------------------------------------------------------ INIT ------
require
mkdir -p "$RAW"; : >"$FINDINGS_JSONL"; : >"$LOG"
ACCOUNT=$(AWS sts get-caller-identity --query Account --output text 2>/dev/null)
WHOAMI=$(AWS sts get-caller-identity --query Arn --output text 2>/dev/null)
[ -z "$ACCOUNT" ] && { echo "FATAL: cannot authenticate to AWS (set AUDIT_PROFILE or AWS creds)"; exit 2; }
log "AWS audit — account $ACCOUNT — caller $WHOAMI"
if [ -z "$AUDIT_REGIONS" ]; then
  AUDIT_REGIONS=$(AWS ec2 describe-regions --all-regions \
      --query 'Regions[?OptInStatus!=`not-opted-in`].RegionName' --output text 2>/dev/null | tr '\t' ' ')
  [ -z "$AUDIT_REGIONS" ] && AUDIT_REGIONS="$PRIMARY_REGION"
  AUDIT_REGIONS=$(echo "$AUDIT_REGIONS" | tr ' ' '\n' | sort | tr '\n' ',' | sed 's/,$//')
  log "auto-discovered $(echo "$AUDIT_REGIONS" | tr ',' ' ' | wc -w) enabled region(s)"
fi
log "regions: $AUDIT_REGIONS  output: $AUDIT_OUTPUT_DIR"

# ============================================================ IAM (global) ===
audit_iam() {
  sec "IAM / credentials"
  AWS iam get-account-summary --query SummaryMap >"$RAW/iam-summary.json" 2>/dev/null && ok "account summary"

  # credential report (authoritative for key age + root usage)
  AWS iam generate-credential-report >/dev/null 2>&1; sleep 2
  if AWS iam get-credential-report --query Content --output text 2>/dev/null | base64 -d >"$RAW/credential-report.csv" 2>/dev/null; then
    ok "credential report"
    # parse CSV (skip header)
    tail -n +2 "$RAW/credential-report.csv" | while IFS=, read -r user arn ctime pw_enabled pw_last pw_changed pw_next mfa k1act k1rot k1used k1reg k1svc k2act k2rot rest; do
      if [ "$user" = "<root_account>" ]; then
        [ "$mfa" = "false" ] && finding CRITICAL IAM global root "Root account has no MFA" "Enable a hardware/virtual MFA device on the root user" 0
        if [ "$k1act" = "true" ]; then
          finding CRITICAL IAM global "root access key" "Root account has an ACTIVE access key (last used: ${k1used})" "Delete the root access key; use IAM roles/users for API access (requires root console login)" 0
        fi
        continue
      fi
      # console password without MFA
      [ "$pw_enabled" = "true" ] && [ "$mfa" = "false" ] && \
        finding HIGH IAM global "user/$user" "Console password enabled but no MFA" "Enforce MFA for this user" 0
      # old active access keys
      if [ "$k1act" = "true" ] && [ "$k1rot" != "N/A" ]; then
        a=$(age_days "$k1rot"); [ "$a" -gt "$KEY_AGE_DAYS" ] && \
          finding HIGH IAM global "user/$user" "Active access key is ${a}d old (>${KEY_AGE_DAYS}d)" "Rotate the access key and remove the old one" 0
      fi
      if [ "$k2act" = "true" ] && [ "$k2rot" != "N/A" ]; then
        a=$(age_days "$k2rot"); [ "$a" -gt "$KEY_AGE_DAYS" ] && \
          finding HIGH IAM global "user/$user" "Active access key #2 is ${a}d old (>${KEY_AGE_DAYS}d)" "Rotate the access key and remove the old one" 0
      fi
    done
  else err "credential report unavailable"; fi

  # IAM Access Analyzer — 2026 best practice: an *unused-access* analyzer
  local has_unused="" reg
  for reg in ${AUDIT_REGIONS//,/ }; do
    AWSR "$reg" accessanalyzer list-analyzers --query 'analyzers[].type' --output text 2>/dev/null | grep -q 'UNUSED_ACCESS' && has_unused=1
  done
  [ -z "$has_unused" ] && finding MEDIUM IAM global "Access Analyzer" "No unused-access IAM Access Analyzer configured" "Create an UNUSED_ACCESS analyzer to surface stale roles/keys/permissions" 0
}

# ====================================================== EC2 / EBS (regional) =
audit_ec2() {
  local reg="$1"
  AWSR "$reg" ec2 describe-instances \
    --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name,type:InstanceType,launch:LaunchTime}' \
    >"$RAW/ec2-instances-$reg.json" 2>/dev/null

  # unattached EBS volumes (billed while idle) + gp2 + unencrypted
  AWSR "$reg" ec2 describe-volumes \
    --query 'Volumes[].{id:VolumeId,size:Size,type:VolumeType,state:State,enc:Encrypted}' \
    >"$RAW/ebs-volumes-$reg.json" 2>/dev/null
  if [ -s "$RAW/ebs-volumes-$reg.json" ]; then
    jq -c '.[]' "$RAW/ebs-volumes-$reg.json" 2>/dev/null | while read -r v; do
      id=$(jq -r .id <<<"$v"); sz=$(jq -r .size <<<"$v"); ty=$(jq -r .type <<<"$v")
      st=$(jq -r .state <<<"$v"); enc=$(jq -r .enc <<<"$v")
      [ "$st" = "available" ] && finding MEDIUM EC2 "$reg" "$id" "Unattached EBS volume (${sz}GiB ${ty}) still billed" "Snapshot then delete if unneeded" "$(awk "BEGIN{printf \"%.2f\", $sz*0.08}")"
      [ "$ty" = "gp2" ] && finding LOW EC2 "$reg" "$id" "Volume is gp2" "Migrate to gp3 (~20% cheaper, same/ better perf)" "$(awk "BEGIN{printf \"%.2f\", $sz*0.02}")"
      [ "$enc" = "false" ] && finding HIGH EC2 "$reg" "$id" "EBS volume is unencrypted" "Recreate from encrypted snapshot; enable EBS encryption-by-default" 0
    done
  fi

  # unassociated Elastic IPs (~$3.60/mo each)
  AWSR "$reg" ec2 describe-addresses --query 'Addresses[?AssociationId==null].AllocationId' --output text 2>/dev/null | tr '\t' '\n' | while read -r eip; do
    [ -n "$eip" ] && finding MEDIUM EC2 "$reg" "$eip" "Unassociated Elastic IP (billed hourly)" "Release the EIP if not needed" 3.60
  done

  # security groups open to the world on admin ports
  AWSR "$reg" ec2 describe-security-groups \
    --query 'SecurityGroups[?IpPermissions[?(FromPort==`22`||FromPort==`3389`) && IpRanges[?CidrIp==`0.0.0.0/0`]]].GroupId' \
    --output text 2>/dev/null | tr '\t' '\n' | while read -r sg; do
    [ -n "$sg" ] && finding HIGH EC2 "$reg" "$sg" "Security group allows 0.0.0.0/0 to SSH/RDP" "Restrict to known CIDRs or use SSM Session Manager" 0
  done
  # all-traffic (-1) open to the world — arguably worse than a single admin port
  AWSR "$reg" ec2 describe-security-groups \
    --query 'SecurityGroups[?IpPermissions[?IpProtocol==`-1` && IpRanges[?CidrIp==`0.0.0.0/0`]]].GroupId' \
    --output text 2>/dev/null | tr '\t' '\n' | while read -r sg; do
    [ -n "$sg" ] && finding HIGH EC2 "$reg" "$sg" "Security group allows ALL traffic from 0.0.0.0/0" "Remove the all-traffic ingress rule; scope to required ports/CIDRs" 0
  done
}

# ============================================================ RDS (regional) =
audit_rds() {
  local reg="$1"
  AWSR "$reg" rds describe-db-instances \
    --query 'DBInstances[].{id:DBInstanceIdentifier,enc:StorageEncrypted,public:PubliclyAccessible,az:MultiAZ,engine:Engine}' \
    >"$RAW/rds-instances-$reg.json" 2>/dev/null
  if [ -s "$RAW/rds-instances-$reg.json" ]; then
    jq -c '.[]' "$RAW/rds-instances-$reg.json" 2>/dev/null | while read -r d; do
      id=$(jq -r .id <<<"$d")
      [ "$(jq -r .enc <<<"$d")"    = "false" ] && finding HIGH RDS "$reg" "$id" "RDS storage not encrypted" "Re-create from encrypted snapshot" 0
      [ "$(jq -r .public <<<"$d")" = "true"  ] && finding HIGH RDS "$reg" "$id" "RDS instance is publicly accessible" "Disable public accessibility; place in private subnet" 0
    done
  fi
  # orphaned manual snapshots (source DB no longer exists).
  # Build the "live" id set from BOTH instances and Aurora clusters; if we cannot
  # determine it, skip the orphan check rather than flag everything (false positive).
  live=$(jq -r '.[].id' "$RAW/rds-instances-$reg.json" 2>/dev/null)
  clusters=$(AWSR "$reg" rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier' --output text 2>/dev/null | tr '\t' '\n')
  live=$(printf '%s\n%s\n' "$live" "$clusters" | sed '/^$/d' | sort -u)
  AWSR "$reg" rds describe-db-snapshots --snapshot-type manual \
    --query 'DBSnapshots[].{id:DBSnapshotIdentifier,db:DBInstanceIdentifier,size:AllocatedStorage,t:SnapshotCreateTime}' \
    >"$RAW/rds-snapshots-$reg.json" 2>/dev/null
  if [ -s "$RAW/rds-snapshots-$reg.json" ] && [ -n "$live" ]; then
    jq -c '.[]' "$RAW/rds-snapshots-$reg.json" 2>/dev/null | while read -r s; do
      sid=$(jq -r .id <<<"$s"); sdb=$(jq -r .db <<<"$s"); ssz=$(jq -r .size <<<"$s")
      if ! grep -qx "$sdb" <<<"$live"; then
        finding MEDIUM RDS "$reg" "$sid" "Manual snapshot whose source DB '$sdb' no longer exists" "Delete if no recovery value" "$(awk "BEGIN{printf \"%.2f\", $ssz*0.095}")"
      fi
    done
  fi
}

# ========================================================= S3 (global-ish) ===
audit_s3() {
  sec "S3"
  # account-level Block Public Access (2026 baseline)
  bpa=$(AWS s3control get-public-access-block --account-id "$ACCOUNT" \
        --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
        --output text 2>/dev/null)
  if [ -z "$bpa" ] || [ "$(grep -o True <<<"$bpa" | wc -l)" -lt 4 ]; then
    finding HIGH S3 global "account" "Account-level S3 Block Public Access is not fully enabled" "Enable all 4 BPA settings at the account level" 0
  else ok "account BPA fully enabled"; fi

  AWS s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | tr '\t' '\n' | while read -r b; do
    [ -z "$b" ] && continue
    AWS s3api get-bucket-encryption --bucket "$b" >/dev/null 2>&1 || \
      finding MEDIUM S3 global "$b" "Bucket has no default encryption" "Enable SSE-S3 or SSE-KMS default encryption" 0
    AWS s3api get-bucket-lifecycle-configuration --bucket "$b" >/dev/null 2>&1 || \
      finding LOW S3 global "$b" "Bucket has no lifecycle policy" "Add lifecycle rules to expire/transition old objects" 0
  done
  ok "bucket checks complete"
}

# ============================================ CloudWatch Logs (regional) ======
audit_logs() {
  local reg="$1"
  AWSR "$reg" logs describe-log-groups \
    --query 'logGroups[?retentionInDays==null].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | while read -r lg; do
    [ -n "$lg" ] && finding LOW CloudWatch "$reg" "$lg" "Log group has no retention (stored forever)" "Set retention (e.g. 30–90d) to cap storage cost" 0
  done
}

# =================================================== Lambda runtimes (reg) ====
audit_lambda() {
  local reg="$1"
  AWSR "$reg" lambda list-functions \
    --query 'Functions[].{n:FunctionName,r:Runtime}' >"$RAW/lambda-$reg.json" 2>/dev/null
  jq -r '.[]|select(.r!=null)|select(.r|test("python3\\.[0-9]$|python3\\.1[01]$|python2|nodejs1[0-6]|nodejs[0-9]\\.|ruby2|go1\\.x|dotnetcore"))|.n+" "+.r' \
     "$RAW/lambda-$reg.json" 2>/dev/null | while read -r fn rt; do
    finding MEDIUM Lambda "$reg" "$fn" "Deprecated/old runtime: $rt" "Upgrade to a supported runtime (e.g. python3.13/nodejs22)" 0
  done
}

# ============================================ Security service enrollment =====
audit_security_posture() {
  sec "Security posture (GuardDuty / Security Hub / Cost Anomaly / Compute Optimizer)"
  local reg gd sh
  for reg in ${AUDIT_REGIONS//,/ }; do
    gd=$(AWSR "$reg" guardduty list-detectors --query 'DetectorIds' --output text 2>/dev/null)
    [ -z "$gd" ] && finding MEDIUM GuardDuty "$reg" "account" "GuardDuty not enabled" "Enable GuardDuty for threat detection" 0
    sh=$(AWSR "$reg" securityhub get-enabled-standards --query 'StandardsSubscriptions' --output text 2>/dev/null)
    [ -z "$sh" ] && finding LOW SecurityHub "$reg" "account" "Security Hub standards not enabled" "Enable AWS Foundational Security Best Practices standard" 0
  done
  # Cost Anomaly Detection monitors (global)
  cam=$(AWS ce get-anomaly-monitors --query 'AnomalyMonitors' --output text 2>/dev/null)
  [ -z "$cam" ] && finding MEDIUM CostAnomaly global "account" "No Cost Anomaly Detection monitors" "Create an anomaly monitor + alert subscription (backstop for spend spikes)" 0
  # Compute Optimizer enrollment (global)
  co=$(AWS compute-optimizer get-enrollment-status --query status --output text 2>/dev/null)
  [ "$co" != "Active" ] && finding LOW ComputeOptimizer global "account" "Compute Optimizer not enrolled (status: ${co:-unknown})" "Opt in for rightsizing recommendations (EC2/EBS/Lambda)" 0
}

# ===================================================== Cost (per-service Δ) ===
# Doctrine (2026-07-22): RECORD_TYPE=Usage only. Credits/SPP/SP negation make
# plain Blended/Unblended totals ≈ $0 while real burn is hundreds/day.
audit_cost() {
  sec "Cost Explorer Usage burn (per-service Δ over ${COST_DAYS}d; RECORD_TYPE=Usage)"
  local e s p
  e=$(date +%F)
  # macOS date first; GNU date fallback
  s=$(date -v-"${COST_DAYS}"d +%F 2>/dev/null || date -d "-${COST_DAYS} days" +%F)
  p=$(date -v-"$((COST_DAYS*2))"d +%F 2>/dev/null || date -d "-$((COST_DAYS*2)) days" +%F)
  local USAGE_FILTER='{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'
  # DAILY granularity + Usage filter (credit-masked nets are useless for spikes)
  AWS ce get-cost-and-usage --time-period Start=$s,End=$e --granularity DAILY --metrics UnblendedCost \
    --filter "$USAGE_FILTER" \
    --group-by Type=DIMENSION,Key=SERVICE \
    --query 'ResultsByTime[].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' --output text 2>/dev/null \
    | awk -F'\t' '{a[$1]+=$2} END{for(k in a) printf "%s\t%.2f\n",k,a[k]}' | sort >"$RAW/cost-current.tsv"
  AWS ce get-cost-and-usage --time-period Start=$p,End=$s --granularity DAILY --metrics UnblendedCost \
    --filter "$USAGE_FILTER" \
    --group-by Type=DIMENSION,Key=SERVICE \
    --query 'ResultsByTime[].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' --output text 2>/dev/null \
    | awk -F'\t' '{a[$1]+=$2} END{for(k in a) printf "%s\t%.2f\n",k,a[k]}' | sort >"$RAW/cost-prev.tsv"
  # Optional: credit mask snapshot for the report
  AWS ce get-cost-and-usage --time-period Start=$s,End=$e --granularity MONTHLY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=RECORD_TYPE \
    --query 'ResultsByTime[0].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' --output text 2>/dev/null \
    >"$RAW/cost-record-types.tsv" || true
  if [ -s "$RAW/cost-current.tsv" ]; then
    join -t $'\t' -a1 -e 0 -o '0,1.2,2.2' "$RAW/cost-current.tsv" "$RAW/cost-prev.tsv" 2>/dev/null \
      | awk -F'\t' '{d=$2-$3; printf "%s\t%.2f\t%+.2f\n",$1,$2,d}' \
      | sort -t$'\t' -k2 -nr >"$RAW/cost-delta.tsv"
    local total_usage
    total_usage=$(awk -F'\t' '{s+=$2} END{printf "%.2f",s+0}' "$RAW/cost-current.tsv")
    ok "Usage burn ${COST_DAYS}d total=\$${total_usage}; delta rows=$(wc -l <"$RAW/cost-delta.tsv" | tr -d ' ')"
    # flag any service that jumped >$5 vs previous window
    awk -F'\t' '$3+0>5{print}' "$RAW/cost-delta.tsv" | while IFS=$'\t' read -r svc cur del; do
      finding MEDIUM Cost global "$svc" "Usage spend up \$${del} vs prior ${COST_DAYS}d (now \$${cur})" "Investigate the cost driver for $svc (Usage burn, not credit-masked net)" 0
    done
    # Surface high daily Usage burn so reports don't look "free" under credits
    avg_daily=$(awk -v d="$COST_DAYS" -v t="$total_usage" 'BEGIN{printf "%.0f", (d>0?t/d:0)}')
    if [ "${avg_daily:-0}" -gt 50 ] 2>/dev/null; then
      finding LOW Cost global "account" \
        "Usage burn avg \$${avg_daily}/day over ${COST_DAYS}d (total \$${total_usage}); credits may mask Console net to ~\$0" \
        "Track RECORD_TYPE=Usage (scripts/aws-usage-cost.sh), not credit-masked net" 0
    fi
  else warn "Cost Explorer not available (needs ce:GetCostAndUsage + enablement)"; fi
}

# =============================================================== REPORT =======
build_report() {
  jq -s '.' "$FINDINGS_JSONL" >"$FINDINGS_JSON" 2>/dev/null || echo '[]' >"$FINDINGS_JSON"
  local total crit high med low
  total=$(jq 'length' "$FINDINGS_JSON")
  crit=$(jq '[.[]|select(.severity=="CRITICAL")]|length' "$FINDINGS_JSON")
  high=$(jq '[.[]|select(.severity=="HIGH")]|length'     "$FINDINGS_JSON")
  med=$(jq  '[.[]|select(.severity=="MEDIUM")]|length'   "$FINDINGS_JSON")
  low=$(jq  '[.[]|select(.severity=="LOW")]|length'      "$FINDINGS_JSON")
  local savings; savings=$(jq '[.[].est_monthly_usd]|add // 0|.*100|round/100' "$FINDINGS_JSON")

  {
    echo "# AWS Audit Report"
    echo
    echo "- **Account:** $ACCOUNT"
    echo "- **Caller:** \`$WHOAMI\`"
    echo "- **Generated:** $(date -u '+%Y-%m-%d %H:%M:%SZ')"
    echo "- **Regions:** $AUDIT_REGIONS"
    echo
    echo "## Summary"
    echo
    echo "| Severity | Count |"
    echo "|----------|-------|"
    echo "| 🔴 CRITICAL | $crit |"
    echo "| 🟠 HIGH | $high |"
    echo "| 🟡 MEDIUM | $med |"
    echo "| ⚪ LOW | $low |"
    echo "| **Total** | **$total** |"
    echo
    echo "**Estimated identifiable monthly savings:** \$$savings"
    echo
    for sv in CRITICAL HIGH MEDIUM LOW; do
      n=$(jq --arg s "$sv" '[.[]|select(.severity==$s)]|length' "$FINDINGS_JSON")
      [ "$n" -eq 0 ] && continue
      echo "## $sv ($n)"; echo
      echo "| Service | Region | Resource | Issue | Recommendation | \$/mo |"
      echo "|---------|--------|----------|-------|----------------|------|"
      jq -r --arg s "$sv" '.[]|select(.severity==$s)|"| \(.service) | \(.region) | `\(.resource)` | \(.issue) | \(.recommendation) | \(.est_monthly_usd) |"' "$FINDINGS_JSON"
      echo
    done
    echo "## Top cost services (last ${COST_DAYS}d, with Δ vs prior window)"
    echo; echo '```'; { printf "SERVICE\tNOW\tΔ\n"; head -15 "$RAW/cost-delta.tsv" 2>/dev/null; }; echo '```'
    echo
    echo "_Read-only audit. No resources were modified. Review findings before any cleanup._"
  } >"$REPORT"
}


# =========================================================== PIXEL-ART UI =====
# Renders a designed pixel-art summary to the terminal after the audit.
# Uses Unicode block elements; honours the colour vars (NO-OP-safe on non-TTY).
render_pixel_report() {
  local crit high med low total savings
  total=$(jq 'length' "$FINDINGS_JSON" 2>/dev/null || echo 0)
  crit=$(jq '[.[]|select(.severity=="CRITICAL")]|length' "$FINDINGS_JSON" 2>/dev/null || echo 0)
  high=$(jq '[.[]|select(.severity=="HIGH")]|length'     "$FINDINGS_JSON" 2>/dev/null || echo 0)
  med=$(jq  '[.[]|select(.severity=="MEDIUM")]|length'   "$FINDINGS_JSON" 2>/dev/null || echo 0)
  low=$(jq  '[.[]|select(.severity=="LOW")]|length'      "$FINDINGS_JSON" 2>/dev/null || echo 0)
  savings=$(jq '[.[].est_monthly_usd]|add // 0|.*100|round/100' "$FINDINGS_JSON" 2>/dev/null || echo 0)

  # palette
  local P_R='\033[38;5;203m' P_O='\033[38;5;215m' P_Y='\033[38;5;227m' P_G='\033[38;5;120m'
  local P_B='\033[38;5;75m'  P_GR='\033[38;5;245m' P_W='\033[1;97m' P_N='\033[0m'
  local FR='\033[38;5;208m'  # AWS-ish amber for the frame
  [ -t 1 ] || { P_R=''; P_O=''; P_Y=''; P_G=''; P_B=''; P_GR=''; P_W=''; P_N=''; FR=''; }

  # pixel bar: $1=count $2=colour  (1 block per finding, capped at 28)
  bar() { local n="$1" c="$2" out="" i; local cap=$(( n>28?28:n ));
          for ((i=0;i<cap;i++)); do out+="█"; done
          [ "$n" -gt 28 ] && out+="…"
          printf "%b%s%b" "$c" "${out:-·}" "$P_N"; }

  echo
  printf "%b╔══════════════════════════════════════════════════════════════╗%b\n" "$FR" "$P_N"
  printf "%b║%b   %b▄▀█ █░█░█ █▀%b   %b▄▀█ █░█ █▀▄ █ ▀█▀%b   pixel ops report   %b║%b\n" "$FR" "$P_N" "$P_O" "$P_N" "$P_Y" "$P_N" "$FR" "$P_N"
  printf "%b║%b   %b█▀█ ▀▄▀▄▀ ▄█%b   %b█▀█ █▄█ █▄▀ █ ░█░%b                      %b║%b\n" "$FR" "$P_N" "$P_O" "$P_N" "$P_Y" "$P_N" "$FR" "$P_N"
  printf "%b╠══════════════════════════════════════════════════════════════╣%b\n" "$FR" "$P_N"
  # pixel-art shield (security) made of blocks
  printf "%b║%b   %b▟██████▙%b   account %b%-18s%b region(s) %b%-2s%b   %b║%b\n" "$FR" "$P_N" "$P_B" "$P_N" "$P_W" "$ACCOUNT" "$P_N" "$P_W" "$(echo "$AUDIT_REGIONS"|tr ',' ' '|wc -w)" "$P_N" "$FR" "$P_N"
  printf "%b║%b   %b█▘▄██▄▝█%b   findings %b%-3s%b   est. savings %b\$%-10s%b  %b║%b\n" "$FR" "$P_N" "$P_B" "$P_N" "$P_W" "$total" "$P_N" "$P_G" "$savings" "$P_N" "$FR" "$P_N"
  printf "%b║%b   %b▝█▓▓▓▓█▘%b                                            %b║%b\n" "$FR" "$P_N" "$P_B" "$P_N" "$FR" "$P_N"
  printf "%b║%b   %b░▝████▘░%b                                            %b║%b\n" "$FR" "$P_N" "$P_B" "$P_N" "$FR" "$P_N"
  printf "%b╠══════════════════════════════════════════════════════════════╣%b\n" "$FR" "$P_N"
  printf "%b║%b  %bCRIT%b %3s  %b\n" "$FR" "$P_N" "$P_R" "$crit" "$(bar "$crit" "$P_R")"
  printf "%b║%b  %bHIGH%b %3s  %b\n" "$FR" "$P_N" "$P_O" "$high" "$(bar "$high" "$P_O")"
  printf "%b║%b  %bMED %b %3s  %b\n" "$FR" "$P_N" "$P_Y" "$med"  "$(bar "$med"  "$P_Y")"
  printf "%b║%b  %bLOW %b %3s  %b\n" "$FR" "$P_N" "$P_GR" "$low" "$(bar "$low"  "$P_GR")"
  printf "%b╠══════════════════════════════════════════════════════════════╣%b\n" "$FR" "$P_N"
  if [ "$((crit+high))" -gt 0 ]; then
    printf "%b║%b  %btop issues%b\n" "$FR" "$P_N" "$P_W" "$P_N"
    jq -r '[.[]|select(.severity=="CRITICAL" or .severity=="HIGH")][0:5][]
           | "  ◆ ["+.severity+"] "+.service+" "+.resource+" — "+.issue' "$FINDINGS_JSON" 2>/dev/null \
      | cut -c1-62 | while IFS= read -r l; do printf "%b║%b%b%-62s%b\n" "$FR" "$P_N" "$P_R" "$l" "$P_N"; done
  else
    printf "%b║%b  %b✓ no CRITICAL/HIGH findings%b\n" "$FR" "$P_N" "$P_G" "$P_N"
  fi
  printf "%b╚══════════════════════════════════════════════════════════════╝%b\n" "$FR" "$P_N"
  printf "  %breport:%b %s\n\n" "$P_GR" "$P_N" "$REPORT"
}

# ================================================================ MAIN ========
audit_iam
audit_s3
for reg in ${AUDIT_REGIONS//,/ }; do
  sec "Region $reg (EC2 / RDS / Logs / Lambda)"
  audit_ec2 "$reg"; audit_rds "$reg"; audit_logs "$reg"; audit_lambda "$reg"
done
audit_security_posture
audit_cost
build_report
[ "$QUIET" = 1 ] || render_pixel_report

log ""
log "${C_G}AUDIT COMPLETE${C_N}  findings=$(jq length "$FINDINGS_JSON")  report=$REPORT"
[ "$QUIET" = 1 ] && echo "$AUDIT_OUTPUT_DIR"
exit 0
