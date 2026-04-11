# claude-ops — v1.0 Plugin Launch

**Target:** Publishable Claude Code business operations plugin
**Created:** 2026-04-11

## Phase 1: Plugin Scaffold + Registry + bin/ Scripts [pending]

**Goal:** Establish the publishable plugin structure with all data-gathering shell scripts. `ops-gather` runs in <10s and outputs complete JSON for all projects.

**Requirements:**
- .claude-plugin/plugin.json with userConfig for API keys
- scripts/registry.json with Sam's full project registry
- scripts/setup.sh for first-run CLI validation
- bin/ops-gather (master parallel gatherer)
- bin/ops-git (git status across all repos → JSON)
- bin/ops-infra (ECS/Vercel health → JSON)
- bin/ops-prs (PR dashboard → JSON)
- bin/ops-ci (CI status across repos → JSON)
- bin/ops-unread (unread messages across channels → JSON)
- output-styles/ops-briefing.md
- All bin/ scripts must be executable and read from registry.json

**Success Criteria:**
- [ ] `ops-gather | jq .` returns valid JSON with all data sections
- [ ] Each bin/ script runs independently and outputs valid JSON
- [ ] Total gather time <10s (parallel execution)
- [ ] Plugin loads via `claude --plugin-dir ~/Projects/claude-ops`
- [ ] setup.sh validates CLI availability (wacli, gog, gh, aws, sentry-cli)

## Phase 2: Token-Efficient Morning Briefing (/ops-go) [pending]

**Goal:** Replace the current /go skill with /ops-go that uses shell pre-gathering via `!`command`` injection, reducing token usage by ~80%.

**Depends on:** Phase 1

**Requirements:**
- skills/ops/SKILL.md — main router that dispatches to sub-skills
- skills/ops-go/SKILL.md — morning briefing using `!`ops-infra``, `!`ops-git``, etc.
- agents/infra-monitor.md — ECS/AWS health check subagent
- agents/project-scanner.md — Git/PR/CI status subagent
- Briefing format matches current /go output (fires, PRs, dashboard, priorities)
- Interactive a/b/c options at the end

**Success Criteria:**
- [ ] /ops-go produces equivalent briefing to /go
- [ ] Token usage <100K (vs ~500K current)
- [ ] Shell injection pre-loads all data before Claude processes
- [ ] Interactive options work (a/b/c selection)

## Phase 3: Communications Hub [pending]

**Goal:** Unified inbox and messaging across WhatsApp, Email, Slack, and Telegram from Claude Code.

**Depends on:** Phase 1

**Requirements:**
- skills/ops-inbox/SKILL.md — inbox zero across all channels
- skills/ops-comms/SKILL.md — send/read messages with smart routing
- agents/comms-scanner.md — parallel channel scanner
- WhatsApp adapter (wacli sync + messages)
- Email adapter (gog gmail search)
- Slack adapter (MCP tools)
- Telegram adapter (MCP server — placeholder until Phase 7)
- Smart routing: /ops-comms send "msg" to X → picks right channel

**Success Criteria:**
- [ ] /ops-inbox shows unread counts from WhatsApp + Email + Slack
- [ ] /ops-comms send routes to correct channel based on contact
- [ ] Inbox zero flow: read → respond → archive per channel
- [ ] Batch response drafting with user approval

## Phase 4: Project Management + Linear + Triage [pending]

**Goal:** Manage Linear sprints, auto-triage issues across Sentry/Linear/GitHub, and track production fires.

**Depends on:** Phase 2

**Requirements:**
- skills/ops-projects/SKILL.md — project dashboard with GSD state
- skills/ops-linear/SKILL.md — Linear command center (create, update, close, sprint board)
- skills/ops-triage/SKILL.md — cross-platform triage (Sentry+Linear+GitHub)
- skills/ops-fires/SKILL.md — production incidents dashboard
- skills/ops-deploy/SKILL.md — deploy status across all projects
- agents/triage-agent.md — auto-resolves fixed issues, cross-references code

**Success Criteria:**
- [ ] /ops-linear creates/updates/closes issues via MCP
- [ ] /ops-triage auto-resolves issues that are already fixed in code
- [ ] /ops-fires shows ECS health + Sentry errors + failed deploys
- [ ] /ops-projects reads GSD state per project (phase, progress)

## Phase 5: Business Intelligence + Revenue + Next [pending]

**Goal:** Revenue tracking, cost analysis, and intelligent next-action routing that prioritizes by business impact.

**Depends on:** Phase 4

**Requirements:**
- skills/ops-revenue/SKILL.md — MRR/burn/credits/cost tracker
- skills/ops-next/SKILL.md — business-priority next action (fires > comms > revenue > GSD)
- agents/revenue-tracker.md — AWS costs, credits, billing data
- Integration with AWS Cost Explorer (aws ce)
- Integration with GSD roadmaps for advancement
- Priority routing: fires → comms → PRs → Linear → /gsd-next

**Success Criteria:**
- [ ] /ops-next correctly prioritizes fires > comms > revenue > GSD
- [ ] /ops-revenue shows AWS costs, active credits, burn rate
- [ ] Full flow: /ops-go → pick option → execute → /ops-next chains correctly
- [ ] GSD commands chain from ops layer (/gsd-next, /gsd-autonomous)

## Phase 6: YOLO Mode — Autonomous Business Operator [pending]

**Goal:** The killer feature. /ops-yolo spawns 4 parallel C-suite agents (CEO/CTO/CFO/COO) that analyze the business independently, produce an unfiltered report of hard truths, and after approval autonomously run the business for a day.

**Depends on:** Phase 5

**Requirements:**
- skills/ops-yolo/SKILL.md — main YOLO orchestrator
- skills/ops-yolo/ceo-analysis.md — strategic priority template
- skills/ops-yolo/cto-analysis.md — technical health template
- skills/ops-yolo/cfo-analysis.md — financial analysis template
- skills/ops-yolo/coo-analysis.md — operations execution template
- agents/yolo-ceo.md — ruthless priority stack ranked by $/hour
- agents/yolo-cto.md — kill/fix/ship list for every project
- agents/yolo-cfo.md — cost optimization + revenue acceleration
- agents/yolo-coo.md — inbox zero plan + PR queue + follow-ups
- YOLO report with "Hard Truths" section
- 8-hour execution plan with time blocks
- "What to Kill" and "What to Double Down On" sections
- Approval checkpoint before autonomous execution
- /loop integration for continuous execution with 2-hour checkpoints
- Chains /ops-fires, /ops-inbox, /ops-triage, /gsd-autonomous, /ops-deploy

**Success Criteria:**
- [ ] /ops-yolo --dry-run produces actionable C-suite report
- [ ] Hard truths are genuinely uncomfortable but useful
- [ ] 4 agents run in parallel and complete in <2 minutes
- [ ] After "YOLO" approval, chains all ops+gsd commands autonomously
- [ ] 2-hour checkpoints allow user to course-correct
- [ ] End-of-day revenue impact report generated

## Phase 7: Telegram MCP Server [pending]

**Goal:** Native Telegram send/receive integration via a bundled MCP server.

**Depends on:** Phase 3

**Requirements:**
- .mcp.json with Telegram MCP server config
- telegram-server/ directory with Node.js MCP server
- Telegram Bot API integration (send messages, read updates)
- channels support in plugin.json for message injection
- userConfig for bot_token and owner_id

**Success Criteria:**
- [ ] Send messages to Telegram contacts from Claude Code
- [ ] Receive and read Telegram messages
- [ ] Channel integration injects messages into conversation
- [ ] Bot token stored securely via userConfig (keychain)

## Phase 8: Polish + Publish [pending]

**Goal:** Publish to GitHub marketplace as an installable Claude Code plugin.

**Depends on:** Phase 7

**Requirements:**
- CHANGELOG.md with version history
- LICENSE (MIT)
- README.md with installation, setup, and usage guide
- GitHub repo setup (auroracapital/claude-ops)
- Marketplace listing with description and keywords
- setup.sh validates all CLIs and reports missing ones
- GSD dependency declared and prompted on install

**Success Criteria:**
- [ ] Fresh install on clean machine works end-to-end
- [ ] `claude plugin install ops@auroracapital/claude-ops` succeeds
- [ ] setup.sh reports CLI availability clearly
- [ ] /ops-go works immediately after registry.json is configured
- [ ] GSD prerequisite prompted if missing
