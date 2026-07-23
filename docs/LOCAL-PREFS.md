# Local prefs — keep owner data OUT of this public repo

`claude-ops` is a **public** plugin. No owner-specific data may live in tracked files:
real personal names, company / business-unit names, contact handles, phone numbers,
email addresses, chat IDs / JIDs, Slack channel IDs, or personal issue keys.

## Where owner data lives instead

- **`~/.claude/ops-prefs.json`** — central, gitignored prefs (owner, companies, issue
  prefixes, channel pointers). Read it at runtime when a skill needs a real value.
- **`~/.claude/memory/ops-inbox-slack-channels.md`** — Slack channel IDs + DM handles
  (local, not the repo).
- **`${CLAUDE_PLUGIN_DATA_DIR}/contact-registry.json`** — resolved contact identities.
- **`~/.mcp-secrets.env` / Doppler** — secrets. Never in the repo.

## Rules for repo content

- Use generic placeholders in skills/docs/examples: `<owner>`, `<company>`, `<contact>`,
  `<contact-A>`, `<number>`, `<ISSUE-123>`, `<slack-channel-id>`, `100000000000000@lid`.
- When a skill needs a concrete value, read it from `~/.claude/ops-prefs.json` or the
  local files above — do not hardcode it.
- `.gitignore` blocks `ops.local.json`, `*.local.json`, `.ops-prefs.json`.

## Audit

See `docs/PII-AUDIT.md` for the current inventory of remaining PII and the scrub plan.
