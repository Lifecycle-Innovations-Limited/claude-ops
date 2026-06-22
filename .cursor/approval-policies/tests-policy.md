# Tests approval policy

## Auto-approve when

- Changes are limited to test files and test fixtures
- Production runtime code is unchanged OR changes are clearly test harness only
- Bugbot and Security Agent report no findings
- CI is green

## Never auto-approve

- Tests that disable assertions, skip cases, or mock away security-critical behavior without justification
- Tests removed alongside production logic changes in the same PR

## Reviewer routing

- Test-only PRs: no specialist required when CI green
- Tests + production code: follow the policy for the production paths changed
