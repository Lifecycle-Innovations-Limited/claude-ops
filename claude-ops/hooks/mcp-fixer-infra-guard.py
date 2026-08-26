#!/usr/bin/env python3
"""PreToolUse guard for the headless MCP fixer agent.

The fixer is dispatched unattended by ops-mcp-watchdog and runs with
`--dangerously-skip-permissions`, so it inherits whatever cloud credentials the
user's shell has. Its remit is local MCP servers and the services backing them;
it has no reason to mutate cloud infrastructure.

This exists because of a real incident. A fixer run dispatched for an unrelated
`whatsapp: unreachable` fault decided the fix was to stop an EC2 instance. It
first cleared the instance's stop-protection attribute, then stopped it. That
instance hosted the user's LLM proxy, so the action took down every model call
on the machine, including the fixer's own, which then failed on the resulting
gateway error. Two hours of debugging pointed at the proxy before anyone
suspected the repair agent.

Prompt wording alone does not prevent this; a denied tool call does. Read-only
calls stay allowed, because diagnosis legitimately needs them.

Contract: PreToolUse hook. Reads the tool call as JSON on stdin, writes a JSON
permission decision on stdout. Unmatched commands are allowed. Never raises:
a guard that crashes the fixer is worse than the fault it guards against.
"""

import json
import re
import sys

# (pattern, human-readable reason). Matched against the whitespace-normalised
# command so `aws   ec2  stop-instances` cannot slip through on spacing, and
# with the subcommand decoupled from the service word so a global flag placed
# before it (`aws --region x ec2 stop-instances`) still matches.
DENY_PATTERNS = [
    # EC2 lifecycle, and the attribute that gates it. modify-instance-attribute
    # matters as much as stop-instances: it is how stop-protection gets cleared
    # immediately before a stop.
    (r"\baws\b.*\bec2\b.*\b(stop|terminate|reboot)-instances\b",
     "stopping, terminating or rebooting EC2 instances"),
    (r"\baws\b.*\bec2\b.*\bmodify-instance-attribute\b",
     "modifying EC2 instance attributes, including stop-protection"),
    (r"\baws\b.*\bec2\b.*\b(delete|release|disassociate|detach)-\w+",
     "deleting or releasing EC2 resources"),
    (r"\baws\b.*\bec2\b.*\b(revoke|authorize)-security-group-\w+",
     "changing security group rules"),
    # IAM. Listed explicitly because an agent that hits an explicit-deny policy
    # can otherwise decide the fix is to remove the policy.
    (r"\baws\b.*\biam\b.*\b(delete|put|attach|detach|create|update)-\w+",
     "changing IAM identities or policies"),
    (r"\baws\b.*\b(rds|elasticache|dynamodb)\b.*\b(delete|stop|reboot|modify)-\w+",
     "mutating managed database or cache resources"),
    (r"\baws\b.*\b(globalaccelerator|cloudfront|route53|elbv2|elb)\b"
     r".*\b(delete|update|remove|deregister|disable)\w*",
     "mutating edge, DNS or load-balancer configuration"),
    (r"\baws\b.*\bs3\b.*\b(rb|rm)\b.*--recursive",
     "recursive S3 deletion"),
    (r"\baws\b.*\bs3api\b.*\bdelete-\w+",
     "S3 deletion"),
    (r"\bgcloud\b.*\b(compute|sql)\b.*\b(delete|stop|reset)\b",
     "mutating GCP compute or SQL resources"),
    (r"\baz\b\s+(vm|group|sql)\b.*\b(delete|stop|deallocate)\b",
     "mutating Azure resources"),
    (r"\bssh\b.*\b(shutdown|halt|poweroff|reboot)\b",
     "shutting down or rebooting a remote host"),
    (r"\bterraform\b\s+(destroy|apply)\b",
     "applying or destroying Terraform state"),
]

COMPILED = [(re.compile(p, re.IGNORECASE), why) for p, why in DENY_PATTERNS]

# A dry run asks the API to validate and change nothing, which is exactly the
# kind of read a diagnosing agent should be encouraged to make.
DRY_RUN = re.compile(r"--dry-run\b", re.IGNORECASE)

REASON_SUFFIX = (
    "This agent repairs local MCP servers and must not mutate cloud "
    "infrastructure. A previous run stopped the EC2 instance hosting the LLM "
    "proxy and took every model call on the machine down with it. If cloud "
    "infrastructure really is the root cause, that is a useful finding: do not "
    "act on it. Send one desktop notification naming the resource and the "
    "evidence, then stop."
)


def denial_reason(command):
    """Return a reason string if the command must be blocked, else None."""
    normalised = " ".join(command.split())
    if DRY_RUN.search(normalised):
        return None
    for pattern, why in COMPILED:
        if pattern.search(normalised):
            return why
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0

    command = payload.get("tool_input", {}).get("command", "")
    if not command:
        return 0

    why = denial_reason(command)
    if why is None:
        return 0

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"BLOCKED by mcp-fixer-infra-guard: {why}. {REASON_SUFFIX}"
                ),
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
