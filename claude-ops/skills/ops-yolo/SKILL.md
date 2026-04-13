---
name: ops-yolo
description: YOLO mode. Spawns 4 parallel C-suite agents (CEO, CTO, CFO, COO). Each analyzes the business from their perspective using ALL available data. Produces unfiltered Hard Truths report. After user types YOLO, autonomously runs the business for a day using /loop.
argument-hint: "[YOLO|analyze|report]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - TeamCreate
  - SendMessage
  - mcp__claude_ai_Linear__list_issues
  - mcp__claude_ai_Linear__list_cycles
  - mcp__claude_ai_Vercel__list_deployments
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ai_Gmail__gmail_search_messages
---

# OPS ► YOLO MODE

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** instead of fire-and-forget subagents for the C-suite analysis (Phase 2). This enables:
- Agents can share findings mid-analysis (CEO discovers a revenue blocker → CFO factors it into ROI)
- You can steer agents if early findings change priorities
- Agents coordinate on the consensus recommendation

**Team setup** (only when flag is enabled):
```
TeamCreate("yolo-csuite")
Agent(team_name="yolo-csuite", name="ceo", subagent_type="ops:yolo-ceo", ...)
Agent(team_name="yolo-csuite", name="cto", subagent_type="ops:yolo-cto", ...)
Agent(team_name="yolo-csuite", name="cfo", subagent_type="ops:yolo-cfo", ...)
Agent(team_name="yolo-csuite", name="coo", subagent_type="ops:yolo-coo", ...)
```

After initial analysis, use `SendMessage(to="ceo", content="CTO found critical tech debt in auth service — does this change your strategic recommendation?")` to cross-pollinate findings before synthesizing the Hard Truths report.

If the flag is NOT set, fall back to standard parallel subagents (fire-and-forget, no mid-task steering).

## Phase 1 — Pre-gather ALL data

Run all of these simultaneously:

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || echo '{}'
```

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-git 2>/dev/null || echo '[]'
```

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-prs 2>/dev/null || echo '[]'
```

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-ci 2>/dev/null || echo '[]'
```

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-unread 2>/dev/null || echo '{}'
```

```!
aws ce get-cost-and-usage --time-period "Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d)" --granularity MONTHLY --metrics "UnblendedCost" --output json 2>/dev/null || echo '{}'
```

```!
cat "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null || echo '{}'
```

```!
for d in $(jq -r '.projects[] | select(.gsd == true) | .paths[]' "${CLAUDE_PLUGIN_ROOT}/scripts/registry.json" 2>/dev/null); do
  expanded="${d/#\~/$HOME}"
  [ -f "$expanded/.planning/STATE.md" ] && echo "=== $(basename $expanded) ===" && cat "$expanded/.planning/STATE.md" && echo "---"
done
```

---

## Phase 2 — Spawn 4 C-suite agents in parallel

Spawn these 4 agents simultaneously using all pre-gathered data as context. Each writes their analysis to a file in `/tmp/yolo-[session]/`:

### Agent 1 — CEO (Strategic)

Uses `agents/yolo-ceo.md`. Writes `/tmp/yolo-[session]/ceo-analysis.md`.

- What's the #1 thing blocking growth right now?
- Are we building the right things?
- Where are we wasting time vs. creating value?
- What would you tell an investor today, unfiltered?

### Agent 2 — CTO (Technical)

Uses `agents/yolo-cto.md`. Writes `/tmp/yolo-[session]/cto-analysis.md`.

- What's the worst technical debt that will bite us?
- Which services are time-bombs?
- Is the team/architecture set up to scale?
- What corners were cut that need fixing now?

### Agent 3 — CFO (Financial)

Uses `agents/yolo-cfo.md`. Writes `/tmp/yolo-[session]/cfo-analysis.md`.

- Actual burn rate vs. runway
- Which AWS services are waste?
- When do we hit zero if nothing changes?
- What's the ROI on current work?

### Agent 4 — COO (Operations)

Uses `agents/yolo-coo.md`. Writes `/tmp/yolo-[session]/coo-analysis.md`.

- What's falling through the cracks right now?
- Which processes are broken?
- What's the top execution risk this week?
- What should be automated that isn't?

---

## Phase 3 — Hard Truths Report

After all 4 agents complete, synthesize into a unified report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 YOLO ► HARD TRUTHS REPORT — [date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 CEO: [1-2 brutal strategic truths]

 CTO: [1-2 brutal technical truths]

 CFO: [1-2 brutal financial truths]

 COO: [1-2 brutal operational truths]

──────────────────────────────────────────────────────
 CONSENSUS: The #1 thing that matters today is:
 [single most important action, no sugar-coating]
──────────────────────────────────────────────────────

 Full analysis files saved to:
 /tmp/yolo-[session]/ceo-analysis.md
 /tmp/yolo-[session]/cto-analysis.md
 /tmp/yolo-[session]/cfo-analysis.md
 /tmp/yolo-[session]/coo-analysis.md

──────────────────────────────────────────────────────
 Type YOLO to hand over the controls.
 I'll run your business autonomously for the next day.
 This means: closing inbox, merging ready PRs,
 fixing fires, advancing GSD phases, triaging issues.

 Or:
 a) Read CEO analysis
 b) Read CTO analysis
 c) Read CFO analysis
 d) Read COO analysis
 e) Execute top recommendation now
──────────────────────────────────────────────────────
```

---

## Phase 4 — YOLO Autonomous Mode

If user types `YOLO` (all caps), enter autonomous mode via `/loop`.

**Before starting**, use `AskUserQuestion` to confirm scope:

```
YOLO mode will autonomously execute these steps:
  1. Inbox — reply to humans, archive automated
  2. Fires — fix CRITICAL/HIGH production issues
  3. PRs — merge ready PRs (CI green, approved)
  4. Triage — auto-resolve confirmed-fixed issues
  5. GSD — advance highest-priority phase
  6. Linear — sync sprint board
  7. Deploy — trigger pending deploys
  8. Report — summary

  [Run all 8 steps]  [Pick which steps to run]  [Cancel]
```

If user picks "Pick which steps", show each step as a `multiSelect` via `AskUserQuestion`.

Run the selected steps in sequence, reporting after each step.

**Per-step confirmations** (use `AskUserQuestion` before each destructive action):

- **Inbox**: Show drafted replies and ask `[Send all N replies]` / `[Review each one]` / `[Skip inbox]` before sending any messages
- **Fires**: Show proposed fix and ask `[Dispatch fix agent]` / `[Skip]` before each agent dispatch
- **PRs**: Show PR list and ask `[Merge all N ready PRs]` / `[Pick which ones]` / `[Skip]` before merging
- **Triage**: Show issues to close and ask `[Auto-resolve all N confirmed-fixed]` / `[Review each]` / `[Skip]` before closing
- **Deploy**: Show pending deploys and ask `[Deploy all]` / `[Pick which]` / `[Skip]` before triggering

After each step, check if new fires have appeared before proceeding.
Report final summary when done.

If `$ARGUMENTS` is `analyze` or empty, go straight to Phase 1.
If `$ARGUMENTS` is `YOLO`, skip to Phase 4.
If `$ARGUMENTS` is `report`, skip to Phase 3 (reads existing analysis files if present).
