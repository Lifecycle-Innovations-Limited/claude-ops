# claude-ops — default approval policy

Repository-wide rules for Cursor Approval Agents evaluating pull requests in this repo.

## Purpose

claude-ops is a business operating system plugin for Claude Code. Changes can affect safety hooks, deploy automation, credential handling, and fleet orchestration. Default posture: **approve only when risk is low and automated review is clean**.

## Auto-approve when ALL are true

- PR is small and scoped (generally ≤ 300 changed lines, excluding lockfiles and generated docs)
- Bugbot Review Context reports no findings requiring human review
- Security Review Context reports no findings requiring human review (when enabled)
- Risk score is at or below the agent's configured maximum threshold
- CI checks required for the changed paths are green
- No changes under high-risk paths (see below) unless a more specific subtree policy explicitly allows it
- PR does not modify approval policy files, routing files, or safety-hook bypass logic

## Safe auto-approve examples

- Documentation-only edits under `claude-ops/docs/**`, `docs/**`, or `README.md`
- Test-only changes that do not alter production hook or deploy behavior
- Changelog, version bump, or badge updates with no runtime logic changes
- Typo or copy fixes in skills where behavior is unchanged

## Never auto-approve

- Any change to `hooks/**`, `claude-ops/hooks/**`, or safety-hook configuration
- Credential, secret, rotation, or auth flows (`**/credentials/**`, `**/rotate/**`, Doppler/1Password wiring)
- MCP server implementations (`claude-ops/mcp-servers/**`) that add network calls, file access, or new tool surfaces
- Launchd/daemon lifecycle changes (`claude-ops/launchd/**`, `claude-ops/scripts/**` that start/stop daemons)
- GitHub Actions workflow changes (`.github/workflows/**`) that weaken CI, skip tests, or broaden deploy permissions
- Deletions or relaxations of guardrails (rm-rf blocks, secret-scan hooks, main-branch push warnings)
- Changes that remove tests, disable lint/typecheck, or bypass pre-commit hooks
- PRs labeled `security`, `breaking`, or `do-not-auto-approve`

## Reviewer routing

When auto-approval is not allowed, request reviewers based on changed area:

| Changed area | Reviewers |
|--------------|-----------|
| Hooks / safety / deploy auto-fix | `@Lifecycle-Innovations-Limited/platform` or repo maintainers |
| MCP servers / external integrations | `@Lifecycle-Innovations-Limited/platform` |
| Plugin manifest / marketplace metadata | `@Lifecycle-Innovations-Limited/platform` |
| Docs-only | Any maintainer; no specialist required |

If reviewer assignment is unavailable, leave the PR unapproved and add a comment summarizing why human review is required.

## Deploy expectations

For changes that ship through dev → staging → main:

- Do not auto-approve solely because CI passed on the PR branch
- Require evidence that deploy-fix and health-check paths remain intact when touching deploy-related code
- Treat production-impacting script changes as **medium risk minimum**

## Conflict resolution

If this file conflicts with a closer `APPROVAL_POLICY.md` or a routed policy in `.cursor/approval-policies/`, follow the **more specific** policy. If specificity is unclear, follow the **stricter** rule and do not auto-approve.
