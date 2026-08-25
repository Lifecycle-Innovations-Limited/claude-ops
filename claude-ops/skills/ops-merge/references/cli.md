# CLI/API reference

## CLI/API Reference

### gh CLI (GitHub)

| Command                                                                                                                   | Usage                | Output                         |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------ |
| `gh pr list --repo <owner/repo> --json number,title,state,headRefName,statusCheckRollup,reviewDecision,mergeable,isDraft` | List PRs with status | JSON array                     |
| `gh pr view <n> --repo <repo> --json title,body,state,mergeable,reviews`                                                  | PR details           | JSON                           |
| `gh pr checks <n> --repo <repo>`                                                                                          | CI check status      | Check list                     |
| `gh pr merge <n> --repo <repo> --squash`                                                                                  | Squash merge PR      | Merge result                   |
| `gh pr create --repo <repo> --title "<t>" --body "<b>" --base dev`                                                        | Create PR            | PR URL                         |
| `gh run list --repo <repo> --limit 5 --json conclusion,name,headBranch`                                                   | CI runs              | JSON array                     |
| `gh run view <id> --repo <repo> --log-failed`                                                                             | Failed CI logs       | Log output                     |
| `gh api repos/<repo>/actions/runs/<run-id> --jq .status,.conclusion`                                                      | Poll one CI run      | JSON fields (REST bucket)      |
| `gh api repos/<repo>/pulls/<n>/comments --jq '.[].body'`                                                                  | PR review comments   | Comment text                   |

---

