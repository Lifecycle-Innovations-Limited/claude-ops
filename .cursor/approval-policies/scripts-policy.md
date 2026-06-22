# Repository automation scripts approval policy

## Default posture

**Never auto-approve** changes under top-level `scripts/**` that automate git push, PR creation/merge, fleet operations, or cross-repo policy shipping.

## Human review must verify

- Scripts cannot bypass hooks, secret scans, or branch protections without explicit safeguards
- Dry-run and `--admin` merge paths are documented and scoped
- Sync operations promote only intended policy files, not unrelated dev-only commits

## Reviewer routing

- Request platform maintainers
