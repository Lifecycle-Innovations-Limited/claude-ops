# CLI/API reference

## CLI/API Reference

### gh CLI (GitHub)

| Command                                                                                          | Usage                | Output       |
| ------------------------------------------------------------------------------------------------ | -------------------- | ------------ |
| `gh pr list --state open --json number,title,statusCheckRollup,reviewDecision,mergeable,isDraft` | Open PRs with status | JSON array   |
| `gh pr view <n> --repo <repo> --json files,additions,deletions`                                  | PR file diff summary | JSON         |
| `gh pr checks <n>`                                                                               | CI check status      | Check list   |
| `gh pr merge <n> --squash`                                                                       | Squash merge PR      | Merge result |
| `gh run list --repo <repo> --workflow "<workflow>" --limit 5 --json conclusion,headBranch`       | CI runs for workflow | JSON array   |
| `gh run view <id> --repo <repo> --log-failed`                                                    | Failed CI logs       | Log output   |
| `gh issue list --state open`                                                                     | Open issues          | JSON array   |

### sentry-cli / Sentry API

| Command                                                                                                                          | Usage             | Output     |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------- |
| `sentry-cli issues list --project <slug> --status unresolved`                                                                    | Unresolved issues | Issue list |
| `curl -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "https://sentry.io/api/0/projects/<org>/<proj>/issues/?query=is:unresolved"` | API fallback      | JSON array |

### Linear GraphQL (fallback when MCP unavailable)

| Command                                                                                                                                                                                                                                                                        | Usage         | Output |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------ |
| `curl -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" -d '{"query":"{ issues(filter: {state: {type: {in: [\"started\",\"unstarted\"]}}}) { nodes { id title state { name } priority assignee { name } } } }"}'` | Active issues | JSON   |

---

You are the **master orchestrator**. Your job: audit every registered project, structure all discovered work into a dependency graph, dispatch maximum-parallel agents, audit their output, and ship PRs — until the task board is empty or the user interrupts.

**No preamble. No "would you like me to". Execute immediately.**

---

