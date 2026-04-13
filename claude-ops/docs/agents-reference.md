# Agents Reference

All 12 agents in claude-ops v0.5.0. Agent files live in `agents/`.

Agents are spawned by skills — they are not invoked directly. Each has `memory` scope for cross-session learning and a defined `effort` level that controls token budget.

---

## Background Scanner Agents

These agents run in the background, feeding structured JSON data to the main skills.

### `comms-scanner` · `agents/comms-scanner.md`
- **Model**: claude-sonnet-4-5
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Tools**: Bash only (read-only)
- **Purpose**: Scans all communication channels (WhatsApp, Email, Slack, Telegram) for FULL inbox state. Classifies each conversation as `NEEDS_REPLY`, `WAITING`, or `HANDLED`. Returns structured JSON consumed by `ops-inbox` and `ops-go`.

### `infra-monitor` · `agents/infra-monitor.md`
- **Model**: claude-sonnet-4-5
- **Effort**: low · **maxTurns**: 15
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: ECS, Vercel, and AWS health checker. Returns structured JSON with service health, recent deployments, and anomaly flags. Used by `ops-fires` and `ops-deploy`.

### `project-scanner` · `agents/project-scanner.md`
- **Model**: claude-sonnet-4-5
- **Effort**: low · **maxTurns**: 15
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: Git, PR, and CI status scanner across all registered repos. Returns structured JSON with branch state, uncommitted files, open PRs, and CI status for each project.

### `revenue-tracker` · `agents/revenue-tracker.md`
- **Model**: claude-sonnet-4-5
- **Effort**: medium · **maxTurns**: 20
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: Revenue, billing, and credits analysis. Queries AWS Cost Explorer, checks credit balances, cross-references project revenue stages. Returns structured financial snapshot for `ops-revenue` and `ops-go`.

---

## Fix Agents

These agents are dispatched when issues are found and need resolution.

### `triage-agent` · `agents/triage-agent.md`
- **Model**: claude-sonnet-4-5
- **Effort**: high · **maxTurns**: 40
- **Isolation**: worktree (sandboxed)
- **Purpose**: Investigates a specific issue from Sentry, Linear, or GitHub. Finds the root cause in code, checks if it's already fixed, and either confirms resolution or creates a fix branch with a PR. Runs in an isolated worktree to avoid polluting the main working tree.

---

## C-Suite Analysis Agents

All four run in parallel when `/ops:yolo` is invoked. Each uses Opus for maximum analytical depth.

### `yolo-ceo` · `agents/yolo-ceo.md`
- **Model**: claude-opus-4-6
- **Effort**: high · **maxTurns**: 20
- **Purpose**: Strategic priority analysis. Growth blockers, resource allocation, build vs. buy decisions, investor-readiness. No sugar-coating.

### `yolo-cto` · `agents/yolo-cto.md`
- **Model**: claude-opus-4-6
- **Effort**: high · **maxTurns**: 25
- **Purpose**: Technical health analysis. Architecture, tech debt, production risks, scalability limits, and cut corners. Brutally honest about what will break.

### `yolo-cfo` · `agents/yolo-cfo.md`
- **Model**: claude-opus-4-6
- **Effort**: high · **maxTurns**: 20
- **Purpose**: Financial analysis. AWS burn rate, runway, ROI on current work, credits expiry, cost anomalies. No optimism without data.

### `yolo-coo` · `agents/yolo-coo.md`
- **Model**: claude-opus-4-6
- **Effort**: high · **maxTurns**: 25
- **Purpose**: Operations execution analysis. Stale work, broken processes, missing automation, communication failures. What the CEO doesn't see.

---

## Daemon & System Agents

### `daemon-agent` · `agents/daemon-agent.md`
- **Model**: claude-sonnet-4-6
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Purpose**: Manages the ops background daemon — start, stop, restart services, check health. Spawned by `ops-doctor` and `ops-setup` when daemon configuration changes are needed.

### `doctor-agent` · `agents/doctor-agent.md`
- **Model**: claude-sonnet-4-6
- **Effort**: high · **maxTurns**: 30
- **Tools**: Bash, Read, Write, Edit, Grep, Glob (no Agent spawning)
- **Purpose**: Diagnoses and auto-fixes ops plugin configuration errors, manifest issues, broken permissions, invalid JSON, and stale cache copies. Spawned by `/ops:doctor`.

### `memory-extractor` · `agents/memory-extractor.md`
- **Model**: claude-haiku-4-5-20251001
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Purpose**: Background agent that extracts user profiles, contact cards, and behavioral patterns from chat history. Runs as a daemon service every 30 minutes. Writes structured markdown to `memories/`. Used by all communication skills for context-aware drafting.

---

## Agent Memory Scopes

| Scope | What persists |
|-------|--------------|
| `project` | Remembered across sessions within the same project context |
| `user` | Remembered across all projects for the same user |
| worktree isolation | Agent runs in a sandboxed worktree, changes don't bleed into main tree |
