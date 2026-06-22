# CI and release workflow approval policy

## Default posture

**Never auto-approve** workflow changes.

## Human review must verify

- Required checks are not removed or made optional without replacement
- Deploy and release workflows retain health/version verification steps where present today
- No broadened `permissions:` blocks (especially `contents: write`, `id-token`, or org-wide secrets)
- Concurrency/cancel-in-progress behavior is preserved or improved
- Release tagging and marketplace publish steps remain gated

## Auto-approve exception (rare)

- Comment-only or whitespace changes inside workflow files with zero semantic diff — only if Bugbot confirms no functional change

## Reviewer routing

- Request platform maintainers for all non-comment workflow edits
