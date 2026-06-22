# Plugin runtime approval policy

Applies to `claude-ops/bin/**`, `claude-ops/lib/**`, `claude-ops/agents/**`, and `claude-ops/config/**`.

## Auto-approve when ALL are true

- Small, localized fix with clear test or script coverage
- No changes to deploy-fix registry, post-merge hooks, or specialist routing keywords
- Bugbot and Security Agent report no findings
- CI green including `claude-ops/tests/**` where applicable
- Risk score ≤ configured threshold

## Never auto-approve

- Changes to `config/specialist-keywords*.json` that broaden autonomous write scope
- Agent persona changes that remove safety constraints or encourage bypassing hooks
- Binaries/scripts that add destructive defaults or silent force flags
- Plugin manifest changes (`.claude-plugin/**`) bundled without explicit manifest review

## Reviewer routing

- Auto-fix / deploy subsystem changes → platform maintainers
- Agent roster changes → platform maintainers
- Config-only tuning with tests → any maintainer acceptable if CI green
