---
name: ops-gtm
description: "This skill should be used when the user asks to \"/ops:ops-gtm\", \"run ops-gtm\", or \"use ops-gtm\". Go-to-market strategy planner. Generates a complete GTM plan across paid, unpaid, marketing, sales, and AI-automation channels for any project — and hands executable campaigns off to /marketing."
argument-hint: '[plan|paid|unpaid|sales|automation|launch|brief|setup]'
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - Agent
  - TeamCreate
  - SendMessage
  - AskUserQuestion
  - WebFetch
  - WebSearch
  - Skill
effort: medium
maxTurns: 40
context: fork
---

# OPS ► GTM COMMAND CENTER

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Strategy layer that sits on top of `/marketing`. `/marketing` runs campaigns; `/gtm` decides what to run, across paid, unpaid, sales, and AI-automation channels, and then hands the executable pieces to `/marketing` via the Skill tool.

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — timestamp all output correctly
   - `gtm_default_project`, `gtm_default_audience`, `gtm_brand_voice` — project-level defaults when set
   - `gtm_monthly_budget`, `gtm_stage` (`pre-launch|beta|ga|scale`) — used to tune channel recommendations

2. **Cached plans**: List `${CLAUDE_PLUGIN_DATA_DIR}/gtm/*.md` to surface recent plans. Never overwrite a prior plan file — always append a new dated file.

3. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`. If `action_needed` is not null, surface it before running any long planning flow.

4. **Repo auto-scan (background)**: For the current working directory, in parallel and with `run_in_background: true`:
   - `git remote -v` → infer project slug and org
   - `cat README.md` (or `README.*`) → product description, ICP hints
   - Glob `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` → tech stack
   - Glob `.planning/**/*.md` and `docs/**/*.md` → prior briefs, positioning notes
   - Resolve: project name, one-line pitch, primary tech, existing channels hinted in the repo

5. **`/marketing` credential probe (read-only)**: Do NOT re-resolve API keys in this skill. Instead, when the user asks to launch something, delegate to `/marketing` via the Skill tool — `/marketing` owns the credential resolution chain (userConfig → env vars → Doppler → Dashlane → Keychain → gcloud ADC).

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** for the `plan` sub-command so the four research agents share context and report progress in real-time:

```
TeamCreate("gtm-research-team")
Agent(team_name="gtm-research-team", name="paid-research",       prompt="Research paid acquisition channels that fit ${PROJECT_TYPE} at ${STAGE} with $${MONTHLY_BUDGET}/mo. Return a ranked list with fit signals, expected CAC, and which /marketing sub-command (if any) executes each channel.")
Agent(team_name="gtm-research-team", name="unpaid-research",     prompt="Research organic channels (SEO, content, community, PR, partnerships, referrals, lifecycle email) for ${PROJECT_TYPE} at ${STAGE}. Return ranked list with effort estimate, time-to-signal, and /marketing sub-command mapping.")
Agent(team_name="gtm-research-team", name="sales-research",      prompt="Design a sales motion for ${PROJECT_TYPE}: outbound vs inbound vs PLG vs channel. Propose a 30/60/90 plan with concrete activities and target metrics.")
Agent(team_name="gtm-research-team", name="automation-research", prompt="Propose AI-automation recipes: lead enrichment, personalized outreach, content ops, lifecycle copy, support deflection, lead scoring. For each, list trigger, model/tool stack, and where it plugs into /marketing.")
```

If the flag is NOT set, use standard fire-and-forget subagents with the same four prompts.

---

## Sub-command Routing

Route `$ARGUMENTS` to the correct section below:

| Input         | Action                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| (empty), plan | Full GTM plan across all four avenues                                                     |
| paid          | Paid acquisition deep-dive (Meta, Google, LinkedIn, TikTok, affiliates, sponsorships)     |
| unpaid        | Organic deep-dive (SEO, content, community, PR, partnerships, referrals, lifecycle email) |
| sales         | Sales motion (outbound, inbound, PLG, channel / partner)                                  |
| automation    | AI-automation playbook for GTM                                                            |
| launch        | 30/60/90 launch calendar + pre-flight checklist                                           |
| brief         | One-page positioning brief (ICP, value prop, messaging pillars)                           |
| setup         | Configure default project, audience, budget tier, brand voice                             |

Arguments are free-form — treat `/gtm plan for my-project $2k/mo pre-launch` as equivalent to `plan` with intake values pre-filled.

---

## Project Intake

Before producing any plan section, make sure the following are known. Source them in this order — only ask the user for what's still missing.

1. **Auto-scan the repo** (step 4 of Runtime Context).
2. **Read prefs** for `gtm_default_*` keys.
3. **Parse free-text in `$ARGUMENTS`** for budget, stage, and project name.
4. **AskUserQuestion for gaps** — respect Rule 1 (max 4 options per call; batch if needed).

Use these four questions in order, skipping any already known:

- **Project type** — `[B2B SaaS, B2C product, Marketplace, Dev tool / API]`
- **Stage** — `[Pre-launch, Beta / early access, GA (live), Scale (growth)]`
- **Primary goal (next 90 days)** — `[Awareness, Signups / leads, Revenue, Retention / expansion]`
- **Monthly budget tier** — `[<$1k, $1k–5k, $5k–25k, $25k+]`

If a Rule-1 batch overflows (e.g. more than 4 project types needed), paginate with `[More options...]` as the 4th slot.

Per Rule 3, never silently skip an intake question — if the user hits Escape, offer `[Paste manually]` / `[Use default]` / `[Skip this only]`.

---

## Channel / Avenue Catalog

See `references/catalog.md`.

## plan — full GTM plan (default)

1. **Intake** per Project Intake section.
2. **Spawn the four research agents** (Agent Teams if flag set, else fire-and-forget).
3. **Assemble the plan** in this order:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    GTM PLAN — [project]  ([stage], [goal], $[budget]/mo)
    [timestamp]
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    POSITIONING
     ICP:            [one sentence]
     Value prop:     [one sentence]
     Messaging:      [3 pillars, comma-separated]

    PAID (next 30 days)
     1. [Channel]  $[X]/mo  Expected CAC: $[X]  Execute: /marketing ads
     2. [Channel]  $[X]/mo  Expected CAC: $[X]  Execute: manual

    UNPAID (next 90 days)
     1. [Channel]  Effort: [L/M/H]  Signal in: [X wks]  Execute: /marketing seo
     2. [Channel]  ...

    SALES
     Motion:         [Outbound / Inbound / PLG / Channel]
     30/60/90:       [one line summary]

    AUTOMATION (AI-powered)
     1. [Recipe]     Plugs into: /marketing email
     2. [Recipe]     Plugs into: outbound

    KPIs
     North star:     [metric + target]
     Leading:        [3 leading indicators]

    BUDGET ROLLUP
     Paid:           $[X]/mo
     Tools/SaaS:     $[X]/mo
     Total:          $[X]/mo
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

4. **Persist the plan** to `${CLAUDE_PLUGIN_DATA_DIR}/gtm/<project-slug>-$(date +%Y-%m-%d).md` (create the directory if missing). Never overwrite — if the file exists, append `-v2`, `-v3`.
5. **Handoff prompt** — end with an `AskUserQuestion` (≤4 options per Rule 1):
   - `[Launch via /marketing]` — hand top executable items to `/marketing`
   - `[Save only]` — keep the plan file, take no action
   - `[Refine plan]` — re-run with adjusted intake
   - `[Schedule follow-up]` — revisit in 7/30 days (delegate to `/ops cron` if available)

On `[Launch via /marketing]`, iterate through plan items whose execution path starts with `/marketing` and invoke them one at a time via the Skill tool:

```
Skill("ops-marketing", args="campaigns")
Skill("ops-marketing", args="ads")
Skill("ops-marketing", args="email")
```

Never silently skip an item (Rule 3) — for each, ask `[Launch, Skip, Edit first]`.

Per Rule 5, do NOT auto-launch anything that spends money or sends to real recipients without explicit per-item confirmation. The plan recommends; `/marketing` executes; the user approves each paid or outbound action.

---

## paid — paid acquisition deep-dive

Same intake, but only spawn the `paid-research` agent. Render just the PAID block, with up to 5 channel rows and for each:

- Expected CAC range (cite source or reasoning)
- Creative angle suggestion
- Starting budget
- Attribution setup note (how `/marketing attribution` will measure it)
- `Execute:` line pointing to the `/marketing` sub-command or `manual`

End with the same handoff prompt as `plan`, scoped to paid channels.

---

## unpaid — organic deep-dive

Spawn `unpaid-research` only. For each recommended channel output:

- Why it fits (fit signals from intake)
- First-30-days concrete actions (3 bullets)
- Time-to-signal
- Measurement: which `/marketing` sub-command tracks it (`/marketing seo`, `/marketing email`, `/marketing instagram`) or `manual + tool`
- Lifecycle email is first-class here — recommend specific Klaviyo flows and note that `/marketing email` can scaffold them

---

## sales — sales motion

Spawn `sales-research` only. Produce:

1. **Motion pick** with one-paragraph rationale (Outbound / Inbound / PLG / Channel — Rule 1: these are the exact 4 options if you need the user to choose).
2. **ICP slice** — which segment to hit first, sized from intake.
3. **30/60/90 plan** — week-by-week activities (e.g. week 1: build list of 500 accounts; week 2: 200 outbound opens; …).
4. **Tooling** — CRM, enrichment, sequencer; note when AI automation from the automation section fits.
5. **Handoff** — offer `[Automate outreach via /gtm automation, Skip, Edit motion]`.

---

## automation — AI automation playbook

Spawn `automation-research` only. Render each recipe with:

- Trigger condition (what event fires it)
- Model / tool stack (default to Claude + the ops tool listed in the catalog)
- Integration point — specifically, which `/marketing` sub-command or external system it reads from and writes to
- Risk flags (PII, cost, brand-voice drift) and the guardrails that mitigate them
- Starter prompt / pseudo-code snippet so the user can copy-paste

End with `AskUserQuestion` offering `[Scaffold recipe now, Save only, Pick different recipe]`.

---

## launch — 30/60/90 launch calendar

Used at stage = pre-launch or beta. Produces a week-by-week calendar of launch activities across all four avenues.

Required pre-flight checklist (render and check what's ready vs open):

```
☐ Positioning brief  →  /gtm brief
☐ Landing page live  →  manual
☐ Analytics wired    →  /marketing setup (GA4 + GSC)
☐ Email capture live →  /marketing email  (Klaviyo list)
☐ Ad accounts ready  →  /marketing setup (Meta, Google)
☐ Social handles claimed   →  manual
☐ Product Hunt / HN plan   →  this skill, below
☐ Press / creator list     →  manual
```

Launch-day playbook: render hourly timeline for T-7d through T+14d, with concrete actions and the `/marketing` command (or manual step) for each.

---

## brief — one-page positioning brief

Fast path — does NOT spawn the four research agents. Just intake + a single call to write the brief. Fields: **ICP**, **Pain**, **Value prop**, **3 messaging pillars**, **Proof points**, **Anti-positioning (who it's NOT for)**. Save to `${CLAUDE_PLUGIN_DATA_DIR}/gtm/<project-slug>-brief-$(date +%Y-%m-%d).md`.

This is the cheapest entry point — recommend running `/gtm brief` before `/gtm plan` when the project's positioning isn't already written down.

---

## setup

Configure GTM defaults so subsequent runs skip the intake questions. Per Rule 4, run every Bash call with `run_in_background: true` unless the result is needed for the very next decision.

**Auto-scan (background) first:**

```bash
# Existing prefs
jq -r '{project: .gtm_default_project, audience: .gtm_default_audience, voice: .gtm_brand_voice, budget: .gtm_monthly_budget, stage: .gtm_stage}' "$PREFS_PATH" 2>/dev/null

# Repo signals
git -C "$PWD" remote get-url origin 2>/dev/null
head -50 README.md 2>/dev/null
ls .planning/ 2>/dev/null
```

Then prompt for what's missing (≤4 options per Rule 1), in this order:

1. **Default project name** — free-text, pre-filled from git remote slug
2. **Project type** — `[B2B SaaS, B2C product, Marketplace, Dev tool / API]`
3. **Stage** — `[Pre-launch, Beta, GA, Scale]`
4. **Monthly budget tier** — `[<$1k, $1k–5k, $5k–25k, $25k+]`
5. **Brand voice** — `[Playful, Professional, Technical, Bold]`

Save to `$PREFS_PATH` as `gtm_default_project`, `gtm_project_type`, `gtm_stage`, `gtm_monthly_budget`, `gtm_brand_voice`. Never write API keys here — GTM does not own any credentials (`/marketing` does).

Finish with a smoke test: run `/gtm brief` in background and report `✓ setup complete — try /gtm plan` or `✗ [error]`.

---

## Plugin Rules compliance (required reading)

All behavior above respects `claude-ops/CLAUDE.md`:

- **Rule 0 — public repo**: every example above uses `your-project`, `you@example.com`, `<YOUR_TOKEN>`. Never save user-specific data outside `$PREFS_PATH` or `${CLAUDE_PLUGIN_DATA_DIR}/gtm/`.
- **Rule 1 — ≤4 options per AskUserQuestion**: every prompt in this file lists exactly ≤4. Paginate with `[More options...]` if a dynamic list grows past 4.
- **Rule 3 — never auto-skip**: on launch handoff, every plan item gets an explicit `[Launch, Skip, Edit first]` prompt. No silent skipping.
- **Rule 4 — background by default during setup**: all Bash calls in the `setup` flow use `run_in_background: true`.
- **Rule 5 — destructive actions need explicit confirmation**: `/gtm` never spends money or sends messages directly — it delegates to `/marketing`, which owns per-action confirmation. Recommendations are just that.

---

## Why this skill is thin

`/gtm` deliberately does NOT re-implement channel APIs. Credential resolution, curl calls, daemon data, and dashboards all live in `/marketing`. This skill is a strategy-and-handoff layer. If a capability belongs to a channel API, add it to `/marketing`; if it belongs to planning, it goes here.

## Additional resources

CLI detail: `references/cli.md`.
