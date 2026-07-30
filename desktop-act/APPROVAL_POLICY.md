# desktop-act — default approval policy

Repository-wide rules for Cursor Approval Agents evaluating pull requests in this repo.

## Purpose

desktop-act default approval policy for Cursor Approval Agents.

Default posture: **approve only when risk is low and automated review is clean**.

## Auto-approve when ALL are true

- Bugbot Review Context reports no findings requiring human review
- Security Review Context reports no findings requiring human review (when enabled)
- Risk score is at or below the agent's configured maximum threshold
- CI checks required for the changed paths are green
- PR does not modify approval policy files or routing files
- Documentation-only or test-only PRs (≤ 300 lines excluding lockfiles)

## Never auto-approve

- GitHub Actions workflow changes that weaken CI, skip tests, or broaden deploy permissions
- Deletions or relaxations of auth, security, or safety guardrails
- Changes that remove tests, disable lint/typecheck, or bypass pre-commit hooks
- PRs labeled `security`, `breaking`, or `do-not-auto-approve`

## Reviewer routing

When auto-approval is not allowed, request repo maintainers or the appropriate team for the changed area. Leave the PR unapproved with a short comment if reviewer assignment is unavailable.

## Deploy expectations

For changes shipping dev → staging → main → production: do not auto-approve solely on green CI if production paths, migrations, or release config changed.

## Conflict resolution

Follow the most specific applicable policy. If unclear, follow the stricter rule and do not auto-approve.
