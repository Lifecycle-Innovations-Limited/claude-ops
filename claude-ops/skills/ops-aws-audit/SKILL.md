---
name: ops-aws-audit
description: Read-only AWS account hygiene audit — security baseline, unused/orphaned resources, and cost optimization across all configured regions. Produces severity-ranked findings (CRITICAL→LOW) plus a machine-readable findings.json. Cleanup actions are always human-gated, never automatic. Use for cost reviews, security sweeps, recurring account hygiene, or "audit my AWS".
argument-hint: '[--quiet] [--schedule] [region,region]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - WebSearch
  - WebFetch
effort: medium
maxTurns: 30
---

## What this does

Runs `scripts/ops-aws-audit.sh` — a **read-only** sweep that never mutates AWS.
It inventories and analyses, then writes a severity-ranked report.

Checks include (2026 baseline):

- **IAM / credentials** — root access key + root MFA, access keys older than
  `AUDIT_KEY_AGE_DAYS` (default 90), console users without MFA, and whether an
  **IAM Access Analyzer (UNUSED_ACCESS)** is configured.
- **EC2 / EBS** — unattached volumes, `gp2`→`gp3` candidates, unencrypted
  volumes, unassociated Elastic IPs, security groups open to `0.0.0.0/0` on
  SSH/RDP.
- **RDS** — unencrypted or publicly-accessible instances, and **orphaned manual
  snapshots** whose source DB no longer exists.
- **S3** — account-level Block Public Access, per-bucket default encryption and
  lifecycle policies.
- **CloudWatch Logs** — log groups with no retention (billed forever).
- **Lambda** — deprecated/old runtimes.
- **Security posture** — GuardDuty, Security Hub standards, Cost Anomaly
  Detection monitors, Compute Optimizer enrollment.
- **Cost** — per-service spend over the last `AUDIT_COST_DAYS` with the Δ vs the
  prior window (surfaces spend spikes, per ops cost-leak doctrine).

## Configuration (env, all optional)

| Var                  | Default                           | Meaning                                                                     |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `AUDIT_PROFILE`      | _(unset)_                         | Named AWS profile. Unset ⇒ standard chain (env keys / instance role / SSO). |
| `AUDIT_REGIONS`      | `$AWS_REGION` or `us-east-1`      | Comma-separated regions.                                                    |
| `AUDIT_OUTPUT_DIR`   | `~/.aws-audit-history/audit-<ts>` | Where reports land.                                                         |
| `AUDIT_KEY_AGE_DAYS` | `90`                              | Active access-key age threshold.                                            |
| `AUDIT_COST_DAYS`    | `7`                               | Cost comparison window.                                                     |

## How to run

```bash
# one region, current account
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ops-aws-audit.sh"

# multi-region + named profile
AUDIT_PROFILE=prod AUDIT_REGIONS=us-east-1,eu-central-1 \
  bash "${CLAUDE_PLUGIN_ROOT}/scripts/ops-aws-audit.sh"
```

Outputs in `AUDIT_OUTPUT_DIR`: `report.md` (human), `findings.json`
(machine), `raw/` (per-service snapshots + `cost-delta.tsv`), `audit.log`.

After the run, read `findings.json` and summarise CRITICAL/HIGH first.

## Recurring schedule

`--schedule` installs a daily `systemd --user` timer via
`scripts/install-aws-audit-cron.sh` (Linux; this box uses systemd, not launchd):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-aws-audit-cron.sh"
systemctl --user list-timers ops-aws-audit.timer
```

Dispatch to the background fleet instead:

```bash
claude --bg --name aws-audit -- bash "${CLAUDE_PLUGIN_ROOT}/scripts/ops-aws-audit.sh" --quiet
```

## Cleanup is human-gated (never automatic)

This skill **only audits**. To act on a finding:

1. Show the user the specific finding(s) and the exact `aws` command(s).
2. Get explicit per-batch approval (`ok` / `yes` / `proceed`).
3. For any deletion/rotation, snapshot state first; log resource IDs after.
4. **Root access keys can only be removed from a root console login** — flag it,
   do not attempt to "rotate root" from an IAM-user CLI session (that only
   rotates the IAM user's own key, not the root key).
