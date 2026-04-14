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
- **OAuth flows** (`gog auth add <email> --services gmail,calendar,...`, `doppler login`, `op signin`): run via Bash with `run_in_background: true` — the browser will open automatically.
- **Password manager unlock** (`bw unlock`, `dcli configure`): run via Bash tool directly.
- **Exception — QR-based auth** (`wacli auth`): this genuinely requires the user's phone camera pointed at the terminal. This is the ONLY case where you should tell the user to act in a separate terminal.

## Rule 3 — Never auto-skip channels or integrations

During setup and configuration flows, NEVER silently skip a channel, service, or integration. If a credential isn't found or a step fails, the user MUST be given an explicit choice via `AskUserQuestion` with options like `[Paste manually]`, `[Deep hunt — spawn agent]`, `[Skip]`. The only acceptable way to skip is the user selecting "Skip". Do not move past a service just because auto-scan returned empty — that is precisely when the user needs to be asked.

## Rule 5 — Destructive actions require explicit per-action confirmation

**NEVER** execute or recommend executing any of the following without first confirming with the user via `AskUserQuestion` for EACH individual action:

- Deleting infrastructure (ECS clusters, RDS instances, ALBs, NAT Gateways, S3 buckets, Lambda functions)
- Stopping or scaling down running services
- Canceling domain auto-renewals
- Rewriting git history (`git filter-repo`, `git rebase`, force-push)
- Archiving or deleting repositories
- Disabling CI/CD pipelines or workflows
- Purging container images (ECR, Docker)
- Deleting CloudWatch alarms or log groups
- Any `aws ... delete-*`, `aws ... stop-*`, `aws ... terminate-*` command

**For analysis/report agents** (CTO, CFO, COO, CEO): When recommending infrastructure changes, always:
1. Verify project status first — check for recent commits, active branches, planning directories, and registry status before labeling anything as "dead" or "archived"
2. Distinguish "idle" (0 tasks but project is active) from "dead" (project abandoned, no commits in months, no planning)
3. Flag all destructive recommendations with `⚠️ REQUIRES CONFIRMATION` so the orchestrator knows to ask
4. Never assume a service scaled to 0 means the project is dead — it may be between deployments or paused intentionally

**For orchestration skills** (ops-yolo, ops-orchestrate, ops-go): Before executing ANY destructive recommendation from a C-suite agent, present it to the user via `AskUserQuestion` with `[Execute]` / `[Skip]` options. Batch confirmations are acceptable (e.g., "Delete these 3 idle ALBs?") but never silently execute.

## Rule 4 — Background by default during setup and configuration flows

During `/ops:setup` and any skill's setup/configure flow, use `run_in_background: true` on **every** Bash call unless you need the result immediately for the very next decision. This includes: credential scans, CLI installs, OAuth flows, npm installs, brew installs, autolink scripts, smoke tests, keychain writes, Doppler queries, Chrome history queries. While background commands run, continue to the next independent step or ask the user the next question. Never block the conversation waiting for a command the user isn't actively waiting for.

## Appendix: CLI Reference (EXACT SYNTAX — never guess)

### gog (v0.12.0+)

#### Top-level commands
auth, gmail, calendar, contacts, drive, docs, slides, sheets, forms, tasks, keep, chat, people, appscript, config, agent

#### Gmail — Search & Read
```bash
gog gmail search "<query>" --max N -j --results-only --no-input    # Search threads (Gmail query syntax)
gog gmail thread get <threadId> -j                                  # Get full thread with all messages
gog gmail get <messageId> -j                                        # Get single message
```

#### Gmail — Actions
```bash
gog gmail archive <messageId> ... --no-input --force               # Archive messages (remove from inbox)
gog gmail archive --query "<gmail-query>" --max N --force           # Archive by query
gog gmail mark-read <messageId> ... --no-input                     # Mark as read
gog gmail unread <messageId> ... --no-input                        # Mark as unread
gog gmail trash <messageId> ... --no-input --force                 # Move to trash
```

#### Gmail — Send & Reply
```bash
gog gmail send --to "user@example.com" --subject "subj" --body "text"                    # Send new email
gog gmail send --to "a@b.com" --subject "Re: ..." --body "reply" --reply-to-message-id <msgId>  # Reply
gog gmail send --reply-to-message-id <msgId> --reply-all --body "reply text"             # Reply all
gog gmail send --to "a@b.com" --subject "subj" --body "text" --attach /path/to/file      # With attachment
```

#### Gmail — Labels & Drafts
```bash
gog gmail labels list -j                                            # List all labels
gog gmail labels modify <threadId> --add LABEL --remove LABEL       # Modify thread labels
gog gmail messages modify <messageId> --add LABEL --remove LABEL    # Modify message labels
gog gmail drafts list -j                                            # List drafts
gog gmail drafts create --to "user@example.com" --subject "subj" --body "text"
```

#### Calendar
```bash
gog calendar calendars -j                                           # List calendars
gog calendar events primary --today -j                              # Today's events
gog calendar events primary --from "2026-04-14" --to "2026-04-15" -j  # Date range
gog calendar create primary --summary "Meeting" --start "2026-04-15T10:00:00" --end "2026-04-15T11:00:00"
gog calendar freebusy --from "2026-04-14T00:00:00Z" --to "2026-04-14T23:59:59Z" -j
```

#### Contacts / Drive / Tasks
```bash
gog contacts search "name" -j                                       # Search contacts
gog contacts list -j                                                # List all contacts
gog drive ls -j                                                     # List files
gog drive search "query" -j                                         # Search files
gog drive download <fileId>                                         # Download file
gog tasks lists list -j                                             # List task lists
gog tasks list <tasklistId> -j                                      # List tasks
```

#### Auth
```bash
gog auth status                                                     # Check auth status
gog auth add user@example.com --services gmail,calendar,drive,contacts,docs,sheets
```
