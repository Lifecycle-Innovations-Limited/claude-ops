# Local prefs — keep owner data OUT of this public repo

`claude-ops` is a **public** plugin. No owner-specific data may live in tracked files:
real personal names, company / business-unit names, contact handles, phone numbers,
email addresses, chat IDs / JIDs, Slack channel IDs, or personal issue keys.

## Where owner data lives instead

- **`~/.claude/ops-prefs.json`** — central, gitignored prefs (owner, companies, issue
  prefixes, channel pointers). Read it at runtime when a skill needs a real value.
- **`$PREFS_PATH` `.channels.notion.calendars`** — optional array of
  `{name, data_source_url}` for Notion show-schedule / calendar / appointments
  databases. Inbox, `/ops:go`, and `/ops:tonight` query these in addition to
  Google Calendar. Never put those IDs in the repo.
- **`~/.claude/memory/ops-inbox-slack-channels.md`** — Slack channel IDs + DM handles
  (local, not the repo).
- **`${CLAUDE_PLUGIN_DATA_DIR}/contact-registry.json`** — resolved contact identities.
- **`~/.mcp-secrets.env` / Doppler** — secrets. Never in the repo.

## Third-party identifiers (stricter than owner data)

An id belonging to another organisation — a client's Linear team key, workspace or
company UUID, issue ids, an account number — is not the owner's to publish. Those
are read from the environment and have no committed default:

| Variable | Holds |
|---|---|
| `LINEAR_TEAM_MAP_JSON` | `{"KEY": {"company": "<uuid>", "team": "<uuid>"}}` for every client team |
| `LINEAR_CLIENT_TEAM_KEY` | the client's Linear team key (defaults to `TEAM`) |
| `LINEAR_CLIENT_TEAM_ID`, `PAPERCLIP_CLIENT_COMPANY_ID` | the primary client's ids |
| `OPS_TZ` | the operator's timezone; unset means the host's own zone |

Client-specific issue-id tables (`FORCE_UNLINK`, `MULTI_CANON`,
`STANDING_OWN_LINEAR`) load from an out-of-repo `hea_thrash_canons` module. The
in-repo fallbacks are empty on purpose — empty means "no overrides", which is
correct for anyone who is not that client.

## Rules for repo content

- Use generic placeholders in skills/docs/examples: `<owner>`, `<company>`, `<contact>`,
  `<contact-A>`, `<number>`, `<ISSUE-123>`, `<slack-channel-id>`, `100000000000000@lid`.
- When a skill needs a concrete value, read it from `~/.claude/ops-prefs.json` or the
  local files above — do not hardcode it.
- `.gitignore` blocks `ops.local.json`, `*.local.json`, `.ops-prefs.json`.

## Audit

See `docs/PII-AUDIT.md` for the current inventory of remaining PII and the scrub plan.
