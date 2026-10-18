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
REPORT_ONLY=0; [ "${1:-}" = "--report-only" ] && REPORT_ONLY=1

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

# epoch helper: ISO8601 -> epoch seconds, independent of date implementation/TZ.
epoch() {
  python3 -I - "$1" <<'DATE_PY'
from datetime import datetime
import sys
try:
    value = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("timezone required")
    print(int(value.timestamp()))
except (ValueError, OverflowError):
    print("audit: invalid key timestamp; age unknown", file=sys.stderr)
    sys.exit(1)
DATE_PY
}
NOW=$(date +%s)
age_days() {
  local parsed
  parsed=$(epoch "$1") || return 1
  echo $(( (NOW - parsed) / 86400 ))
}

# finding SEV SERVICE REGION RESOURCE ISSUE RECOMMENDATION [EST_MONTHLY_USD]
finding() {
  jq -nc --arg sev "$1" --arg svc "$2" --arg reg "$3" --arg res "$4" \
         --arg iss "$5" --arg rec "$6" --argjson usd "${7:-0}" \
    '{severity:$sev,service:$svc,region:$reg,resource:$res,title:($res+" "+$iss),issue:$iss,recommendation:$rec,est_monthly_usd:$usd}' \
    >>"$FINDINGS_JSONL"
}

COVERAGE_JSON="$AUDIT_OUTPUT_DIR/coverage.json"
RUNTIME_POLICY="${AUDIT_RUNTIME_POLICY:-$(cd "$(dirname "$0")" && pwd)/lambda-runtime-policy.json}"
AUDIT_DATE="${AUDIT_DATE:-$(date -u +%F)}"

# cover KEY STATUS STDERR — a denial is never recorded as ok or absent.
cover() {
  local key="$1" status="$2" detail="${3:-}"
  COVERAGE_JSON="$COVERAGE_JSON" python3 -I - "$key" "$status" "$detail" <<'COVER_PY'
import json, os, sys
path = os.environ["COVERAGE_JSON"]
key, status, detail = sys.argv[1:]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data[key] = {"status": status, "stderr": detail[-2000:]}
json.dump(data, open(path, "w"))
COVER_PY
}

# aws_capture KEY outfile -- aws-args...  Denied stays denied. Stderr is kept.
aws_capture() {
  local key="$1" dest="$2"; shift 2
  local errf="$dest.stderr"
  if AWS_PAGER="" "$@" >"$dest" 2>"$errf"; then
    cover "$key" ok ""
    return 0
  fi
  local detail; detail=$(cat "$errf" 2>/dev/null || true)
  printf '%s\n' "$detail" >>"$LOG"
  if grep -Eq 'AccessDenied|UnauthorizedOperation|AccessDeniedException|not authorized|explicit deny' <<<"$detail"; then
    cover "$key" denied "$detail"
  else
    cover "$key" error "$detail"
  fi
  return 1
}

# aws_pages KEY dest JMES -- aws-args...  Every NextToken page is required.
aws_pages() {
  local key="$1" dest="$2" query="$3"; shift 3
  local token="" page=0 piece combined="[]"
  : >"$dest"
  while :; do
    page=$((page + 1))
    piece="$dest.p${page}"
    local args=("$@")
    [ -n "$token" ] && args+=(--starting-token "$token")
    if ! aws_capture "${key}-p${page}" "$piece" "${args[@]}"; then
      local st; st=$(COVERAGE_JSON="$COVERAGE_JSON" python3 -I -c 'import json,os,sys; print(json.load(open(os.environ["COVERAGE_JSON"])).get(sys.argv[1],{}).get("status","error"))' "${key}-p${page}")
      cover "$key" "$st" "$(cat "$piece.stderr" 2>/dev/null || true)"
      return 1
    fi
    combined=$(python3 -I -c 'import json,sys; a=json.loads(sys.argv[1] or "[]"); b=json.loads(sys.stdin.read() or "[]"); json.dump(a+(b if isinstance(b, list) else []), sys.stdout)' "$combined" <<<"$(jq -c "$query // []" "$piece")")
    token=$(jq -r '.NextToken // empty' "$piece")
    [ -z "$token" ] && break
  done
  printf '%s\n' "$combined" >"$dest"
  cover "$key" ok ""
}

# True when the pinned official policy marks this runtime stale on AUDIT_DATE.
runtime_stale() {
  python3 -I - "$RUNTIME_POLICY" "$1" "$AUDIT_DATE" <<'RUNTIME_PY'
import json, sys
from datetime import date
policy, runtime, audit = sys.argv[1:]
day = date.fromisoformat(audit)
data = json.load(open(policy))
for row in data["deprecated"] + data["supported"]:
    if row["id"] == runtime:
        when = row.get("deprecation")
        raise SystemExit(0 if when and day >= date.fromisoformat(when) else 1)
raise SystemExit(2)
RUNTIME_PY
}

require() {
  command -v python3 >/dev/null || { echo "FATAL: python3 not found"; exit 2; }
  command -v aws >/dev/null || { echo "FATAL: aws CLI not found"; exit 2; }
  command -v jq  >/dev/null || { echo "FATAL: jq not found";      exit 2; }
}

# ------------------------------------------------------------------ INIT ------
require
mkdir -p "$RAW"; : >"$FINDINGS_JSONL"; : >"$LOG"
if [ "$REPORT_ONLY" = 1 ]; then
  if ! jq empty "$FINDINGS_JSON" >/dev/null 2>&1; then
    err "findings JSON invalid; refusing an empty report"
    exit 1
  fi
  build_report || exit 1
  exit 0
fi
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

  # Read an existing credential report only. generate-credential-report overwrites
  # the account report (IAM User Guide) and is excluded from this read-only audit.
  if aws_capture iam-credential-report "$RAW/credential-report.json" \
       AWS iam get-credential-report --output json; then
    ok "credential report"
    python3 -I - "$RAW/credential-report.json" "$RAW/credential-report.csv" <<'CSV_PY'
import base64, json, sys
payload = json.load(open(sys.argv[1]))
open(sys.argv[2], "wb").write(base64.b64decode(payload.get("Content") or ""))
CSV_PY
    python3 -I - "$RAW/credential-report.csv" "$KEY_AGE_DAYS" "$FINDINGS_JSONL" "$AUDIT_DATE" <<'IAM_PY'
import csv, json, sys
from datetime import date, datetime, timezone
path, limit, out, audit = sys.argv[1:]
limit = int(limit)
now = datetime.combine(date.fromisoformat(audit), datetime.min.time(), timezone.utc)

def age(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return (now - parsed).days

def emit(sev, resource, issue, rec):
    row = {"severity": sev, "service": "IAM", "region": "global", "resource": resource,
           "title": f"{resource} {issue}", "issue": issue, "recommendation": rec, "est_monthly_usd": 0}
    with open(out, "a") as handle:
        handle.write(json.dumps(row) + "\n")

with open(path, newline="") as handle:
    for row in csv.DictReader(handle):
        user = row.get("user") or ""
        if user == "<root_account>":
            if row.get("mfa_active") == "false":
                emit("CRITICAL", "root", "Root account has no MFA", "Enable a hardware/virtual MFA device on the root user")
            for number, active, rotated, used in (
                ("1", row.get("access_key_1_active"), row.get("access_key_1_last_rotated"), row.get("access_key_1_last_used_date")),
                ("2", row.get("access_key_2_active"), row.get("access_key_2_last_rotated"), row.get("access_key_2_last_used_date")),
            ):
                if active == "true":
                    emit("CRITICAL", f"root access key {number}",
                         f"Root account has an ACTIVE access key {number} (last used: {used})",
                         "Delete the root access key; use IAM roles/users for API access (requires root console login)")
            continue
        if row.get("password_enabled") == "true" and row.get("mfa_active") == "false":
            emit("HIGH", f"user/{user}", "Console password enabled but no MFA", "Enforce MFA for this user")
        for number, active, rotated in (
            ("1", row.get("access_key_1_active"), row.get("access_key_1_last_rotated")),
            ("2", row.get("access_key_2_active"), row.get("access_key_2_last_rotated")),
        ):
            if active == "true" and rotated and rotated != "N/A":
                days = age(rotated)
                if days is not None and days > limit:
                    emit("HIGH", f"user/{user}", f"Active access key #{number} is {days}d old (>{limit}d)", "Rotate the access key and remove the old one")
IAM_PY
  else
    err "credential report read failed; absence is not assumed"
  fi

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
  if aws_pages "ec2-volumes-$reg" "$RAW/ebs-volumes-$reg.json" '.Volumes' \
       AWSR "$reg" ec2 describe-volumes --output json; then
    jq -c '.[]|{id:.VolumeId,size:.Size,type:.VolumeType,state:.State,enc:.Encrypted}' "$RAW/ebs-volumes-$reg.json" | while read -r v; do
      id=$(jq -r .id <<<"$v"); sz=$(jq -r .size <<<"$v"); ty=$(jq -r .type <<<"$v")
      st=$(jq -r .state <<<"$v"); enc=$(jq -r .enc <<<"$v")
      [ "$st" = "available" ] && finding MEDIUM EC2 "$reg" "$id" "Unattached EBS volume (${sz}GiB ${ty}) still billed" "Snapshot then delete if unneeded" "$(awk "BEGIN{printf \"%.2f\", $sz*0.08}")"
      [ "$ty" = "gp2" ] && finding LOW EC2 "$reg" "$id" "Volume is gp2" "Migrate to gp3 (~20% cheaper, same/ better perf)" "$(awk "BEGIN{printf \"%.2f\", $sz*0.02}")"
      [ "$enc" = "false" ] && finding HIGH EC2 "$reg" "$id" "EBS volume is unencrypted" "Recreate from encrypted snapshot; enable EBS encryption-by-default" 0
    done
  else
    err "EBS volumes unreadable in $reg; absence is not assumed"
  fi

  # unassociated Elastic IPs (~$3.60/mo each)
  AWSR "$reg" ec2 describe-addresses --query 'Addresses[?AssociationId==null].AllocationId' --output text 2>/dev/null | tr '\t' '\n' | while read -r eip; do
    [ -n "$eip" ] && finding MEDIUM EC2 "$reg" "$eip" "Unassociated Elastic IP (billed hourly)" "Release the EIP if not needed" 3.60
  done

  # Admin ports include ranges and IPv6. Protocol -1 is a raw string, not a number.
  if aws_pages "ec2-sg-$reg" "$RAW/sg-$reg.json" '.SecurityGroups' \
       AWSR "$reg" ec2 describe-security-groups --output json; then
    python3 -I - "$RAW/sg-$reg.json" "$FINDINGS_JSONL" "$reg" <<'SG_PY'
import json, sys
path, out, region = sys.argv[1:]
groups = json.load(open(path))
ADMIN = {22, 3389}

def world(perm):
    v4 = any(r.get("CidrIp") == "0.0.0.0/0" for r in perm.get("IpRanges") or [])
    v6 = any(r.get("CidrIpv6") == "::/0" for r in perm.get("Ipv6Ranges") or [])
    return v4 or v6

def covers_admin(perm):
    if str(perm.get("IpProtocol")) == "-1":
        return True
    start, end = perm.get("FromPort"), perm.get("ToPort")
    if start is None or end is None:
        return False
    return any(start <= port <= end for port in ADMIN)

for group in groups:
    for perm in group.get("IpPermissions") or []:
        if world(perm) and covers_admin(perm):
            row = {"severity": "HIGH", "service": "EC2", "region": region,
                   "resource": group["GroupId"],
                   "title": group["GroupId"] + " Security group allows world access to SSH/RDP or all protocols",
                   "issue": "Security group allows world access to SSH/RDP or all protocols",
                   "recommendation": "Restrict to known CIDRs or use SSM Session Manager",
                   "est_monthly_usd": 0}
            open(out, "a").write(json.dumps(row) + "\n")
            break
SG_PY
  else
    err "security groups unreadable in $reg; open groups are not assumed absent"
  fi
}

# ============================================================ RDS (regional) =
audit_rds() {
  local reg="$1"
  local instances_ok=0 clusters_ok=0
  if aws_pages "rds-instances-$reg" "$RAW/rds-instances-$reg.json" '.DBInstances' \
       AWSR "$reg" rds describe-db-instances --output json; then
    instances_ok=1
    jq -c '.[]|{id:.DBInstanceIdentifier,enc:.StorageEncrypted,public:.PubliclyAccessible}' "$RAW/rds-instances-$reg.json" | while read -r d; do
      id=$(jq -r .id <<<"$d")
      [ "$(jq -r .enc <<<"$d")" = "false" ] && finding HIGH RDS "$reg" "$id" "RDS storage not encrypted" "Re-create from encrypted snapshot" 0
      [ "$(jq -r .public <<<"$d")" = "true" ] && finding HIGH RDS "$reg" "$id" "RDS instance is publicly accessible" "Disable public accessibility; place in private subnet" 0
    done
  else
    err "RDS instances unreadable in $reg"
  fi
  if aws_pages "rds-clusters-$reg" "$RAW/rds-clusters-$reg.json" '.DBClusters' \
       AWSR "$reg" rds describe-db-clusters --output json; then
    clusters_ok=1
  else
    err "RDS clusters unreadable in $reg"
  fi
  # Successful empty inventories are real. A denial must not turn a live source into an orphan.
  if aws_pages "rds-snapshots-$reg" "$RAW/rds-snapshots-$reg.json" '.DBSnapshots' \
       AWSR "$reg" rds describe-db-snapshots --snapshot-type manual --output json; then
    if [ "$instances_ok" = 1 ] && [ "$clusters_ok" = 1 ]; then
      python3 -I - "$RAW/rds-instances-$reg.json" "$RAW/rds-clusters-$reg.json" "$RAW/rds-snapshots-$reg.json" "$FINDINGS_JSONL" "$reg" <<'RDS_PY'
import json, sys
instances, clusters, snaps, out, region = sys.argv[1:]
live = {row.get("DBInstanceIdentifier") for row in json.load(open(instances))}
live |= {row.get("DBClusterIdentifier") for row in json.load(open(clusters))}
live.discard(None)
for snap in json.load(open(snaps)):
    if snap.get("SnapshotType") not in (None, "manual"):
        continue
    source = snap.get("DBInstanceIdentifier") or snap.get("DBClusterIdentifier")
    if source and source not in live:
        row = {"severity": "MEDIUM", "service": "RDS", "region": region, "resource": snap["DBSnapshotIdentifier"],
               "title": snap["DBSnapshotIdentifier"] + " orphaned manual snapshot",
               "issue": f"Manual snapshot whose source '{source}' no longer exists",
               "recommendation": "Delete if no recovery value", "est_monthly_usd": 0}
        open(out, "a").write(json.dumps(row) + "\n")
RDS_PY
    else
      err "RDS orphan check skipped in $reg because the source inventory was not fully readable"
    fi
  fi
}

# ========================================================= S3 (global-ish) ===
audit_s3() {
  sec "S3"
  local bpa_file="$RAW/s3-public-access-block.json"
  if aws_capture s3-public-access-block "$bpa_file" \
       AWS s3control get-public-access-block --account-id "$ACCOUNT" --output json; then
    local enabled
    enabled=$(jq '[.PublicAccessBlockConfiguration.BlockPublicAcls,.PublicAccessBlockConfiguration.IgnorePublicAcls,.PublicAccessBlockConfiguration.BlockPublicPolicy,.PublicAccessBlockConfiguration.RestrictPublicBuckets]|map(select(.==true))|length' "$bpa_file")
    if [ "$enabled" -lt 4 ]; then
      finding HIGH S3 global "account" "Account-level S3 Block Public Access is not fully enabled" "Enable all 4 BPA settings at the account level" 0
    else ok "account BPA fully enabled"; fi
  else
    err "account Block Public Access unreadable; not reported as disabled"
    finding HIGH S3 global "account" "Account-level S3 Block Public Access read denied" "Retry with s3:GetAccountPublicAccessBlock; do not treat denial as disabled" 0
  fi

  if ! aws_capture s3-buckets "$RAW/s3-buckets.json" AWS s3api list-buckets --output json; then
    err "bucket list denied; bucket checks are not complete"
    return
  fi
  jq -r '.Buckets[].Name' "$RAW/s3-buckets.json" | while read -r b; do
    [ -z "$b" ] && continue
    local enc="$RAW/s3-enc-$b.json" life="$RAW/s3-life-$b.json" policy="$RAW/s3-policy-$b.json"
    if ! aws_capture "s3-bucket-encryption:$b" "$enc" AWS s3api get-bucket-encryption --bucket "$b" --output json; then
      if grep -q 'ServerSideEncryptionConfigurationNotFoundError\|does not exist' "$enc.stderr" 2>/dev/null; then
        finding MEDIUM S3 global "$b" "Bucket has no default encryption" "Enable SSE-S3 or SSE-KMS default encryption" 0
      else
        finding HIGH S3 global "$b" "Bucket encryption read denied" "Retry get-bucket-encryption; denial is not missing encryption" 0
      fi
    fi
    if ! aws_capture "s3-bucket-policy:$b" "$policy" AWS s3api get-bucket-policy --bucket "$b" --output json; then
      if grep -q 'NoSuchBucketPolicy' "$policy.stderr" 2>/dev/null; then
        : # a missing policy is not a finding and is not a denial
      else
        finding HIGH S3 global "$b" "Bucket policy read denied" "Retry get-bucket-policy; denial is not a missing policy" 0
      fi
    fi
    if ! aws_capture "s3-bucket-lifecycle:$b" "$life" AWS s3api get-bucket-lifecycle-configuration --bucket "$b" --output json; then
      if grep -q 'NoSuchLifecycleConfiguration' "$life.stderr" 2>/dev/null; then
        finding LOW S3 global "$b" "Bucket has no lifecycle policy" "Add lifecycle rules to expire/transition old objects" 0
      else
        finding HIGH S3 global "$b" "Bucket lifecycle read denied" "Retry get-bucket-lifecycle-configuration; denial is not a missing policy" 0
      fi
    fi
  done
  ok "bucket checks complete only for readable buckets"
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
  if ! aws_pages "lambda-$reg" "$RAW/lambda-$reg.json" '.Functions' \
       AWSR "$reg" lambda list-functions --output json; then
    err "Lambda list unreadable in $reg"
    return
  fi
  python3 -I - "$RAW/lambda-$reg.json" "$FINDINGS_JSONL" "$reg" "$RUNTIME_POLICY" "$AUDIT_DATE" <<'LAMBDA_PY'
import json, sys
from datetime import date
path, out, region, policy_path, audit = sys.argv[1:]
day = date.fromisoformat(audit)
policy = json.load(open(policy_path))
known = {row["id"]: row.get("deprecation") for row in policy["deprecated"] + policy["supported"]}
for fn in json.load(open(path)):
    runtime = fn.get("Runtime")
    if not runtime or runtime not in known:
        continue
    when = known[runtime]
    if when and day >= date.fromisoformat(when):
        row = {"severity": "MEDIUM", "service": "Lambda", "region": region, "resource": fn["FunctionName"],
               "title": fn["FunctionName"] + " stale runtime " + runtime,
               "issue": f"Runtime {runtime} deprecated on {when} (audit date {audit})",
               "recommendation": "Upgrade to a supported runtime", "est_monthly_usd": 0}
        open(out, "a").write(json.dumps(row) + "\n")
LAMBDA_PY
}

# ============================================ Security service enrollment =====
audit_security_posture() {
  sec "Security posture (GuardDuty / Security Hub / Cost Anomaly / Compute Optimizer)"
  local reg gd sh
  for reg in ${AUDIT_REGIONS//,/ }; do
    if aws_capture "guardduty-$reg" "$RAW/guardduty-$reg.json" \
         AWSR "$reg" guardduty list-detectors --output json; then
      gd=$(jq -r '.DetectorIds|length' "$RAW/guardduty-$reg.json")
      [ "$gd" = 0 ] && finding MEDIUM GuardDuty "$reg" "account" "GuardDuty not enabled" "Enable GuardDuty for threat detection" 0
    else
      err "GuardDuty unreadable in $reg; not reported as disabled"
    fi
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
  if ! aws_capture cost-current "$RAW/cost-current.json" \
       AWS ce get-cost-and-usage --time-period Start=$s,End=$e --granularity DAILY --metrics UnblendedCost \
         --filter "$USAGE_FILTER" --group-by Type=DIMENSION,Key=SERVICE --output json; then
    err "cost read denied; a zero baseline is not invented"
    return
  fi
  if ! aws_capture cost-prev "$RAW/cost-prev.json" \
       AWS ce get-cost-and-usage --time-period Start=$p,End=$s --granularity DAILY --metrics UnblendedCost \
         --filter "$USAGE_FILTER" --group-by Type=DIMENSION,Key=SERVICE --output json; then
    err "prior cost window denied; delta is not computed against zero"
    return
  fi
  python3 -I - "$RAW/cost-current.json" "$RAW/cost-prev.json" "$RAW/cost-current.tsv" "$RAW/cost-prev.tsv" <<'COST_PY'
import json, sys
current, previous, cur_out, prev_out = sys.argv[1:]

def totals(path):
    data = json.load(open(path))
    sums = {}
    for window in data.get("ResultsByTime") or []:
        for group in window.get("Groups") or []:
            key = group["Keys"][0]
            sums[key] = sums.get(key, 0) + float(group["Metrics"]["UnblendedCost"]["Amount"])
    return sums

def write(path, sums):
    with open(path, "w") as handle:
        for key in sorted(sums):
            handle.write(f"{key}\t{sums[key]:.2f}\n")

write(cur_out, totals(current))
write(prev_out, totals(previous))
COST_PY
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
  if ! jq -s '.' "$FINDINGS_JSONL" >"$FINDINGS_JSON"; then
    err "findings.jsonl is not valid JSON; refusing an empty report"
    return 1
  fi
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
if ! build_report; then
  err "report aborted: findings JSON invalid"
  exit 1
fi
[ "$QUIET" = 1 ] || render_pixel_report

log ""
log "${C_G}AUDIT COMPLETE${C_N}  findings=$(jq length "$FINDINGS_JSON")  report=$REPORT"
[ "$QUIET" = 1 ] && echo "$AUDIT_OUTPUT_DIR"
if jq -e 'to_entries|map(select(.value.status=="denied" or .value.status=="error"))|length>0' "$COVERAGE_JSON" >/dev/null 2>&1; then
  err "coverage incomplete: a denied or failed read is not a clean audit"
  exit 1
fi
exit 0
