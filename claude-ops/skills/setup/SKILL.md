---
name: setup
description: Interactive setup wizard for the claude-ops plugin. Installs missing CLIs, configures env vars for each channel (Telegram, WhatsApp, Email, Slack, Notion, Linear, Sentry, Vercel), builds the project registry, and saves user preferences. Run once after installing the plugin or any time to reconfigure.
argument-hint: "[section]"
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
---

# OPS ► SETUP WIZARD

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
- Run ALL diagnostic/probe commands in parallel when possible. Use multiple Bash tool calls in a single message. Never run sequential probes when they're independent (e.g., `gog auth status` AND `lsof -i :8080 | grep LISTEN` AND keychain scouts should all run simultaneously).
- All writes go to one of these paths — and nothing else:
  - **`$PREFS_PATH`** — per-user preferences + secrets. Resolves to `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`. Lives in Claude Code's plugin data dir so it survives plugin reinstalls and version bumps. Never committed to git.
  - **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.json`** — per-user project registry (gitignored in the source repo). `mkdir -p` its parent if missing.
  - **`${CLAUDE_PLUGIN_ROOT}/.mcp.json`** — only to add `${user_config.*}` placeholders, never hardcoded tokens.
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

| Profile | Sections enabled |
|---------|------------------|
| developer | 2 (CLIs), 2c (Daemon), 3g (Doppler), 3h (Vault), plus GitHub + AWS + Sentry + Linear integration paths |
| founder | 2, 2c, 3a (Telegram), 3b (WhatsApp), 3c (Email), 3d (Slack), 3f (Calendar), 3g (Doppler), 3k-home (Home Automation), 3n (Notifications) |
| marketer | 2, 2c, 3j (Marketing — Klaviyo/Meta Ads/GA4/GSC), 3i (Shopify), 3c (Email), 3g (Doppler) |

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
 Shell:       zsh → ~/.zshrc
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

If the user selects "Re-run a specific section", use sequential `AskUserQuestion` calls (paginated 4 options per page per Rule 1) to let the user pick from the section names (cli, daemon, channels, mcp, registry, prefs, deploy-fix, env, ecom, mktg, voice, revenue), then jump directly to that step. The `deploy-fix` section routes to Step 6.5.

If the user selects "Pick sections", proceed with the batched selection below.

Use `AskUserQuestion` with `multiSelect: true`. Offer **only sections that need attention** (skip ones already green). Because AskUserQuestion allows max 4 options, batch into logical groups:

**Batch 1 — Core setup (run early so the daemon can pre-warm caches while you finish):**

| Option             | Header   | Description                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------------- |
| Install CLIs       | cli      | Install missing command-line tools via Homebrew                               |
| Background daemon  | daemon   | Install ops-daemon early — pre-warms briefing cache while remaining setup runs |
| Configure MCPs      | mcp      | Enable Linear, Sentry, Vercel, Gmail MCP servers                              |
| Build registry      | registry | Register projects Claude should manage                                        |

**Batch 2 — Channels & plugins:**

| Option             | Header   | Description                                                   |
| ------------------ | -------- | ------------------------------------------------------------- |
| Configure channels  | channels | Set tokens for Telegram, WhatsApp, Email, Slack               |
| Companion plugins   | plugins  | Install GSD for project roadmap tracking                      |
| Save preferences    | prefs    | Owner name, timezone, default priorities                      |
| Shell env           | env      | Export `CLAUDE_PLUGIN_ROOT` in shell profile                  |

**Batch 3 — Extras (only show if not already configured):**

| Option              | Header   | Description                                                   |
| ------------------- | -------- | ------------------------------------------------------------- |
| Configure ecommerce | ecom     | Set Shopify store URL + admin token, ShipBob                  |
| Configure marketing | mktg     | Set Klaviyo, Meta Ads, GA4, Search Console keys               |
| Configure voice     | voice    | Set Bland AI, ElevenLabs, Groq API keys                       |
| Configure revenue   | revenue  | Set Stripe + RevenueCat keys for live MRR tracking            |

**Batch 4 — Auto-fix subsystem + auxiliary daemons:**

| Option              | Header      | Description                                                       |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| Deploy auto-fix     | deploy-fix  | Configure post-merge + build-failure auto-fix (Step 6.5a)         |
| Recap marquee       | marquee     | tmux digest of parallel Claude sessions (Step 6.5b)               |
| Task* reminder      | task-rem    | PostToolUse nudge to use TaskCreate/TaskUpdate (Step 6.5c)        |
| Account rotation    | rotator     | Multi-account Claude rotator toggle (Step 6.5d)                   |

Present each batch as a separate `AskUserQuestion` call. Skip batches where all items are already green. Collect all selections across batches and run each selected section in order.

---

## Step 2 — Install CLIs (if selected)

If multiple CLIs are missing, offer a bulk install first:

```
Missing CLIs detected: jq, gh. What would you like to do?
  [Install all missing CLIs (Recommended)]
  [Pick which to install]
  [Skip CLI installation]
```

If the user selects "Install all", install every missing tool in sequence without further prompts. If "Pick which to install", ask per tool:

```
Install jq?           [Yes, install now] [Skip]
Install gh?           [Yes, install now] [Skip]

```

For each `Yes`, run:

```bash
${PLUGIN_ROOT}/bin/ops-setup-install <tool>
```

Report success/failure. If Homebrew is missing on macOS, stop and tell the user to install it from https://brew.sh first — do not attempt to install brew automatically.

After installation, re-run `ops-setup-detect` to refresh status before continuing.

---

## Step 2b — Companion plugins (if selected)

### GSD (Get Shit Done)

GSD is a third-party Claude Code plugin that adds project roadmap tracking. When installed, claude-ops dashboards (`/ops:go`, `/ops:projects`, `/ops:next`, `/ops:yolo`) automatically show active phases, progress, and next actions per project. Without it, those sections are simply omitted.

Check if GSD is already installed:

```bash
find ~/.claude -name "gsd-progress" -path "*/skills/*" 2>/dev/null | head -1 | grep -q . && echo "installed" || echo "not_installed"
```

If not installed, ask via `AskUserQuestion`:

```
GSD adds project roadmap tracking to your ops dashboards.
  /ops:go shows active phases and progress per project
  /ops:projects shows GSD state alongside CI/PR status
  /ops:next factors in GSD work priority

  [Install GSD (latest)] [Skip — I don't need roadmap tracking]
```

On install, run the commands directly — do NOT tell the user to run them manually:

```bash
# Install GSD in one shot — no user intervention needed
claude plugin marketplace add gsd-build/get-shit-done 2>/dev/null && \
claude plugin install gsd@gsd-build-get-shit-done 2>/dev/null
```

If `claude` CLI is not available in the path, fall back to the plugin cache mechanism:

```bash
# Direct marketplace clone fallback
GSD_MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/gsd-build-get-shit-done"
if [ ! -d "$GSD_MARKETPLACE_DIR" ]; then
  git clone https://github.com/gsd-build/get-shit-done.git "$GSD_MARKETPLACE_DIR" 2>/dev/null
fi
```

Report success/failure. Record `plugins.gsd = "installed"` in `$PREFS_PATH`.

If they skip:

```
Skipped GSD. Install later with: /plugin marketplace add gsd-build/get-shit-done
```

---

## Step 2b.5 — Superpowers (optional, recommended)

Several ops skills (`/ops:ops-merge`, `/ops:ops-orchestrate`, `/ops:ops-triage`) integrate with `superpowers:*` skills at key checkpoints — verification-before-completion, finishing-a-development-branch, dispatching-parallel-agents, systematic-debugging. Without superpowers installed, those checkpoints are no-ops; with it, they enforce stronger guardrails on merges, multi-agent dispatch, and root-cause analysis.

Check if superpowers is already installed:

```bash
find ~/.claude/plugins -path "*/superpowers/skills/using-superpowers" -type d 2>/dev/null | head -1 | grep -q . && echo "installed" || echo "not_installed"
```

If not installed, ask via `AskUserQuestion`:

```
Superpowers adds verification, dispatch, and debugging guardrails to ops skills.

  [Install Superpowers (latest)] [Skip — I'll add it later]
```

On install, run the commands directly:

```bash
claude plugin marketplace add obra/superpowers-marketplace 2>/dev/null && \
claude plugin install superpowers@superpowers-marketplace 2>/dev/null
```

Fallback if `claude` CLI is not on PATH:

```bash
SP_MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/superpowers-marketplace"
if [ ! -d "$SP_MARKETPLACE_DIR" ]; then
  git clone https://github.com/obra/superpowers-marketplace.git "$SP_MARKETPLACE_DIR" 2>/dev/null
fi
```

Report success/failure. Record `plugins.superpowers = "installed"` in `$PREFS_PATH`.

If they skip:

```
Skipped Superpowers. Ops skills will run without superpower checkpoints.
Install later with: /plugin marketplace add obra/superpowers-marketplace
```

---

## Step 2c — Background Daemon (early install, pre-warm caches)

**Why install the daemon this early?** Running the daemon in parallel with the rest of setup lets it start pre-warming the briefing cache (`ops-gather` results for infra/git/PRs/CI), so by the time the user reaches Step 7 and runs `/ops:go`, the briefing is already cached and loads in under 3 seconds instead of 10. Channel-dependent services (message-listener, inbox-digest) are added later in Step 5b once their channels are configured.

### Platform support

The background daemon ships with a `launchd` integration (macOS only). Detect the platform before attempting install:

```bash
case "$(uname -s)" in
  Darwin)                OS=macos ;;
  Linux)                 grep -qi microsoft /proc/version 2>/dev/null && OS=wsl || OS=linux ;;
  MINGW*|MSYS*|CYGWIN*)  OS=windows ;;
  *)                     OS=unknown ;;
esac
```

- **macOS** (`OS=macos`): proceed with the full `launchctl bootstrap` flow below.
- **Linux** (`OS=linux`): use the bundled `systemd --user` installer. Run (RULE ZERO — `run_in_background: true`):

  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/install-ops-daemon-linux.sh
  ```

  > Generates `~/.config/systemd/user/claude-ops-daemon.service` from `scripts/systemd/claude-ops-daemon.service`, enables linger (so the daemon survives logout), chowns `~/.claude/plugins/cache/` back to the user if it was left root-owned by a prior `sudo` run, then `daemon-reload + enable --now`. Idempotent. See `scripts/install-ops-daemon-linux.sh --help` for `--dry-run` and `--uninstall`.

  Write `daemon.enabled = true`, `daemon.installed_at_step = "2c"`, `daemon.platform = "linux-systemd"` to `$PREFS_PATH` and continue immediately to Step 3 — health verification is deferred to Step 5b.

- **WSL** (`OS=wsl`): `systemd --user` works on WSL2 with `systemd=true` in `/etc/wsl.conf`. If `systemctl --user status` succeeds, run the Linux installer above. Otherwise fall back to:

  ```
  ○ Background daemon — skipped (WSL without systemd). Launch manually with:
    nohup ${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon.sh > /tmp/ops-daemon.log 2>&1 &
  ```

  Write `daemon.enabled = false` and `daemon.skip_reason = "platform:wsl-no-systemd"` to `$PREFS_PATH` and continue.
- **Windows** (native, `OS=windows`): the daemon is **not installed**. Print `○ Background daemon — not supported on native Windows. Use WSL or run ops-daemon.sh manually.` and continue.

If `OS=macos`, check whether the daemon is already installed:

```bash
launchctl print gui/$(id -u)/com.claude-ops.daemon 2>/dev/null | head -1
```

If already loaded, print `✓ Background daemon already running — will reconcile services in Step 5b.` and skip to Step 3.

Otherwise ask via `AskUserQuestion`:

```
Install the ops background daemon now?
  Starts pre-warming briefing cache while you finish the rest of setup.
  Auto-heals on failure. Single launchd agent (com.claude-ops.daemon).
  Channel services (whatsapp-bridge health, message-listener) added after channels are set up.
  [Yes — install now]  [Skip — I'll run it manually later]
```

On `Yes`, run the install (use `run_in_background: true` — RULE ZERO):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
bash "$PLUGIN_ROOT/scripts/install-ops-daemon.sh"
```

> Generates `~/Library/LaunchAgents/com.claude-ops.daemon.plist` from the bundled template, writes the initial channel-independent services config (`briefing-pre-warm` + `memory-extractor`), removes any legacy whatsapp-bridge keepalive, and bootstraps the daemon. Idempotent — re-running re-bootstraps cleanly. See `scripts/install-ops-daemon.sh` for the full procedure.

Write `daemon.enabled = true` and `daemon.installed_at_step = "2c"` to `$PREFS_PATH` so Step 5b knows to reconcile services instead of re-installing.

Print:

```
✓ Background daemon — installed. Pre-warming briefing cache in parallel while you finish setup.
  Channel-dependent services will be added after channels are configured (Step 5b).
```

Continue immediately to Step 3 — do NOT wait for the daemon to confirm startup. The health file check is deferred to Step 5b.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/docs/daemon-guide.md` for full operational instructions, CLI reference, and troubleshooting for the background daemon. The setup agent can load that file directly when it needs more depth than this wizard provides.

---

## Step 2d — Recap Marquee (multi-session digest in tmux status-right)

The recap marquee is a separate launchd daemon (`com.claude-ops.recap-daemon`) that synthesizes a one-line digest across all parallel Claude Code sessions and recent shell activity, then exposes it via `/tmp/claude-recap-digest` for tmux to scroll across `status-right`. Independent from the main ops daemon — it can run on its own.

Skip this step entirely if `recap_marquee_enabled = false` in userConfig.

### Step 2d.1 — Ask the user

Use `AskUserQuestion`:

```
Enable multi-session recap marquee?
  Background daemon synthesizes a one-line digest across all parallel Claude
  Code sessions + recent shell commands. Display in tmux status-right.
  [Yes — install + auto-configure]  [No — skip]  [What is this?]
```

If `What is this?`: explain (the daemon polls per-session recap files written by Stop + PostToolUse hooks, aggregates last 8 sessions + 10 prior digests + recent zsh activity into one Haiku-generated headline, refreshed every ~15s; tmux reads `/tmp/claude-recap-digest` from `status-right` and scrolls it). Then re-ask the binary question.

If `No`: write `recap.enabled = false` to `$PREFS_PATH` and skip to Step 3.

### Step 2d.2 — Install launchd plist (macOS only)

Same platform gate as Step 2c. On Linux/WSL/Windows, print:

```
○ Recap daemon — skipped (launchd is macOS-only). Linux users: see
  /ops:recap configure for systemd unit example.
```

On macOS, install the plist (RULE 4 — `run_in_background: true`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
bash "$PLUGIN_ROOT/scripts/install-recap-daemon.sh"
```

> Generates `~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist` from the bundled template and bootstraps the agent. Macos-only (the script no-ops cleanly on Linux). See `scripts/install-recap-daemon.sh` for the full procedure.

### Step 2d.3 — Display surface integration (tmux OR Claude Code statusLine)

The daemon writes `/tmp/claude-recap-digest`. Two display surfaces can render it (and they can coexist):

- **tmux `status-right`** — preferred when tmux is installed (richer color, scrolling).
- **Claude Code `statusLine`** — fallback when tmux is missing; renders in Claude Code's own status bar via `~/.claude/settings.json`.

Detect tmux availability and branch:

```bash
if ! command -v tmux >/dev/null 2>&1; then
  echo "○ tmux not installed — offering Claude Code statusLine fallback instead."
  # → jump to Step 2d.3b (statusLine fallback)
fi
```

If `recap_marquee_auto_configure_tmux = false`, print the tmux snippet and skip the rest of this step (let user wire manually). The statusLine fallback in Step 2d.3b still applies if tmux is absent.

If tmux is present and `recap_marquee_auto_configure_tmux = true`, ask:

```
Auto-configure tmux status-right?
  [Yes — append to ~/.tmux.conf]  [Show me the line, I'll add manually]  [Skip]
```

On `Show me the line`, print the snippet and continue.

On `Yes — append`, detect existing `status-right`:

```bash
TMUX_CONF="$HOME/.tmux.conf"
existing=$(grep -E '^\s*set\s+-g\s+status-right' "$TMUX_CONF" 2>/dev/null | head -1)
```

If `existing` is non-empty, ask via `AskUserQuestion` (Rule 1 — exactly 4 options max):

```
Existing tmux status-right detected. How to integrate recap marquee?
  [Replace with recap-only]  [Append (keep existing line as comment)]  [Show me, I'll edit manually]  [Skip]
```

Append the snippet (or replace, per choice). Use an unquoted heredoc delimiter so `${PLUGIN_ROOT}` expands to the installed plugin path (tmux `#()` does not expand env vars):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
cat >> "$TMUX_CONF" <<TMUX

# claude-ops recap marquee — synthesizes multi-session digest into status-right
set -g status-right '#('"${PLUGIN_ROOT}"'/scripts/recap/marquee.sh) #[fg=#a6e3a1]%H:%M '
set -g status-interval 2
TMUX

# Live-reload if tmux is currently running
tmux info >/dev/null 2>&1 && tmux source-file "$TMUX_CONF" 2>/dev/null
```

### Step 2d.3b — Claude Code statusLine fallback (no tmux)

When `command -v tmux` returned non-zero in Step 2d.3, offer the Claude Code `statusLine` setting as the marquee surface. Same digest file (`/tmp/claude-recap-digest`), different render target. This is also safe to layer alongside tmux if both are present — but typically only run when tmux is absent.

Ask via `AskUserQuestion` (Rule 1 — exactly 4 options):

```
No tmux detected. Wire the recap marquee into Claude Code's statusLine instead?
  [Add to Claude Code statusLine]  [Show me the JSON, I'll add manually]  [Skip]  [Help]
```

On `Help`: explain that Claude Code reads `~/.claude/settings.json` → `statusLine` and runs the configured command on each refresh, displaying the output in its own status bar. Then re-ask.

On `Show me the JSON`: print the snippet below and continue to Step 2d.4 with `recap.statusline_wired = false`.

On `Skip`: write `recap.statusline_wired = false` and continue to Step 2d.4.

On `Add to Claude Code statusLine`:

0. **Pre-check — `jq` availability**: Step 2d.3b uses `jq` for every settings.json read/merge. If `jq` is missing, all subsequent `jq` calls silently fail (suppressed by `2>/dev/null`), `existing` evaluates to empty, and the merge step is skipped — but the success path would still record `recap.statusline_wired = true` in prefs, leaving the user in an inconsistent state. Guard up front:

   ```bash
   if ! command -v jq >/dev/null 2>&1; then
     echo "○ jq not installed — cannot merge statusLine automatically."
     echo "  Install jq (e.g. brew install jq, apt install jq) and re-run /ops:recap configure."
     # Do NOT mark statusline_wired=true. Treat as Skip:
     # write recap.statusline_wired = false in Step 2d.5 and continue to Step 2d.4.
   fi
   ```

   Only continue with steps 1–5 below when `jq` is present.

1. Detect existing `statusLine` entry:

   ```bash
   SETTINGS="$HOME/.claude/settings.json"
   mkdir -p "$(dirname "$SETTINGS")"
   [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
   existing=$(jq -r '.statusLine // empty' "$SETTINGS" 2>/dev/null)
   ```

2. If `existing` is non-empty, ask via `AskUserQuestion` (Rule 1 — 3 options):

   ```
   Existing statusLine detected in ~/.claude/settings.json. How to handle?
     [Replace with recap]  [Append after current (chain commands)]  [Skip]
   ```

   - `Replace with recap` → overwrite the `statusLine` key.
   - `Append after current` → preserve the existing command but suffix `; cat /tmp/claude-recap-digest 2>/dev/null | head -c 80` so both render. Use the existing entry's `type` and `refreshInterval`.
   - `Skip` → leave settings.json untouched, write `recap.statusline_wired = false`, and continue.

3. Merge with `jq` (preserves all other keys — never overwrite the whole file):

   ```bash
   TMP=$(mktemp)
   jq '.statusLine = {
     "type": "command",
     "command": "cat /tmp/claude-recap-digest 2>/dev/null | head -c 80",
     "refreshInterval": 30
   }' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
   ```

   For the `Append after current` branch, build the merged command first:

   ```bash
   prev_cmd=$(jq -r '.statusLine.command // ""' "$SETTINGS")
   if [ -n "$prev_cmd" ]; then
     new_cmd="${prev_cmd}; cat /tmp/claude-recap-digest 2>/dev/null | head -c 80"
   else
     new_cmd="cat /tmp/claude-recap-digest 2>/dev/null | head -c 80"
   fi
   TMP=$(mktemp)
   jq --arg cmd "$new_cmd" '.statusLine.command = $cmd' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
   ```

4. Print:

   ```
   ✓ Claude Code statusLine wired — restart Claude Code (or open a new session) to activate.
   ```

   Then write `recap.statusline_wired = true` before continuing to Step 2d.4.

The JSON snippet to show on `Show me the JSON`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cat /tmp/claude-recap-digest 2>/dev/null | head -c 80",
    "refreshInterval": 30
  }
}
```

### Step 2d.4 — Verify daemon is producing output

Wait up to 60s for the daemon to write its first digest. Run in background; do NOT block the wizard:

```bash
(
  for i in $(seq 1 12); do
    [ -f /tmp/claude-recap-digest ] && [ -s /tmp/claude-recap-digest ] && exit 0
    sleep 5
  done
  echo "WARN: recap daemon did not produce /tmp/claude-recap-digest within 60s — check /tmp/claude-recap-daemon.log" >&2
) &
```

### Step 2d.5 — Persist preferences

Write to `$PREFS_PATH`. Set both `"tmux_wired"` and `"statusline_wired"` dynamically based on the user’s actual choices:

- `"tmux_wired"`: `true` when tmux was installed and the user chose to wire `status-right` in Step 2d.3; `false` when tmux was missing, the user chose **Skip**, or **Show me the line**.
- `"statusline_wired"`: `true` only after **Add to Claude Code statusLine** successfully merged recap into `~/.claude/settings.json` in Step 2d.3b; `false` after **Skip**, **Show me the JSON**, the nested **Skip** when an existing statusLine was detected, or if Step 2d.3b did not run (e.g. tmux-only path).
```json
{
  "recap": {
    "enabled": true,
    "tmux_wired": "<true|false — based on Step 2d.3 outcome>",
    "statusline_wired": "<true|false — based on Step 2d.3b outcome>",
    "installed_at_step": "2d",
    "platform": "macos"
  }
}
```

Example: tmux wired + statusLine skipped → `"tmux_wired": true, "statusline_wired": false`. No tmux + statusLine wired → `"tmux_wired": false, "statusline_wired": true`.

Print:

```
✓ Recap marquee — daemon installed (com.claude-ops.recap-daemon).
  Tmux status-right wired (or skipped per your choice).
  Manage anytime: /ops:recap status | tail | configure | restart
```

Continue to Step 3.

---

## Step 3 — Configure channels (if selected)

First, offer a quick "configure everything" option before individual selection. Use `AskUserQuestion`:

```
How would you like to configure channels and integrations?
  [Configure all — set up every available channel and service (Recommended)]
  [Pick individually — choose which channels to configure]
  [Skip all — configure channels later]
```

If the user selects "Configure all", run every channel sub-flow below in sequence (Telegram → WhatsApp → Email → Slack → Notion → Calendar → Doppler → Vault), skipping any already configured. If the user selects "Skip all", move to Step 4.

If the user selects "Pick individually", ask which channels using `AskUserQuestion` with `multiSelect: true`. Because AskUserQuestion allows max 4 options, batch into two groups. Skip channels already configured (show only those needing attention).

**Batch 1 — Messaging:**

| Option   | Header   | Description                                                             |
| -------- | -------- | ----------------------------------------------------------------------- |
| Telegram | telegram | Bot token + owner ID for `/ops-comms telegram`                          |
| WhatsApp | whatsapp | bridge health check + QR pair + schema migration                         |
| Email    | email    | gog CLI → Gmail MCP fallback for `/ops-inbox email`                     |
| Slack    | slack    | Slack MCP server (managed by Claude Code)                               |

**Batch 2 — Knowledge & Services:**

| Option   | Header   | Description                                                             |
| -------- | -------- | ----------------------------------------------------------------------- |
| Notion   | notion   | Notion MCP — workspace search, comments, tasks, knowledge base          |
| Calendar | calendar | gog calendar → Google Calendar MCP fallback — schedule context for briefings |
| Doppler  | doppler  | Secrets manager — set default project + config for all ops skills       |
| Vault    | vault    | Password manager — 1Password, Dashlane, Bitwarden, or macOS Keychain    |

**Batch 3 — Voice journal & integrations (show only if not already configured):**

| Option   | Header   | Description                                                                    |
| -------- | -------- | ------------------------------------------------------------------------------ |
| Pocket   | pocket   | Voice journal notifier — POCKET_API_KEY + WhatsApp/email delivery + launchd agent |

Present each batch as a separate `AskUserQuestion` call. Skip batches where all items are already configured. For each selected channel, run the matching sub-flow below.

---

## Shared Step-3 material

Before running any channel block below, load **[SHARED.md](SHARED.md)**. It contains:

- Host OS detection (pick the right package manager — brew/apt/dnf/pacman/winget)
- OAuth-vs-manual-token preference rules
- **Universal Credential Auto-Scan** — the 10-source scan every credential prompt must run before asking the user
- Per-channel credential auto-scan bridge (Telegram, Slack)

Every channel sub-flow below references "the Universal Credential Auto-Scan" by name and assumes SHARED.md is in scope.

---

### 3a — Telegram (user-auth via ops-telegram-autolink)

> **Loaded from `channels/telegram.md`** — Bot token + owner ID, ops-telegram-autolink, message-history backfill.
> Load that file before running this sub-flow.

### 3b — WhatsApp (bridge health + QR pair)

> **Loaded from `channels/whatsapp.md`** — wacli bridge health, QR pairing, app-state recovery, keepalive.
> Load that file before running this sub-flow.

### 3c — Email

> **Loaded from `channels/email.md`** — gog CLI (preferred) or Gmail MCP fallback.
> Load that file before running this sub-flow.

### 3d — Slack (scout + ops-slack-autolink)

> **Loaded from `channels/slack.md`** — MCP via `claude mcp add slack` + ops-slack-autolink scout.
> Load that file before running this sub-flow.

### 3e — Notion (MCP integration)

> **Loaded from `channels/notion.md`** — Workspace search, comments, tasks via Notion MCP.
> Load that file before running this sub-flow.

### 3f — Calendar

> **Loaded from `channels/calendar.md`** — gog calendar (preferred) or Google Calendar MCP fallback.
> Load that file before running this sub-flow.

### 3g — Doppler (secrets management)

> **Loaded from `channels/doppler.md`** — Default project/config + Doppler MCP server.
> Load that file before running this sub-flow.

### 3h — Password Manager (credential vault)

> **Loaded from `channels/password-manager.md`** — 1Password/Dashlane/Bitwarden/Keychain auto-detect + query-template wiring.
> Load that file before running this sub-flow.

### 3i — Ecommerce (Shopify + dynamic partners)

> **Loaded from `channels/ecommerce.md`** — Shopify multi-store auto-scan + dynamic partner loop (ShipBob, Recharge, Yotpo, etc).
> Load that file before running this sub-flow.

### 3j — Marketing (Klaviyo, Meta Ads, GA4, Search Console)

> **Loaded from `channels/marketing.md`** — Klaviyo, Meta Ads, Google Ads (OAuth2), GA4, Search Console, WhatsApp Business + dynamic partner loop.
> Load that file before running this sub-flow.

### 3k — Voice (Bland AI, ElevenLabs, Groq)

> **Loaded from `channels/voice.md`** — Bland AI, ElevenLabs, Groq.
> Load that file before running this sub-flow.

### 3l — Revenue (Stripe + RevenueCat)

> **Loaded from `channels/revenue.md`** — Stripe + RevenueCat.
> Load that file before running this sub-flow.

### 3n — Notifications (fires-watcher sinks)

> **Loaded from `channels/notifications.md`** — fires-watcher per-sink capture.
> Load that file before running this sub-flow.

### 3k-home — Home Automation (Homey Pro)

Scout for credentials in background (RULE ZERO):

```bash
# Run all scouts simultaneously — run_in_background: true on each
security find-generic-password -s homey-local-token -w 2>/dev/null
echo "$HOMEY_LOCAL_TOKEN"
doppler secrets get HOMEY_LOCAL_TOKEN --project homey-pro --plaintext 2>/dev/null
op item get "Homey" --fields=token 2>/dev/null
```

If any scout returns a non-empty value, pre-fill it as the default; present found values alongside `[Use found value]` / `[Paste manually]` / `[Skip]`.

**Required:**

1. `HOMEY_LOCAL_URL` — LAN IP of the Homey Pro, e.g. `https://192.168.1.42`. Ask via `AskUserQuestion` free-text.
2. `HOMEY_LOCAL_TOKEN` — Personal Access Token from `https://my.homey.app/manager/tokens`. Ask via `AskUserQuestion` with `sensitive: true`.

**Optional:**

Ask via one `AskUserQuestion` call:
```
Configure optional Homey cloud credentials?
  [Yes — paste cloud token + Homey ID]
  [Skip optional fields]
```
If yes, collect `HOMEY_CLOUD_TOKEN` (Athom OAuth token) and `HOMEY_ID` (hub ID) via two follow-up `AskUserQuestion` calls with `sensitive: true`.

**Validate** (smoke test, RULE ZERO):
```bash
curl -s -H "Authorization: Bearer $HOMEY_LOCAL_TOKEN" \
  "$HOMEY_LOCAL_URL/api/manager/system/system/info" 2>/dev/null
```
Expect HTTP 200 with JSON containing `homeyVersion`. If the check fails, present `[Retry]` / `[Save anyway — LAN may be offline]` / `[Skip]` via `AskUserQuestion` (Rule 3 — never auto-skip).

**Save** to `$PREFS_PATH` via `jq`:
```bash
jq --arg url "$HOMEY_LOCAL_URL" \
   --arg lt "$HOMEY_LOCAL_TOKEN" \
   --arg ct "${HOMEY_CLOUD_TOKEN:-}" \
   --arg id "${HOMEY_ID:-}" \
   '.home_automation = {provider: "homey", homey_local_url: $url, homey_local_token: $lt, homey_cloud_token: $ct, homey_id: $id}' \
   "$PREFS_PATH" > "$PREFS_PATH.tmp" && mv "$PREFS_PATH.tmp" "$PREFS_PATH"
```

Print: `✓ Home automation — Homey Pro configured (local: $HOMEY_LOCAL_URL)`

---

### 3m — Discord (webhook + optional bot)

> **Loaded from `channels/discord.md`** — Webhook + optional bot token.
> Load that file before running this sub-flow.

### 3o — Claude account rotator OAuth (if selected)

> **Loaded from `channels/claude-rotator.md`** — Account rotator OAuth — delegates to /ops:rotate-setup.
> Load that file before running this sub-flow.

### 3p — Pocket (voice journal activity notifier)

> **Loaded from `channels/pocket.md`** — POCKET_API_KEY credential + WhatsApp/email channel config + launchd notifier install + smoke test.
> Load that file before running this sub-flow.

## Step 4 — Configure MCPs (if selected)

For each MCP that isn't in `mcp_configured`, offer bulk setup first:

```
Unconfigured MCPs: Linear, Sentry, Vercel. What would you like to do?
  [Configure all MCPs — run claude mcp add for each (Recommended)]
  [Pick which MCPs to add]
  [Skip MCP configuration]
```

If the user selects "Configure all", run `claude mcp add <name>` for each unconfigured MCP in sequence. If "Pick which", list each individually:

```
Linear:  claude mcp add linear
Sentry:  claude mcp add sentry
Vercel:  claude mcp add vercel
Slack:   claude mcp add slack
Gmail:   claude mcp add gmail   (fallback only — prefer `gog` CLI, see Step 3c)
```

Offer `[Add now]`, `[Skip]` for each. Do **not** try to register MCPs from the skill — the plugin can't do that safely.

**Email note:** the ops plugin's primary email path is the `gog` CLI (full read + send, own OAuth). The Gmail MCP connector works as a fallback but **cannot send** without extra permission config in Claude Desktop → Settings → Connectors. The wizard handles that detection in Step 3c; this step only lists it so users who deliberately prefer MCP can install it here.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-linear/SKILL.md`, `${CLAUDE_PLUGIN_ROOT}/skills/ops-triage/SKILL.md`, and `${CLAUDE_PLUGIN_ROOT}/skills/ops-fires/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for the MCP-backed integrations (Linear issue flows, triage routing, Sentry/Vercel fires). The setup agent can load those files directly when it needs more depth than this wizard provides.

---

## Step 5 — Build the project registry (if selected)

> **Templates:** a pre-baked starter for common stacks lives in `${CLAUDE_PLUGIN_ROOT}/scripts/registry.templates/`. If you want to start from one, `cp "${CLAUDE_PLUGIN_ROOT}/scripts/registry.templates/<stack>.json" "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json"` then edit — or continue the wizard below for interactive discovery.

### Auto-discover from filesystem

Before asking the user to manually enter projects, scan for existing git repositories:

```bash
find ~ ~/Projects -maxdepth 2 -name ".git" -type d 2>/dev/null | sed 's|/.git||' | sort
```

Present the discovered paths to the user via `AskUserQuestion` with `multiSelect: true`. **Max 4 options per call** — paginate at 3 projects per page + `[More...]` or `[None — I'll enter projects manually]` as the last option:

```
Found git repositories (page 1 of N):
  [ ] ~/Projects/my-app
  [ ] ~/Projects/my-api
  [ ] ~/Projects/my-ai
  [ ] More repositories...
```

On the final page, replace "More repositories..." with `[None of the above / Done selecting]`.

For each selected project, collect these fields one `AskUserQuestion` at a time:

- `alias` (short name, required — suggest the directory name as default)
- `org` (GitHub org or owner, e.g. `your-org` or `your-username`)
- `infra.platform` → select `[aws]`, `[vercel]`, `[cloudflare]`, `[other]`
- `revenue.model` → select in batches of 4: `[saas]`, `[subscription]`, `[marketplace]`, `[More...]` then `[internal]`, `[portfolio]`, `[other]`

### Auto-discover external projects

A real user's portfolio is rarely just git repos. Shopify stores, Linear teams, Slack workspaces, and Notion databases are first-class projects that `ops-external` + `ops-projects` know how to surface — but only if they land in `registry.json`. This sub-step probes whatever integrations the wizard has already configured and offers discovered items for one-click registration.

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-discover-external 2>/dev/null || echo '[]'
```

The script reads Shopify creds from `$PREFS_PATH .ecom.shopify.*` + `SHOPIFY_*` env, Linear from `LINEAR_API_KEY`, Slack from keychain `slack-xoxc`/`slack-xoxd`, and Notion from `NOTION_API_KEY` / keychain `notion-api-key`. It returns an array of candidate projects, each with a ready-to-merge `config` block.

**Parse the candidates** and — for each one not already present in `registry.json` (match by `config.alias` or by `source + source-specific ID`) — present it via `AskUserQuestion`. Batch at 3 candidates per call + `[More...]` to respect Rule 1 (max 4 options). Example batch:

```
Found external projects not yet in your registry (page 1 of N):
  [Register "mystore" (shopify — basic plan, 142 products)]
  [Register "linear-eng" (linear — Engineering, 42 open issues)]
  [Register "notion-roadmap" (notion — Product Roadmap database)]
  [More candidates...]
```

On the final page, the last option becomes `[None of the remaining — skip]`. Multi-select is acceptable — if you offer it, keep the `multiSelect: true` list size ≤ 4.

For each **accepted** candidate, merge its `config` block straight into `registry.json .projects[]` with `jq`:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
REG="$PLUGIN_ROOT/scripts/registry.json"
[ -f "$REG" ] || echo '{"version":"1.0","owner":"","projects":[]}' > "$REG"
jq --argjson new "$CONFIG_JSON" '.projects += [$new]' "$REG" > "$REG.tmp" && mv "$REG.tmp" "$REG"
```

**Status handling:**
- `discovered` → register as-is.
- `auth_expired` → surface a warning and route the user to `/ops:setup` for the affected channel before retrying.
- `unreachable` → offer `[Register anyway (will show as unreachable in dashboards)]` / `[Skip]`.

If the discovery script returns `[]`, print a single info line (`ℹ No external projects auto-discovered. You can add Shopify / Linear / Slack / Notion manually below.`) and continue. Never silently skip — the user must know the discovery ran.

If the candidate's credential value came from an env var but the user later wants Doppler, the credential key stored in the candidate (`SHOPIFY_ADMIN_TOKEN`, etc.) is safe to replace with a `doppler:` reference later via `/ops:settings`.

### Existing registry

If `registry.json` already has projects, ask first (4 options, fits in one call): `[Keep existing N projects]`, `[Add more projects]`, `[Auto-detect from existing registry]`, `[Start from scratch]`.

- "Keep existing" → skip this step.
- "Auto-detect from existing registry" → re-read the registry, show a summary of what's already there, and offer to add missing fields or newly-discovered repos.
- "Start from scratch" → write an empty skeleton first (`{"version":"1.0","owner":"","projects":[]}`) — **prompt to confirm before overwriting**.
- "Add more" → run the auto-discover scan above, then offer manual entry as a fallback.

### Manual add loop

After auto-discovery (or if the user selects "I'll enter projects manually"):

- Ask `AskUserQuestion`: "Add another project?" → `[Yes]`, `[Done]`.
- If Yes, collect these fields **one `AskUserQuestion` at a time**:
  - `alias` (short name, required)
  - `paths` (comma-separated absolute paths, required)
  - `repos` (comma-separated `org/repo`, required)
  - `type` → select `[monorepo]`, `[multi-repo]`
  - `infra.platform` → select `[aws]`, `[vercel]`, `[cloudflare]`, `[other]`
  - `revenue.model` → select in batches of 4: `[saas]`, `[subscription]`, `[marketplace]`, `[More...]` then `[internal]`, `[portfolio]`, `[other]`
  - `revenue.stage` → select `[pre-launch]`, `[development]`, `[growth]`, `[active]`
  - `gsd` → select `[Yes]`, `[No]`
  - `priority` (1-99, defaults to max+1)
- Ensure the registry directory exists: `mkdir -p "${CLAUDE_PLUGIN_ROOT}/scripts"`. If the write fails due to permissions (plugin cache dirs can be read-only), fall back to writing at `$DATA_DIR/registry.json` and symlink it.
- Read the current registry with `jq`, append the new project, write back atomically (`jq ... > tmp && mv tmp registry.json`).
- After each addition, print the running count and offer `[Add another]` / `[Done]`.
- The registry agent (if spawned) MUST have write access to the target path. If it can't write, the setup wizard should write the file itself from the agent's returned JSON — do not ask the user to intervene.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-projects/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for the project registry (auto-discovery, registry schema, GSD filters, priority ordering). The setup agent can load that file directly when it needs more depth than this wizard provides.

---

## Step 5b — Daemon Service Reconciliation

By now, the daemon was already installed in Step 2c and has been pre-warming the briefing cache in the background while the user configured channels. This step adds **channel-dependent services** (`whatsapp-bridge`, `message-listener`, `inbox-digest`, `store-health`, `competitor-intel`) now that we know which channels and integrations are configured.

**Skip conditions:**
- If the user declined daemon install in Step 2c, skip this step entirely.
- If `daemon.enabled != true` in `$PREFS_PATH`, skip.

Otherwise continue — reconcile the services list:

**1. Verify the daemon is running:**

```bash
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.daemon.plist"
launchctl print gui/$(id -u)/com.claude-ops.daemon >/dev/null 2>&1 || {
  # Daemon not running — install it now as a fallback
  launchctl bootstrap gui/$(id -u) "$PLIST_DEST" 2>/dev/null
}
```

**2. Verify health after 5 seconds:**

```bash
cat "$DATA_DIR/daemon-health.json" 2>/dev/null
```

Parse the JSON. If `action_needed` is not null, surface the required action to the user. If the daemon wrote a health file, print:

```
✓ Background daemon — running (whatsapp-bridge: connected, memory-extractor: scheduled)
```

If the health file is missing (daemon may still be initializing), wait 5 more seconds and retry once. If still missing, print:

```
⚠ Daemon started but health file not yet written. Check:
  launchctl print gui/$(id -u)/com.claude-ops.daemon
  tail -20 ~/.claude/plugins/data/ops-ops-marketplace/logs/ops-daemon.log
```

**3. Build the full services list and reconcile with the config written in Step 2c:**

Determine which services to enable based on what was configured in earlier steps. The `briefing-pre-warm` and `memory-extractor` services were already enabled at Step 2c — preserve them. Add channel-dependent services based on what's now configured:

- `whatsapp-bridge` — always include if WhatsApp is configured (`channels.whatsapp` is set)
- `memory-extractor` — always include
- `inbox-digest` — always include (runs every 4h, aggregates all configured channels)
- `store-health` — include ONLY if ecommerce was configured (`ecom.shopify.store_url` is set in `$PREFS_PATH`)
- `competitor-intel` — include only if the user configures queries (see step 5b-i below); otherwise enable with `enabled: false` and surface a `[Configure later via /ops:setup]` hint
- `message-listener` — include if WhatsApp or Telegram is configured (persistent poller)

Build the services array programmatically (starting from the 2c baseline):
```bash
SERVICES='["briefing-pre-warm","memory-extractor","inbox-digest","competitor-intel"]'
PREFS=$(cat "$PREFS_PATH" 2>/dev/null || echo '{}')
# Add whatsapp-bridge + message-listener if WhatsApp is configured
if echo "$PREFS" | jq -e '.channels.whatsapp' > /dev/null 2>&1; then
  SERVICES=$(echo "$SERVICES" | jq '. + ["whatsapp-bridge","message-listener"]')
fi
# Add message-listener for Telegram too (deduplicate)
if echo "$PREFS" | jq -e '.channels.telegram' > /dev/null 2>&1; then
  SERVICES=$(echo "$SERVICES" | jq '. + ["message-listener"] | unique')
fi
# Add store-health only if Shopify is configured
if echo "$PREFS" | jq -e '.ecom.shopify.store_url' > /dev/null 2>&1; then
  SERVICES=$(echo "$SERVICES" | jq '. + ["store-health"]')
fi
echo "Services to enable: $SERVICES"
```

Write daemon services config to `$DATA_DIR/daemon-services.json` — merge with the existing config from Step 2c, preserving `briefing-pre-warm` and `memory-extractor`, and enabling the new channel-dependent services. **Every service MUST include a `command` field** — the daemon's `start_service()` skips any service without one. Use `${CLAUDE_PLUGIN_ROOT}` (resolved at runtime) for script paths. Each service entry should include:
- `briefing-pre-warm`: `{ "enabled": true, "command": "${CLAUDE_PLUGIN_ROOT}/bin/ops-gather", "cron": "*/2 * * * *" }` — pre-warms /ops:go cache (installed in 2c)
- `whatsapp-bridge`: `{ "enabled": true, "command": "launchctl kickstart -k gui/$UID/com.${USER}.whatsapp-bridge", "health_check": "lsof -i :8080 | grep LISTEN", "restart_delay": 60, "max_restarts": 10 }` — only if WhatsApp configured (matches `daemon-services.default.json`; bridge is owned by LaunchAgent, not a plugin script)
- `memory-extractor`: `{ "enabled": true, "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-memory-extractor.sh", "health_file": "~/.claude/plugins/data/ops-ops-marketplace/memories/.health", "cron": "*/30 * * * *" }` — every 30 min (installed in 2c)
- `inbox-digest`: `{ "enabled": true, "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-cron-inbox-digest.sh", "cron": "0 */4 * * *" }` — every 4h
- `store-health`: `{ "enabled": true, "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-cron-store-health.sh", "cron": "0 9 * * *" }` — daily 9am, only if ecom configured
- `competitor-intel`: `{ "enabled": <bool>, "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-cron-competitor-intel.sh", "cron": "0 10 * * 1" }` — weekly Monday 10am. `enabled` is `true` only when queries were configured in step 5b-i; otherwise `false` so the cron doesn't post placeholder garbage to Telegram

#### Step 5b-i — Competitor intel (self-discovering, gate before enabling)

Per Rule 3, never silently skip a service. Before deciding `competitor-intel.enabled`, ask the user explicitly:

```
AskUserQuestion({
  question: "Configure competitor intel? (Weekly: Tavily auto-discovers competitors → Sonnet synthesizes strategic delta → Telegram)",
  header: "Competitor intel",
  options: [
    { label: "Configure now",   description: "Provide brand name + category. System auto-discovers competitors every week and detects deltas." },
    { label: "Skip — disable",  description: "Leave competitor-intel disabled. Re-run /ops:setup later to configure." }
  ]
})
```

If **Skip — disable**: set `competitor-intel.enabled = false` in `daemon-services.json`. Stop.

If **Configure now**: collect two free-text values plus one optional:

1. `brand_name` — e.g. `"your-app"`, `"your-brand"`. The product/company being tracked.
2. `category` — e.g. `"AI health coaching apps"`, `"NL virtual real estate staging"`. The market segment Tavily searches in.
3. `report_timezone` — IANA TZ. Default: system TZ from previous setup steps, or `"UTC"`.

The system handles competitor discovery, news scanning, and synthesis automatically — no hardcoded competitor list to maintain. Tavily API key (`TAVILY_API_KEY` in env or Doppler) is required; if missing, the cron logs SKIP and exits cleanly.

Persist to `$PREFS_PATH`:

```bash
jq --arg brand "$BRAND" --arg cat "$CATEGORY" --arg tz "$TZ" \
   '.competitor_intel = {brand_name: $brand, category: $cat, max_competitors: 5, report_timezone: $tz}' \
   "$PREFS_PATH" > "$PREFS_PATH.tmp" && mv "$PREFS_PATH.tmp" "$PREFS_PATH"
```

Now set `competitor-intel.enabled = true` in `daemon-services.json`.
- `message-listener`: `{ "enabled": true, "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-message-listener.sh" }` — only if WhatsApp or Telegram configured

After rewriting the services config, do a quick health check (foreground, <2s), then background the reload:

```bash
# Quick health check — foreground (fast)
test -f "$DATA_DIR/daemon-services.json" && echo "✓ Daemon services config written — N services enabled"
```

Then **background** the actual daemon reload — it can be slow:

```bash
# Background — daemon reload is slow, don't block setup
launchctl kickstart -k gui/$(id -u)/com.claude-ops.daemon 2>&1 && echo "✓ Daemon reloaded" || echo "⚠ Daemon kick failed (may still be running)"
```

Use `run_in_background: true` on the reload command. Do NOT wait for it — continue immediately to the next step. The daemon will pick up the new config on its own cycle even if kickstart is slow.

Write `daemon.enabled = true` and `daemon.services` (the reconciled array) to `$PREFS_PATH`. Print:

```
✓ Daemon services reconciled — N services enabled (briefing-pre-warm, memory-extractor, whatsapp-bridge, ...)
  Daemon reloading in background.
```

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/docs/daemon-guide.md` for full operational instructions, CLI reference, and troubleshooting for the background daemon (service lifecycle, launchctl/systemd integration, health reporting, reconciliation semantics). The setup agent can load that file directly when it needs more depth than this wizard provides.

---

## Step 6 — Save preferences (if selected)

Collect these via `AskUserQuestion` — one question each. **Never auto-fill from memory, existing configs, or previous sessions. Always ask explicitly.**

1. **Owner name** (free text): "What should Claude call you in briefings?" — no default, no suggestions from memory.

2. **Timezone** (single select — max 4 options per call, batch by region):

   First, detect the system timezone via `date +%Z` or `readlink /etc/localtime`. If detected, offer it as the first option:
   ```
   Select your timezone:
     [<detected timezone>]
     [Americas...]
     [Europe/Asia/Oceania...]
     [Other — type it]
   ```
   If user picks "Americas...": `[America/New_York]`, `[America/Los_Angeles]`, `[America/Chicago]`, `[Back]`
   If user picks "Europe/Asia/Oceania...": `[Europe/London]`, `[Asia/Bangkok]`, `[Asia/Tokyo]`, `[Australia/Sydney]`

3. **Briefing verbosity** (single select):
   ```
   How much detail do you want in briefings?
     [full]     — complete rundown of all channels, projects, and incidents
     [compact]  — key signals only, one line per item
     [minimal]  — just the fires and urgent items
   ```

4. **Primary project** → **"All projects active in last 7 days" should be the first/default option.** Most users working across multiple projects want a unified briefing, not a single-project focus:
   ```
   Primary project for briefings?
     [All projects active in last 7 days]  ← default
     [Pick a specific project...]
   ```
   If "specific project", show registry aliases paginated at 3 per page + `[More...]`. Store `"primary_project": "all_active_7d"` for the default, or the specific alias.

5. **YOLO mode** → select `[Yes — auto-approve low-risk actions]`, `[No — always confirm]`.

6. **Default channels** (single-select — these two options are mutually exclusive). **"All configured" should be the first option and pre-selected by default** — most users want all their channels active:
   ```
   Which channels should ops skills use by default?
     [All configured channels]
     [Pick specific channels...]
   ```
   If the user picks "specific channels", show a follow-up multiSelect with individual channel checkboxes. If they accept "All configured", set `default_channels` to the full list of configured channel names.

Write to `$PREFS_PATH`:

```json
{
  "version": "1.0",
  "owner": "...",
  "primary_project": "...",
  "timezone": "...",
  "briefing_verbosity": "...",
  "yolo_enabled": false,
  "default_channels": ["whatsapp", "email"],
  "secrets_manager": "doppler",
  "doppler": {
    "project": "...",
    "config": "..."
  },
  "channels": {
    "telegram": { "bot_token": "...", "owner_id": "..." }
  }
}
```

If the file already exists, **merge** — don't overwrite. Read with `jq`, apply updates with `jq '. + { ... }'`, write back.

---

## Step 6.5 — Auto-fix subsystem + auxiliary daemons (if selected)

This step configures four subsystems that ship with the plugin but stay opt-in: the deploy/build auto-fix loop, the recap marquee (tmux digest), the periodic Task* tool reminder, and the multi-account Claude rotator. All settings persist into `$PREFS_PATH` under the same keys declared in `.claude-plugin/plugin.json` `userConfig`, so the running daemons and hooks pick them up immediately.

**Re-run guard (Rule 3 compliant).** Before each sub-flow, check `$PREFS_PATH` for an existing block. If found, show current state and ask:

```
Deploy auto-fix is already configured. What now?
  [Keep current settings]
  [Re-run wizard]
  [Show full config]
  [Skip]
```

Only continue into the wizard on `Re-run wizard`. Same pattern for `recap_marquee_enabled`, `task_reminder_enabled`, and `account_rotation_enabled`.

All `jq` writes use the merge pattern from Step 6: read → `jq '. + { ... }'` → write to a temp file → `mv`. Never overwrite the file.

### 6.5a — Deploy auto-fix wizard

**Step A1 — master switch** (`AskUserQuestion`, 4 options — Rule 1):

```
Enable deploy auto-fix?
  [Yes — full autonomy (monitor + dispatch fixer)]
  [Yes — notify only, no agent dispatch]
  [Skip]
  [Configure later]
```

Mapping:
- `Yes — full autonomy` → `deploy_fix_enabled=true`, `auto_dispatch_fixer=true`
- `Yes — notify only` → `deploy_fix_enabled=true`, `auto_dispatch_fixer=false`
- `Skip` → `deploy_fix_enabled=false`, persist and jump to 6.5b
- `Configure later` → record `deploy_fix.deferred=true` and jump to 6.5b

**Step A2 — behavior toggles** (only when enabled). `AskUserQuestion` `multiSelect: true`, exactly 4 options:

```
Which auto-fix behaviors should run? (multi-select)
  [monitor_post_merge — watch deploy after PR merge]
  [monitor_build_failures — auto-fix local `npm run build:*` failures]
  [audit_health_after_deploy — curl /health after deploy]
  [verify_served_commit — check served SHA matches merged SHA]
```

Persist each as a top-level boolean key. Unchecked = `false`.

**Step A3 — danger flag:**

```
Allow fixer to skip permission prompts (true unattended autonomy)?
  [Yes — pass --dangerously-skip-permissions]
  [No — safer, may prompt mid-fix]
  [Skip]
```

Persist `allow_dangerous` (true/false). `Skip` → leave default (`false`).

**Step A4 — hourly budget:**

```
Per-repo hourly fix budget?
  [1 — conservative]
  [3 — default]
  [5]
  [10 — aggressive]
```

Persist `max_fixes_per_hour` (integer).

**Step A5 — notification channel:**

```
Notification channel for failures?
  [macOS — terminal-notifier]
  [ntfy.sh — phone push]
  [Discord webhook]
  [None]
```

Persist `notify_channel` ∈ `macos|ntfy|discord|none`.

**Step A6 — channel credentials** (Rule 3 — never silently skip):

- `ntfy` selected and `ntfy_topic` empty in prefs → ask for topic. The topic name is public (not sensitive). If user picks `Skip`, downgrade `notify_channel` to `none` and tell them why.

  ```
  ntfy.sh topic name?
    [Paste topic]
    [Skip — downgrade to no notifications]
  ```

- `discord` selected and no `discord_default_webhook_url` AND no `discord_webhook_url` in prefs → ask for webhook URL with `sensitive: true`:

  ```
  Discord webhook URL?
    [Paste webhook URL]
    [Skip — downgrade to no notifications]
  ```

  On paste, write `discord_default_webhook_url` (sensitive). On skip, downgrade `notify_channel` to `none`.

- `macos` selected → background-check `command -v terminal-notifier` (Rule 4). If missing, run `brew install terminal-notifier` with `run_in_background: true` and continue.

Use the `lib/credential-store.{sh,mjs}` helpers when persisting sensitive values so they land in the keychain instead of plaintext prefs.

**Step A7 — registry seeding:**

```
Seed service registry from your repos?
  [Yes — scan ~/Projects + ~ for git repos]
  [No — I'll edit ~/.claude/config/post-merge-services.json by hand]
  [Skip]
```

If yes, run in background (Rule 4):

```bash
find ~/Projects ~ -maxdepth 3 -type d -name .git 2>/dev/null \
  | xargs -I{} dirname {} \
  | while read repo; do
      slug=$(cd "$repo" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
      [ -n "$slug" ] && echo "$slug|$repo"
    done > /tmp/ops-deploy-fix-detected.$$
```

Read the detected slugs, dedupe, then prompt the user **paginated 4 at a time per `AskUserQuestion`** (Rule 1) for the health URL of each repo's `:dev` and `:main` bases.

Per-repo prompt:

```
Health URL for <slug>:dev? (leave blank to skip)
  [Paste URL]
  [Reuse last pattern — apply *-dev → * for :main]
  [Skip this repo]
  [Skip remaining repos]
```

For each accepted entry, append to `~/.claude/config/post-merge-services.json` (create file if missing) using the merge pattern:

```bash
mkdir -p ~/.claude/config
[ -f ~/.claude/config/post-merge-services.json ] || echo '{}' > ~/.claude/config/post-merge-services.json
jq --arg k "$slug:dev" --arg h "$health_url" --arg v "$version_url" \
  '. + { ($k): { health: $h, version: $v } }' \
  ~/.claude/config/post-merge-services.json > /tmp/reg.$$ \
  && mv /tmp/reg.$$ ~/.claude/config/post-merge-services.json
```

Tell the user the count written and the file path.

**Step A8 — persist the deploy-fix block:**

```bash
jq '. + {
  deploy_fix_enabled: <bool>,
  monitor_post_merge: <bool>,
  monitor_build_failures: <bool>,
  audit_health_after_deploy: <bool>,
  verify_served_commit: <bool>,
  auto_dispatch_fixer: <bool>,
  allow_dangerous: <bool>,
  max_fixes_per_hour: <int>,
  notify_channel: "<channel>",
  ntfy_topic: "<topic>",
  discord_default_webhook_url: "<url>",
  deploy_fix: { configured_at: "<ISO timestamp>", wizard_version: 1 }
}' "$PREFS_PATH" > /tmp/p.$$ && mv /tmp/p.$$ "$PREFS_PATH"
```

Omit any key whose value is empty/unset. Use `lib/credential-store` for sensitive values rather than plaintext.

### 6.5b — Recap marquee (tmux digest)

```
Enable recap marquee daemon? (one-line digest of all parallel Claude sessions in tmux status-right)
  [Yes — auto-configure ~/.tmux.conf]
  [Yes — toggle on, don't touch tmux.conf]
  [No]
  [Skip]
```

- `Yes — auto-configure` → `recap_marquee_enabled=true`, `recap_marquee_auto_configure_tmux=true`. In background (Rule 4): grep `~/.tmux.conf` for `ops-recap-marquee`. If absent, append the source line and run `tmux source-file ~/.tmux.conf` (only if `tmux info` succeeds — i.e. server is running).
- `Yes — no tmux change` → `recap_marquee_enabled=true`, `recap_marquee_auto_configure_tmux=false`.
- `No` → both keys `false`.
- `Skip` → leave defaults, mark `recap_marquee.deferred=true`.

### 6.5c — Periodic Task* tool reminder

```
Enable Task* tool reminder hook?
  [Yes — default threshold (10 calls)]
  [Yes — custom threshold]
  [No — disable hook]
  [Skip]
```

If `custom threshold`, follow up:

```
Reminder threshold (tool calls without a Task*)?
  [5]
  [10]
  [20]
  [50]
```

Persist `task_reminder_enabled` (bool) and `task_reminder_threshold` (int).

### 6.5d — Account rotation toggle (toggle only)

The full multi-account OAuth wizard is a separate task — this step only flips the master toggle.

```
Enable multi-account Claude rotator?
  [Yes — enable toggle, OAuth wizard later]
  [No]
  [Skip]
```

Persist `account_rotation_enabled` (bool). On `Yes`, print:

```
✓ Account rotation toggle enabled. Run /ops:setup --section deploy-fix later to wire OAuth per account.
```

### 6.5 — completion print

After all four sub-flows, print:

```
✓ Deploy auto-fix:    <on/off>  (autonomy=<full|notify|off>, budget=<N>/hr, notify=<channel>)
✓ Recap marquee:      <on/off>  (tmux=<auto|manual>)
✓ Task reminder:      <on/off>  (threshold=<N>)
✓ Account rotation:   <on/off>  (OAuth wizard pending)
```

Then continue to Step 7.

---

## Step 7 — Shell env (if selected)

1. Check whether `CLAUDE_PLUGIN_ROOT` is already exported in the profile file (grep for `CLAUDE_PLUGIN_ROOT`).
2. If missing, **append it automatically** — this is a required step, not optional. Use `>>` (append, never overwrite). Print: `"✓ Added export CLAUDE_PLUGIN_ROOT=... to ~/.zshrc"`. Do NOT ask the user for permission — Rule 2 (never delegate commands to the user) applies here.
3. Tell the user: `"Run 'source ~/.zshrc' or open a new terminal for it to take effect."` — this will show as an approval prompt in Claude's next tool call, which the user accepts normally.

---

## Step 8 — Final summary + validation

Re-run the detector and present a final status dashboard:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETUP COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ✓ Core CLIs:  jq, git, gh, aws, node
 ✓ Channels:   telegram, whatsapp, email
 ✓ Ecommerce:  shopify (<store_url>)             ← omit line if not configured
 ✓ Marketing:  klaviyo, meta, google-ads, ga4, gsc           ← omit line if not configured
 ✓ Voice:      bland, elevenlabs, groq           ← omit line if not configured
 ✓ Secrets:    doppler → my-app/dev
 ✓ MCPs:       linear, sentry, vercel
 ✓ Registry:   20 projects
 ✓ Prefs:      saved to ~/.claude/plugins/data/ops-ops-marketplace/preferences.json
 ✓ Daemon:     ops-daemon → whatsapp-bridge, memory-extractor, inbox-digest

 Next: /ops-go for your first briefing
──────────────────────────────────────────────────────
```

For each of ecommerce, marketing, and voice: only show the status line if at least one service was configured in that category. Use `✓` if configured, `○` if skipped. Omit the line entirely if the section was never visited.

For the daemon line, list only the services that were actually enabled (from the computed services array in Step 5b).

If any required tool is still missing, list it with the exact command to install it and stop short of claiming success.

After displaying the summary, run the completion banner to celebrate the successful setup. Pass the actual counts from the setup session:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-complete --channels <N> --projects <N> --agents 9 --skills 15
```

Where `<N>` is replaced with the actual number of channels configured and projects registered during this session.

---

## Reference material

- **Daemon health contract, invocation shortcuts, safety rules** → see [REFERENCE.md](REFERENCE.md)
- **CLI syntax** (gog, wacli, Slack token validation, macOS Keychain) → see [CLI-REFERENCE.md](CLI-REFERENCE.md)

Both are out-of-context until loaded.
