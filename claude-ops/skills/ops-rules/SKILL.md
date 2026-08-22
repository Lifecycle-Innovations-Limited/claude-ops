---
name: ops-rules
description: "OPS on-demand: This skill should be used when running any ops skill, or when the user asks to \"ops…"
argument-hint: ''
allowed-tools:
  - Read
  - Skill
---

# /ops:ops-rules

Standing rules for every ops skill. They override conflicting instructions in individual SKILL.md files.

Load this skill before acting on any `/ops:*` command. Details: `references/cli.md` (gog syntax), `references/internals.md` (deploy-fix fleet, credit-pool gate). Hermes primitive map: `hermes-plugin/RUNTIME.md`.

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
- `$HOME/.config/claude-ops/` for anything machine-scoped (e.g. the PII denylist)
- Environment variables or a secrets manager

**Never write preferences into the repo tree.** A skill or script that writes
`preferences.json`, `registry.json`, or any prefs-shaped file next to its own
source will commit the operator's identity on the next `git add -A`. Resolve the
path from `$PREFS_PATH` or `$HOME`, never from `$PLUGIN_ROOT`/`$REPO_ROOT`.

This is enforced, not merely documented. `tests/test-no-secrets.sh` fails the
build when a prefs-shaped file is tracked in the git index (`.gitignore` does not
help once a file is already tracked, and `git add -f` bypasses it), and when a
write target resolves into the repo tree. Run it before every commit.

**Enable the operator identity denylist.** The scanner cannot hardcode your own
names, brands, or hostnames — that list would itself be the leak. Put one term
per line in `$HOME/.config/claude-ops/pii-denylist.txt` (or `.pii-denylist`,
gitignored) and the scanner will fail the build if any of them reach the repo.
Until you configure it, that check passes while verifying nothing.

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

## Rule 6 — Outbound comms require per-message approval, always

**NO skill in this plugin may send an outbound message — email, Slack, WhatsApp, SMS, voice call, Telegram, Discord, Resend, or any other channel — without first showing the user the full draft and receiving an explicit per-message approval.** This applies to every skill (`/ops`, `/ops-inbox`, `/ops-go`, `/ops-comms`, `/ops-yolo`, `/ops-orchestrate`, and any future skill), every surface (Bash CLI, MCP tool, direct API), and every orchestration mode (main session, subagent, daemon, cron).

**The universal send gate:**

1. **Stage ONE draft, show the user EVERYTHING** — to, cc, bcc, subject, full body, attachments. Not a summary. Not a line count. The full message the recipient will see.

2. **Call `AskUserQuestion` for THAT ONE message** with options like `[Send]`, `[Edit]`, `[Skip]`. Wait for the user's choice. A plain-chat approval word (`ok`, `send`, `go`, `yes`, `approved`, `ship it`) is also a valid signal — but only for the single staged message.

3. **Execute the send.** Then — and only then — stage the next draft.

4. **Never stack.** If you have 6 replies to send, that's 6 separate draft-show-approve-send cycles. Never "approve all 6", never "I'll fire them in order", never batch.

5. **Subagents are not an escape hatch.** When spawning an `Agent` with access to send-tools (`mcp__gog__gmail_send`, `mcp__whatsapp__send_message`, Bash with `gog` / `curl resend.com` / etc), the subagent's prompt MUST explicitly say _"You are read-only. Do NOT send any outbound messages. Return drafts to the orchestrator who will stage them one-by-one."_ For autonomous orchestration, prefer subagents with only read/search tools (`mcp__gog__gmail_search`, `gog gmail thread get`) so they physically cannot send.

6. **MCP ≡ Bash ≡ API.** `mcp__gog__gmail_send` is the same gate as `gog gmail send` (Bash) is the same gate as `curl -X POST https://api.resend.com/emails` is the same gate as `mcp__whatsapp__send_message`. Surface doesn't matter — if it produces outbound comms, it needs its own per-message approval.

7. **Forbidden output patterns** — if you find yourself about to emit any of these, STOP and convert to one-at-a-time staging:
   - "6 drafts queued — approve all?"
   - "I'll fire them in recommended order"
   - "Firing batch 1 of 2..."
   - Multiple `mcp__*_send` or `gog gmail send` tool calls in the same assistant turn without intervening user approvals
   - "I've drafted the emails autonomously — approve by number"

8. **Violation log.** Any skill that violates this rule MUST be considered a bug and reported via `/ops:ops-doctor` for remediation. The user's guardrail hook (`block-outbound-comms.py` with `/tmp/.claude-send-ok` token, one-shot, 120s TTL) is a defense-in-depth layer — this rule is the primary gate and must hold even when the hook is absent.

**Why this rule exists:** On 2026-04-20, the `/ops:ops` router — when given a free-form argument that didn't match a keyword route — fell through to autonomous agent behavior and fired 15 `mcp__gog__gmail_send` calls in a 3-minute burst to 6 business contacts (royalty-collection labels, publishing partners, legal counsel, intro subjects). The user was never shown individual drafts. Real relationships received un-reviewed AI emails. This cannot repeat.

## Rule 7 — Mobile / SSH sessions: compact text, no tables

**Detection — any of these = mobile mode:**

- `$SSH_CONNECTION`, `$SSH_CLIENT`, or `$SSH_TTY` is set (user is on a remote terminal — likely Termius/iSH on a phone, or a tmux pane on a remote host)
- `$OPS_MOBILE=1` (explicit override)
- `$COLUMNS` < 80 (narrow terminal regardless of cause)

**When mobile mode is detected, every ops skill MUST:**

1. **No tables.** Markdown tables, ASCII boxes, and multi-column ANSI dashboards wrap unreadably in a tmux pane on a phone. Use plain text lines — one fact per line.
2. **No banners or section headers.** Skip `━━━━━` rules, `║ OPS ► … ║` boxes, ASCII art, and `──────` footers. They eat the vertical space the user doesn't have.
3. **No emoji-prefixed status columns.** A plain `whatsapp: connected` reads cleanly; `✓ WhatsApp     connected     N chats     last sync 2m` does not.
4. **Short answers.** Aim for 3–8 lines total. If a briefing has 20 items, summarize the top 3 + total count, not all 20.
5. **URLs print, never `open`.** Always go through `lib/opener.sh::ops_open_url` — it auto-detects SSH/mobile and prints a copy-able URL block instead of spawning the host's opener (which would launch a browser on the SSH target the user can't see).
6. **No ANSI colors that depend on background detection.** Termius doesn't always negotiate them; plain text wins.
7. **`AskUserQuestion` stays normal.** Approval prompts are the one place the user IS reading carefully — don't over-truncate options. But still skip table layouts inside option descriptions.

**Example — `/ops:go` desktop output:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MORNING BRIEFING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIRES         (none)
PRs           3 open: #N owner-a (CI red), #N owner-b, ...
INBOX         WhatsApp 12 · Email 50 · Slack 4
PORTFOLIO     22 projects · 3 executing · 1 blocked
PRIORITIES
  1. ...
  2. ...
```

**Same content in mobile mode:**

```
no fires.
3 open PRs — top: owner-a#N CI red.
inbox: wa 12, mail 50, slack 4.
portfolio: 3 active, 1 blocked.
next: fix owner-a#N CI.
```

That's the bar. If a skill can't compress to that shape, it's too verbose for mobile.

**For shell scripts and binaries** (anything in `bin/` or `scripts/`):

- Detect via `[[ -n "$SSH_CONNECTION$SSH_CLIENT$SSH_TTY" || "$OPS_MOBILE" == "1" ]]` and switch to a compact code path.
- For URL opening, source `lib/opener.sh` and call `ops_open_url` — never call `open`/`xdg-open` directly.

## Rule 8 — Never assume the WhatsApp MCP server is called `whatsapp`

Docs and skills in this plugin write WhatsApp tools as `mcp__whatsapp__list_chats`,
`mcp__whatsapp__send_message`, and so on. That is the name of a **single-account** install. It is a
default, not a guarantee.

An install with more than one WhatsApp account runs one bridge and one MCP server per account, each
registered under its own name. The usual convention is `whatsapp-<label>`, where the label is the
account (`whatsapp-personal`, `whatsapp-work`, or a country code). On those machines `mcp__whatsapp__*`
does not exist at all, and a skill that calls it fails with an unknown tool.

**What every skill must do:**

1. **Resolve the name, do not assume it.** Read the available tool list and use whatever matches
   `mcp__whatsapp*__`. Treat `mcp__whatsapp__*` in this repo as shorthand for "the WhatsApp server that
   is actually registered here".
2. **With two or more accounts, pick deliberately.** Each account has its own contacts and its own
   history, and the stores do not overlap. Choose by where the conversation already lives. If that is
   unclear, ask the user which account to use. Never guess, and never fall back to the first one.
3. **Never send from an account the thread is not on.** A reply that arrives from the wrong number is
   worse than no reply, because the recipient sees a number they do not recognise.
4. **Rule 6 applies to every variant.** `mcp__whatsapp-work__send_message` needs the same per-message
   approval as `mcp__whatsapp__send_message`. A different server name is not a different gate.

**For `allowed-tools` frontmatter:** entries are exact tool names, so a skill listing only
`mcp__whatsapp__list_chats` will not grant `mcp__whatsapp-work__list_chats`. Multi-account users must
add their own per-account entries. Keep the single-account names in this repo as the default and say so
in a comment next to them.

**For host-level send gates:** a hook matcher pinned to the literal string `mcp__whatsapp__send_message`
silently stops firing the moment an account is renamed or added, which turns an approval gate off
without any error. Match on a pattern such as `mcp__whatsapp[a-z-]*__send_(message|audio_message|file)`
so every present and future account stays gated.

## Rule 9 — Exhaust before concluding

Most confident-but-wrong answers share one shape: stopping at the first plausible
result. Before writing any of these sentences, run the matching check. If you have
not run it, do not write the sentence.

- "X was never sent" / "there is no email about Y"
- "service X is down / dead / needs re-auth"
- "the contract says Z"
- "this happened on `<date>`" / "A came after B"
- "nobody replied" / "it stalled because…"
- "this needs you" / "that's a human blocker"

**"It doesn't exist."** Search every configured account, not the default one, and
page past the first screen. Vary the query at least three ways: by topic keyword,
by the counterparty's exact address (`to:`/`from:`), and by their domain alone
plus likely misspellings of the name. A negative from one account, one query, or
page one is not evidence of absence.

**"Service X is down."** Enumerate every instance before declaring anything dead:
all processes, all listening ports, all service labels, all data stores. Probe
each listener individually. A single failed probe on an assumed port is not an
outage, and the same service often runs more than once under different names.

**"The contract says Z."** Confirm you have the operative version by searching the
thread for later drafts and the counterparty's own copy, and check for a clause
that supersedes an earlier letter of intent. Map the full structure before
quoting, since schedules routinely hold more than one table. Quote verbatim with
the clause number; never paraphrase from memory.

**"This happened on `<date>`."** Mail search returns the *thread's* latest date,
not the individual message's. Never build a chronology from search output; open
the thread and read per-message dates.

**"Nobody replied / it stalled."** Read every message in the chain, both
directions, before assigning fault. A stall is usually a condition nobody
satisfied rather than neglect.

**"This needs you."** The capability usually already exists and is simply
undocumented. Before escalating: grep the codebase for an existing path including
sibling repos, check the secret store by name, check the password manager for
anything account-shaped, then live-probe it so you know rather than believe. Also
question the framing — ask whether the dependency should exist at all before
asking the user how to fund or fix it.

**A counterparty asked a question.** Answer it yourself. Search the mailboxes,
open every attachment, read the contracts, check the web. Escalate to the user
only when the answer exists solely in their head or needs their physical presence.
Relaying a question the user pays you to answer is the failure this rule exists to
prevent.

**Attachments are primary sources.** `.eml`, `.pdf`, `.docx`, and `.xlsx`
attachments regularly hold the actual answer. "See the attachment" is an
instruction to open it, not a pointer to summarise around. Nested `.eml` files
parse with Python's `email` module.

**User corrections are research instructions, never hedges to be reassured.**
"I think I sent that" means the search was too narrow, so sweep again. "I don't
think that's true" means stop and re-verify from the primary source. "Isn't there
a better way" is a design review, so go and check before answering. "Maybe it's
running on a different port" means enumerate rather than politely dismiss. A
user's half-memory of their own estate routinely beats a first-pass search.

## Rule 10 — Harness fallbacks (Hermes, Grok, Codex, cron)

Claude Code primitives stay in the skills: they are valid there. When the
running harness does not have them, **add a fallback — never delete the Claude
path.** Full table: `hermes-plugin/RUNTIME.md`.

| If this is missing | Do this instead |
|---|---|
| `AskUserQuestion` | Numbered options in chat, then wait. Telegram/gateway: two turns (full draft as its own message, then the Send / Edit / Skip card). Max 4 options. |
| `Workflow` | Hermes `delegate_task`, or sequential work in the main session. |
| `TeamCreate` / agent teams | The harness's own subagent tool (`delegate_task` on Hermes). |
| `TaskCreate` / `TaskList` | Hermes Kanban, or skip. Do not require Paperclip. |
| `CronCreate` | `hermes cron`, or skip. |
| `mcp__linear__*` | Linear CLI / GraphQL. Resolve real tool names at runtime. |
| `gh … --admin` | Never. Merge only when required checks pass, the PR is conflict-free, and blocking review threads are resolved. |

Rule 6 (one draft → one approval → one send) is harness-independent. Scanners
stay read-only; sends stay in the main session.

On Hermes, install `hermes-plugin/` as `~/.hermes/plugins/ops` and add `ops` to
`plugins.enabled`. Slash commands (`/ops-inbox`, `/ops`) and
`skill_view("ops:<name>")` then work.
