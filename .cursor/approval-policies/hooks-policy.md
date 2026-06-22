# Safety hooks approval policy

## Default posture

**Never auto-approve.** All hook changes require human review.

## Rationale

Hooks enforce secret scanning, destructive command blocks, main-branch push warnings, deploy monitoring, and agent routing. Regressions here affect every Claude Code session using this plugin.

## Approve only after human review confirms

- No weakening of existing PreToolUse or PostToolUse guards
- Secret-scan patterns remain at least as strict as base branch
- rm-rf / main-push / credential-commit protections are intact
- New hooks fail closed (deny or warn) rather than silently no-op on error

## Reviewer routing

- Always request `@Lifecycle-Innovations-Limited/platform` or equivalent repo maintainers
- If Security Agent reports any finding: block approval until resolved or explicitly waived by a maintainer comment
