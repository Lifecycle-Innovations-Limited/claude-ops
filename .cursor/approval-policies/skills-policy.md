# Skills approval policy

## Auto-approve when

- Copy, examples, or routing table updates only
- No new shell commands that bypass safety hooks or write outside the workspace
- Bugbot and Security Agent report no findings
- Risk score ≤ configured threshold

## Never auto-approve

- Skills that instruct agents to disable hooks, skip tests, or force-push to protected branches
- New skills that invoke credential stores, payment APIs, or production deploy commands without existing precedent in repo
- Changes to `/ops:setup`, `/ops:deploy-fix`, or rotation skills that alter default safety posture

## Reviewer routing

- Request platform maintainers when skill behavior changes operational guardrails
