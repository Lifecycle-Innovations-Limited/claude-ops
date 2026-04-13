# claude-ops Plugin Rules

These rules apply to ALL skills in this plugin. They are non-negotiable and override any conflicting instruction in individual SKILL.md files.

## Rule 0 — PUBLIC REPO: No personal data ever

**This is a public open-source plugin.** Every file in this repo is visible to anyone on the internet.

**NEVER commit:**
- Real names, emails, phone numbers, or usernames (use "owner", "user@example.com", "+1234567890")
- Real store URLs, project names, or org names (use "yourstore.myshopify.com", "my-project")
- API keys, tokens, secrets, session strings, or chat IDs (use `<YOUR_TOKEN>`, `$ENV_VAR`)
- Real GitHub org names or repo slugs in examples (use "your-org/your-repo")
- Hardcoded paths like `/Users/username/...` (use `~` or `$HOME`)

**All user-specific data belongs in:**
- `$PREFS_PATH` (preferences.json in plugin data dir — never committed)
- `scripts/registry.json` (gitignored)
- Environment variables or Doppler secrets

Run `tests/test-no-secrets.sh` before every commit to verify.

## Rule 1 — Max 4 options per AskUserQuestion

The `AskUserQuestion` tool enforces a hard schema limit of `<=4` items in the `options` array. Passing more than 4 options causes an `InputValidationError` and the skill crashes.

**Requirements:**
- Never pass more than 4 options in a single `AskUserQuestion` call.
- When a step lists >4 choices, apply this strategy:
  1. **Filter first** — remove items that are already configured, completed, or irrelevant to the current context. This alone often brings the count to <=4.
  2. **Batch the rest** — group remaining items logically and present them across multiple sequential `AskUserQuestion` calls of <=4 options each.
  3. **Use "More..." as a bridge** — when batching, the last option in each batch (except the final one) should be `[More options...]` to advance to the next batch.
- Dynamic lists (projects, configs, vaults) that may grow beyond 4 items at runtime MUST be paginated at 4 per page.
- Multi-select lists follow the same limit — max 4 checkboxes per call.

## Rule 2 — Never delegate commands to the user

When a skill says "tell the user to run X in a separate terminal" or "Run `command` in your terminal":
- **Run it via the Bash tool instead** (backgrounded with `run_in_background: true` if it is long-running or interactive).
- **OAuth flows** (`gog auth login`, `doppler login`, `op signin`): run via Bash with `run_in_background: true` — the browser will open automatically.
- **Password manager unlock** (`bw unlock`, `dcli configure`): run via Bash tool directly.
- **Exception — QR-based auth** (`wacli auth`): this genuinely requires the user's phone camera pointed at the terminal. This is the ONLY case where you should tell the user to act in a separate terminal.
