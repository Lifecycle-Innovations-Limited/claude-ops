# claude-ops plugin rules

Claude Code does **not** load this file as plugin context. Standing rules live in
`skills/ops-rules/SKILL.md` (loaded by every ops skill preamble and a SessionStart hook).

- Rules 0–10: `skills/ops-rules/SKILL.md`
- gog CLI syntax: `skills/ops-rules/references/cli.md`
- Deploy-fix / credit-pool: `skills/ops-rules/references/internals.md`
- Hermes fallbacks: `hermes-plugin/RUNTIME.md`
