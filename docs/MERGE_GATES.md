# Merge gates

**Agents:** admin-merge when the **required** status context is green. Do not wait for optional bots or long smokes unless they are named as required.

## Required

| Typical required context | Notes |
|--------------------------|--------|
| **`CI Summary`** (if present) | Only required context on many Healify `dev` branches |
| Else: branch-protection required checks | `gh api repos/.../branches/<branch>/protection` |

When required green + no conflicts:

```bash
gh pr merge <N> --admin --squash --delete-branch
```

Do **not** ask Sam for merge approval.

## Not required

- Names containing **NOT required for merge**
- Seer · CodeRabbit · Cursor · Vercel Agent · Graphite mergeability
- Device Farm / long simulator smokes (unless explicitly required)
- Vercel “Canceled by Ignored Build Step”

## Concurrency

Every workflow must cancel superseded runs:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

## Doctrine

`~/.claude/memory/admin-merge-ci-gates.md`
