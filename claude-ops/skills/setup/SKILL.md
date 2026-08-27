---
name: setup
description: "OPS on-demand: This skill should be used when the user asks to \"/ops:setup\", \"configure ops\", or…"
argument-hint: '[section]'
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Agent
  - TeamCreate
  - SendMessage
effort: high
maxTurns: 80
context: fork
---

# OPS ► SETUP WIZARD

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

You are running an **interactive configuration wizard** for the `claude-ops` plugin. The user wants you to walk them through every step needed to get the plugin working: installing CLIs, setting env vars, configuring channels, populating the project registry, and saving preferences.

---

**RULE ZERO — EVERY BASH CALL USES `run_in_background: true`**

This is non-negotiable. EVERY SINGLE Bash tool call in this entire setup wizard MUST set `run_in_background: true`. There are ZERO exceptions. This applies to:

- Credential scans, CLI installs, OAuth flows, npm/brew installs
- Daemon starts, daemon reloads, launchctl commands
- Keychain writes, Doppler queries, Chrome history queries
- Autolink scripts, sync/backfill, smoke tests
- File writes, config writes, env appends
- ANY command, no matter how fast you think it will be

While background commands run, immediately continue to the next independent step or ask the user the next question. Handle results when the `<task-notification>` arrives. The setup wizard must NEVER show `(ctrl+b to run in background)` — if the user sees that prompt, you violated this rule.

**RULE ONE — SILENT BASH CALLS**

Every Bash tool call MUST include a short `description` parameter (5-10 words, e.g. "Install missing CLIs", "Scout keychain for Telegram creds", "Reload daemon"). This is what the user sees instead of the raw command. Keep setup clean and quiet — the user should see progress titles, not shell scripts.

---

**Other hard rules:**

- This is a _conversation_, not a script dump. Use `AskUserQuestion` for every decision — never ask in prose when a structured selector will do.
- Confirm actions via `AskUserQuestion` where the user hasn't already opted in (e.g., "Configure all" covers everything — no per-action confirmation needed after that).
- Skip sections the user declines. Don't nag.
- **NEVER auto-skip a channel or integration.** Every channel/service the user selected must get an explicit `AskUserQuestion` with skip as one of the options. If a credential isn't found, present the [Paste manually] / [Deep hunt] / [Skip] options. If a smoke test fails, ask the user whether to retry, reconfigure, or skip. The ONLY acceptable way to skip is the user choosing a "Skip" option. Do not silently move past a service because scanning found nothing — that's when the user needs to be asked the most.
- Show what's already configured first, so the user only fills gaps.
- **Never show the user's real name or email in output unless the user explicitly provided it in THIS session.** Do not read from memory, existing configs, or environment variables to populate display names.
- **Max 4 options per `AskUserQuestion` call.** The tool schema enforces `<=4` items in the `options` array. When a step lists >4 choices, filter already-configured items first, then batch the rest into multiple sequential calls of <=4 options each, grouped logically. Use `[More options...]` as the last option to bridge between batches.
- Run ALL diagnostic/probe commands in parallel when possible. Use multiple Bash tool calls in a single message. Never run sequential probes when they're independent (e.g., `gog auth status` AND `ops-wa-accounts --list` AND keychain scouts should all run simultaneously).
- All writes go to one of these paths — and nothing else:
  - **`$PREFS_PATH`** — per-user preferences + secrets. Resolves to `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`. Lives in Claude Code's plugin data dir so it survives plugin reinstalls and version bumps. Never committed to git.
  - **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.json`** — per-user project registry (gitignored in the source repo). `mkdir -p` its parent if missing.
  - **`${CLAUDE_PLUGIN_ROOT}/.mcp.json`** — leave empty (`{"mcpServers":{}}`). MCP servers start on demand in host config, not at plugin load. Never hardcoded tokens.
  - The user's shell profile (`~/.zshrc` etc.) — append-only, never rewrite.
- At the top of every wizard step, make sure `$PREFS_PATH`'s parent directory exists: `mkdir -p "$(dirname "$PREFS_PATH")"`. Claude Code creates `~/.claude/plugins/data/ops-ops-marketplace/` on plugin install but don't assume.

---

## Arguments

The setup wizard accepts these flags (parsed from `$ARGUMENTS`):

- `--fast` — Zero-prompt fast path. When credentials are found by the Universal Credential Auto-Scan, auto-select "Configure all" / "Set up everything" everywhere without asking. Only fall back to interactive prompts when a section has no credentials at all.
- `--profile <name>` — Pre-select a curated integration subset. Valid names:
  - `developer` — GitHub, AWS, Sentry, Linear, Doppler, Daemon.
  - `founder` — All comms (Telegram, WhatsApp, Email, Slack, Calendar), plus Doppler, Linear, Daemon.
  - `marketer` — Klaviyo, Meta Ads, GA4, Search Console, Shopify, Email (sending), Doppler.
- `--re-setup` — Skip Step 1's "what do you want to configure" prompt and route directly to broken/unconfigured sections based on `/ops:status`. Equivalent to auto-detected incremental mode.

**Precedence:** `--profile` narrows the section set first, `--fast` then auto-confirms within those sections, `--re-setup` further filters to only broken/unconfigured ones.

### Profile → sections mapping

| Profile   | Sections enabled                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| developer | 2 (CLIs), 2c (Daemon), 3g (Doppler), 3h (Vault), plus GitHub + AWS + Sentry + Linear integration paths                                  |
| founder   | 2, 2c, 3a (Telegram), 3b (WhatsApp), 3c (Email), 3d (Slack), 3f (Calendar), 3g (Doppler), 3k-home (Home Automation), 3n (Notifications) |
| marketer  | 2, 2c, 3j (Marketing — Klaviyo/Meta Ads/GA4/GSC), 3i (Shopify), 3c (Email), 3g (Doppler)                                                |

### Incremental re-setup

When Step 0b detects an existing `$PREFS_PATH` with ≥1 configured section AND no explicit arguments were passed, default Step 1's prompt to "Re-setup broken only" (instead of "Set up everything"). Skip every section where `/ops:status` reports green for that section's key integrations.

### Progress panel

After every section completes (or is skipped), print a single line progress panel:

    Progress: {configured}/{total} configured · {working} working · {pending} pending

Where:

- `configured` = sections where credentials are present in `preferences.json`.
- `working` = configured sections whose most recent `/ops:status` smoke test returned green.
- `pending` = sections the user selected but hasn't configured yet.
- `total` = total sections considered for this run (filtered by `--profile` if used).

---

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when multiple "Deep hunt" credential agents are needed simultaneously. This enables:

- Credential scouts run in parallel across Doppler, keychains, browser profiles, and password managers
- Agents share findings (e.g., Doppler agent finds a partial config → keychain agent knows to skip that service)
- You can steer mid-hunt: "found the Telegram token, stop hunting for that one"

**Team setup** (only when flag is enabled, multiple deep hunts triggered):

```
TeamCreate("setup-hunters")
Agent(team_name="setup-hunters", name="hunt-telegram", model="haiku", ...)
Agent(team_name="setup-hunters", name="hunt-sentry", model="haiku", ...)
Agent(team_name="setup-hunters", name="hunt-shopify", model="haiku", ...)
```

Each agent reports back its findings. Merge results and present to the user for confirmation.

If the flag is NOT set, use independent fire-and-forget subagents with `run_in_background: true`.

---

## Setup agent delegation pattern

When the user asks a complex integration-specific question during setup (e.g., "how does /ops:ecom handle multi-store setups?"), the setup agent can load the related skill's SKILL.md for deeper context:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/skills/ops-ecom/SKILL.md"
```

Each sub-step below includes a `> **Deep-dive:**` pointer to the related skill file. Follow these pointers instead of duplicating operational details in this wizard.

---

## Step 0 — Preflight (runs in background while you read)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-preflight &>/dev/null &
```

**Preflight data**: All probe results are cached at `/tmp/ops-preflight/`. Before running ANY diagnostic command, check if the result already exists there:

- CLI status: `cat /tmp/ops-preflight/clis.txt`
- Slack: `cat /tmp/ops-preflight/slack.json`
- Telegram: `cat /tmp/ops-preflight/telegram.txt`
- gog/Gmail: `cat /tmp/ops-preflight/gog-gmail.json`
- gog/Calendar: `cat /tmp/ops-preflight/gog-cal.json`
- WhatsApp: `cat /tmp/ops-preflight/bridge-health.json`
- MCP servers: `cat /tmp/ops-preflight/mcp-servers.txt`
- GitHub: `cat /tmp/ops-preflight/gh-auth.txt`
- AWS: `cat /tmp/ops-preflight/aws-identity.json`
- Projects: `cat /tmp/ops-preflight/projects.txt`
- Existing registry: `cat /tmp/ops-preflight/existing-registry.json`
- Existing prefs: `cat /tmp/ops-preflight/existing-prefs.json`
- Doppler: `cat /tmp/ops-preflight/doppler.json`

Wait for `/tmp/ops-preflight/.complete` to exist before reading (it should be ready within 2-3 seconds). NEVER re-run a probe that already has cached results — read the cache file instead.

---

## Step 0b — Detect current state

Run the detector and parse its JSON output (or read from preflight cache if available):

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-detect 2>/dev/null
```

If `CLAUDE_PLUGIN_ROOT` is unset, fall back to the latest installed cache dir at `~/.claude/plugins/cache/ops-marketplace/ops/<latest-version>/`. Store the resolved path as `PLUGIN_ROOT` for the rest of the session.

Also resolve `PREFS_PATH` once and reuse it everywhere:

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
mkdir -p "$(dirname "$PREFS_PATH")"
```

Print a compact status header to the user, one line per category:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETUP WIZARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Shell:       <detected shell> → <detected profile_file>   (e.g. bash → ~/.bashrc, zsh → ~/.zshrc, fish → ~/.config/fish/config.fish)
 Core CLIs:   ✓ jq  ✓ git  ✓ gh  ✓ aws  ✓ node
 Channels:    ✓ bridge  ✓ gog  ○ telegram (no token)
 Secrets:     ✓ doppler (project: my-app, config: dev)
 MCPs:        ✓ linear  ✓ sentry  ○ slack  ○ vercel
 Registry:    19 projects
 Preferences: not set
──────────────────────────────────────────────────────
```

Use `✓` for present/set, `○` for missing/unset, `✗` for broken.

### Incremental re-setup routing

If Step 0b finds `$PREFS_PATH` with ≥1 configured section and no `--fast`/`--profile` argument was passed:

1. Read `/ops:status` snapshot to build a per-section health map (`green`/`red`/`missing`).
2. Filter the Step 1 selector options to only sections where status is `red` or `missing`.
3. Change the default option label to "Re-setup broken only (Recommended)".
4. Add "Add new section" as a secondary option for users who want to configure a previously-skipped section.

Fresh installs (no `preferences.json` at all) continue to see the full selector with "Set up everything" as the default.

---

## Step 1 — Ask which sections to configure

**When `--profile <name>` was passed:** Skip this step entirely. Use the profile → sections mapping from the Arguments section to activate the curated subset and proceed to Step 2.

**When `--re-setup` was passed (or incremental mode auto-detected from Step 0b):** Skip this step. Activate only sections reporting `red`/`missing` and proceed to Step 2.

**Otherwise:** proceed with the standard selector below.

First, offer a quick "set up everything" option:

```
How would you like to run setup?
  [Set up everything — install CLIs, configure all channels, MCPs, registry, daemon, preferences (Recommended)]
  [Pick sections — choose which parts to configure]
  [Re-run a specific section — I know what I need]
```

If the user selects "Set up everything", select ALL sections across all batches and run them in order (Step 2 → 2b → 2c → 3 → 4 → 5 → 5b → 6 → 6.5 → 7), skipping any already fully configured. Within each step, use the "Configure all" fast-path where available.

If the user selects "Re-run a specific section", use sequential `AskUserQuestion` calls (paginated 4 options per page per Rule 1) to let the user pick from the section names (cli, daemon, statusline, channels, mcp, registry, prefs, deploy-fix, env, ecom, mktg, voice, revenue, network), then jump directly to that step. The `deploy-fix` section routes to Step 6.5; `network` routes to Step 3q-network.

If the user selects "Pick sections", proceed with the batched selection below.

Use `AskUserQuestion` with `multiSelect: true`. Offer **only sections that need attention** (skip ones already green). Because AskUserQuestion allows max 4 options, batch into logical groups:

**Batch 1 — Core setup (run early so the daemon can pre-warm caches while you finish):**

| Option            | Header   | Description                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------ |
| Install CLIs      | cli      | Install missing command-line tools via Homebrew                                |
| Background daemon | daemon   | Install ops-daemon early — pre-warms briefing cache while remaining setup runs |
| Configure MCPs    | mcp      | Enable Linear, Sentry, Vercel, Gmail MCP servers                               |
| Build registry    | registry | Register projects Claude should manage                                         |

**Batch 2 — Channels & plugins:**

| Option             | Header   | Description                                     |
| ------------------ | -------- | ----------------------------------------------- |
| Configure channels | channels | Set tokens for Telegram, WhatsApp, Email, Slack |
| Companion plugins  | plugins  | Co-install required deps: desktop-act, GSD, gstack, Superpowers, feature-dev |
| Save preferences   | prefs    | Owner name, timezone, default priorities        |
| Shell env          | env      | Export `CLAUDE_PLUGIN_ROOT` in shell profile    |

**Batch 3 — Extras (only show if not already configured):**

| Option              | Header  | Description                                        |
| ------------------- | ------- | -------------------------------------------------- |
| Configure ecommerce | ecom    | Set Shopify store URL + admin token, ShipBob       |
| Configure marketing | mktg    | Set Klaviyo, Meta Ads, GA4, Search Console keys    |
| Configure voice     | voice   | Set Bland AI, ElevenLabs, Groq API keys            |
| Configure revenue   | revenue | Set Stripe + RevenueCat keys for live MRR tracking |

**Batch 4 — Auto-fix subsystem + auxiliary daemons:**

| Option           | Header     | Description                                                |
| ---------------- | ---------- | ---------------------------------------------------------- |
| Deploy auto-fix  | deploy-fix | Configure post-merge + build-failure auto-fix (Step 6.5a)  |
| Recap marquee    | marquee    | tmux digest of parallel Claude sessions (Step 6.5b)        |
| Task\* reminder  | task-rem   | PostToolUse nudge to use TaskCreate/TaskUpdate (Step 6.5c) |
| Account rotation | rotator    | Multi-account Claude rotator toggle (Step 6.5d)            |

Present each batch as a separate `AskUserQuestion` call. Skip batches where all items are already green. Collect all selections across batches and run each selected section in order.

---

## Additional resources

Channel, CLI, and edge-case detail lives in `references/` next to this skill. Read those files before acting on a matching channel or sub-command. Do not skip them.
