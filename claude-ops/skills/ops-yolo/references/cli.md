# CLI/API reference

## CLI/API Reference

### aws CLI (Cost Explorer)

**Doctrine:** burn = `RECORD_TYPE=Usage` only. Plain UnblendedCost totals are credit-masked (~$0) and MUST NOT be used as spend.

| Command | Usage | Output |
| ------- | ----- | ------ |
| `${CLAUDE_PLUGIN_ROOT}/scripts/aws-usage-cost.sh snapshot` | MTD Usage burn + 7d daily + top services + credit mask | JSON |
| `aws ce … --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'` | Raw Usage-only fallback | Cost JSON |

### gh CLI (GitHub)

| Command                                                                                                 | Usage                | Output       |
| ------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| `gh pr list --repo <owner/repo> --json number,title,statusCheckRollup,reviewDecision,mergeable,isDraft` | Open PRs with status | JSON array   |
| `gh pr merge <n> --repo <repo> --squash`                                                                | Squash merge PR      | Merge result |
| `gh run list --limit 20 --json status,conclusion,name,headBranch,createdAt`                             | Recent CI runs       | JSON array   |

---

