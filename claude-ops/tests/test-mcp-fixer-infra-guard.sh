#!/usr/bin/env bash
# Checks the MCP fixer's infra guard blocks destructive cloud commands and lets
# the fixer's real work through.
#
# The cases live inside this file rather than on the command line for the same
# reason as the outbound-guard suite: a machine running this may itself have a
# PreToolUse guard watching Bash commands, and a test that spelled the patterns
# out as arguments would be blocked before it ran.
#
# run-all.sh invokes suites with bash, so the Python driver is embedded here
# rather than registered as a .py suite.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="${MCP_FIXER_INFRA_HOOK:-$HERE/../hooks/mcp-fixer-infra-guard.py}"

if [ ! -f "$HOOK" ]; then
  echo "FAIL: infra guard hook not found at $HOOK"
  exit 1
fi

# The fixer wires the hook in itself; if that wiring is dropped the guard is
# inert no matter how well it matches, so assert the invocation too.
FIXER="$HERE/../scripts/ops-mcp-fixer.sh"
if ! grep -q -- "--settings" "$FIXER"; then
  echo "FAIL: ops-mcp-fixer.sh no longer passes --settings; the guard would not load"
  exit 1
fi
if ! grep -q "mcp-fixer-infra-guard.py" "$FIXER"; then
  echo "FAIL: ops-mcp-fixer.sh no longer references the guard hook"
  exit 1
fi

python3 - "$HOOK" <<'PY'
import json
import subprocess
import sys

HOOK = sys.argv[1]

# The two commands from the incident that motivated this guard, plus the
# evasions worth caring about: extra spacing, and a global flag placed before
# the service word.
MUST_BLOCK = [
    ("stop an instance", "aws ec2 stop-instances --instance-ids i-0123456789abcdef0"),
    ("clear stop-protection", "aws ec2 modify-instance-attribute --instance-id i-0123456789abcdef0 --no-disable-api-stop"),
    ("spacing evasion", "aws   ec2    stop-instances  --instance-ids i-0123456789abcdef0"),
    ("global flag first", "aws --region us-east-1 ec2 terminate-instances --instance-ids i-0123456789abcdef0"),
    ("reboot an instance", "aws ec2 reboot-instances --instance-ids i-0123456789abcdef0"),
    ("security group edit", "aws ec2 revoke-security-group-ingress --group-id sg-0123 --port 443"),
    ("remove its own guard policy", "aws iam delete-user-policy --user-name someone --policy-name deny-stop"),
    ("stop a database", "aws rds stop-db-instance --db-instance-identifier prod"),
    ("delete an accelerator", "aws globalaccelerator delete-accelerator --accelerator-arn arn:aws:x"),
    ("recursive bucket wipe", "aws s3 rm s3://some-bucket/ --recursive"),
    ("remote shutdown", "ssh user@host sudo shutdown -h now"),
    ("terraform destroy", "terraform destroy -auto-approve"),
    # A flag in one segment must not vouch for the next. Without per-segment
    # evaluation the --dry-run here exempted the whole string, which is the
    # most dangerous shape this guard can be in: it reads as protected.
    ("dry-run does not exempt a chained mutation",
     "aws ec2 describe-instances --dry-run && aws ec2 stop-instances --instance-ids i-0123456789abcdef0"),
    ("mutation after a semicolon",
     "echo starting; aws ec2 terminate-instances --instance-ids i-0123456789abcdef0"),
    ("mutation piped onward",
     "aws ec2 stop-instances --instance-ids i-0123456789abcdef0 | tee /tmp/out"),
    # rb takes --force, not --recursive, and removes the bucket outright.
    ("bucket removal with --force", "aws s3 rb s3://some-bucket --force"),
    # Global options may precede the subcommand.
    ("terraform behind a global flag", "terraform -chdir=/infra destroy -auto-approve"),
]

# Everything the fixer legitimately does, including read-only cloud diagnosis.
MUST_PASS = [
    ("describe instances", "aws ec2 describe-instances --instance-ids i-0123456789abcdef0"),
    ("dry run is a read", "aws ec2 stop-instances --instance-ids i-0123456789abcdef0 --dry-run"),
    ("ssm port forward", "aws ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartPortForwardingSessionToRemoteHost"),
    ("restart a launchd service", "launchctl kickstart -k gui/501/com.example.service"),
    ("restart a systemd service", "ssh user@host sudo systemctl restart someservice"),
    ("clear an npx cache entry", "rm -rf ~/.npm/_npx/abc123"),
    ("probe a local MCP", "curl -sS http://127.0.0.1:8092/health"),
    ("read cloudtrail", "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopInstances"),
    # The exemption is per segment, so it still holds when the dry run is the
    # segment that carries it.
    ("read chained with a genuine dry run",
     "aws ec2 describe-instances && aws ec2 stop-instances --instance-ids i-0123456789abcdef0 --dry-run"),
    ("single object delete is not a bucket wipe", "aws s3 rm s3://some-bucket/one-file.txt"),
    ("non-Bash tool is ignored", None),
]


def blocked(command, tool="Bash"):
    payload = {"tool_name": tool, "tool_input": {"command": command} if command else {}}
    out = subprocess.run(
        ["python3", HOOK],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=15,
    )
    if out.returncode != 0:
        raise AssertionError(f"hook exited {out.returncode}: {out.stderr[:200]}")
    if not out.stdout.strip():
        return False
    decision = json.loads(out.stdout)
    return decision["hookSpecificOutput"]["permissionDecision"] == "deny"


failures = 0

for name, command in MUST_BLOCK:
    try:
        if blocked(command):
            print(f"  ok    blocked: {name}")
        else:
            print(f"  FAIL  allowed but must block: {name}")
            failures += 1
    except Exception as exc:
        print(f"  FAIL  errored on {name}: {exc}")
        failures += 1

for name, command in MUST_PASS:
    try:
        tool = "Bash" if command else "Read"
        if blocked(command, tool=tool):
            print(f"  FAIL  blocked but must allow: {name}")
            failures += 1
        else:
            print(f"  ok    allowed: {name}")
    except Exception as exc:
        print(f"  FAIL  errored on {name}: {exc}")
        failures += 1

# A guard that crashes the fixer is worse than the fault it guards against, so
# malformed input must be a silent allow rather than a traceback.
malformed = subprocess.run(
    ["python3", HOOK], input="not json", capture_output=True, text=True, timeout=15
)
if malformed.returncode == 0 and not malformed.stdout.strip():
    print("  ok    malformed input allows rather than crashing")
else:
    print(f"  FAIL  malformed input: rc={malformed.returncode} out={malformed.stdout[:80]}")
    failures += 1

total = len(MUST_BLOCK) + len(MUST_PASS) + 1
print(f"\nmcp-fixer-infra-guard: {total - failures}/{total} checks passed")
sys.exit(1 if failures else 0)
PY
