<div align="center">

# Agents Reference

*All 12 agents that power claude-ops — scanners, fixers, C-suite analysts, and the daemon brain*

[![version](https://img.shields.io/badge/version-1.1.0-blue)](../CHANGELOG.md)
[![agents](https://img.shields.io/badge/agents-12-8b5cf6)](.)
[![sonnet](https://img.shields.io/badge/model-sonnet--4--6-6366f1)](.)
[![opus](https://img.shields.io/badge/model-opus--4--6-ef4444)](.)
[![haiku](https://img.shields.io/badge/model-haiku--4--5-22c55e)](.)

</div>

---

All 12 agents in claude-ops v1.1.0. Agent files live in `agents/`.

> [!NOTE]
> Agents are spawned by skills — they are not invoked directly. Each has a `memory` scope for cross-session learning and a defined `effort` level that controls token budget.

> [!IMPORTANT]
> **v1.1.0 model bumps:** All scanner, fix, and daemon agents upgraded to **`claude-sonnet-4-6`**. All C-suite analysts upgraded to **`claude-opus-4-6`**. The `memory-extractor` stays on Haiku for cost — it's the only background service that runs every 30 min on every box.

---

## 🔎 Background Scanner Agents

These agents run in the background, feeding structured JSON data to the main skills.

| Agent | Model | Effort | maxTurns | Tools | Consumed by |
|-------|-------|--------|----------|-------|-------------|
| `comms-scanner` | `claude-sonnet-4-6` | low | 10 | Bash (read-only) | `ops-inbox`, `ops-go` |
| `infra-monitor` | `claude-sonnet-4-6` | low | 15 | Bash | `ops-fires`, `ops-deploy` |
| `project-scanner` | `claude-sonnet-4-6` | low | 15 | Bash | `ops-projects`, `ops-go` |
| `revenue-tracker` | `claude-sonnet-4-6` | medium | 20 | Bash | `ops-revenue`, `ops-go` |

### `comms-scanner` · `agents/comms-scanner.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Tools**: Bash only (read-only)
- **Purpose**: Scans all communication channels (WhatsApp, Email, Slack, Telegram) for FULL inbox state. Classifies each conversation as `NEEDS_REPLY`, `WAITING`, or `HANDLED`. Returns structured JSON consumed by `ops-inbox` and `ops-go`.

### `infra-monitor` · `agents/infra-monitor.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: low · **maxTurns**: 15
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: ECS, Vercel, and AWS health checker. Returns structured JSON with service health, recent deployments, and anomaly flags. Used by `ops-fires` and `ops-deploy`.

### `project-scanner` · `agents/project-scanner.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: low · **maxTurns**: 15
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: Git, PR, and CI status scanner across all registered repos. Returns structured JSON with branch state, uncommitted files, open PRs, and CI status for each project.

### `revenue-tracker` · `agents/revenue-tracker.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: medium · **maxTurns**: 20
- **Memory**: project scope
- **Tools**: Bash only
- **Purpose**: Revenue, billing, and credits analysis. Queries AWS Cost Explorer, checks credit balances, cross-references project revenue stages. Returns structured financial snapshot for `ops-revenue` and `ops-go`.

---

## 🛠️ Fix Agents

These agents are dispatched when issues are found and need resolution.

### `triage-agent` · `agents/triage-agent.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: high · **maxTurns**: 40
- **Isolation**: worktree (sandboxed)
- **Purpose**: Investigates a specific issue from Sentry, Linear, or GitHub. Finds the root cause in code, checks if it's already fixed, and either confirms resolution or creates a fix branch with a PR. Runs in an isolated worktree to avoid polluting the main working tree.

> [!TIP]
> `triage-agent` runs in a sandboxed worktree — changes never bleed into your main working tree until a PR lands. Safe to fire-and-forget from `/ops:triage`.

---

## 💼 C-Suite Analysis Agents

All four run in **parallel** when `/ops:yolo` is invoked. Each uses **Opus 4.6** for maximum analytical depth.

> [!IMPORTANT]
> **v1.1.0 bump:** all four C-suite agents now run on `claude-opus-4-6` (up from `claude-opus-4-5` in v0.7.x). Expect sharper reasoning and slightly higher per-run token cost.

### C-Suite Spawn Flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant YOLO as /ops:yolo
    participant Ctx as Context Gatherer
    participant CEO as yolo-ceo (opus-4-6)
    participant CTO as yolo-cto (opus-4-6)
    participant CFO as yolo-cfo (opus-4-6)
    participant COO as yolo-coo (opus-4-6)
    participant Merger as Hard Truths Merger

    User->>YOLO: /ops:yolo [YOLO]
    YOLO->>Ctx: gather ops-infra + ops-dash
    Ctx-->>YOLO: unified context JSON

    par Parallel spawn
        YOLO->>CEO: strategic analysis
        YOLO->>CTO: technical analysis
        YOLO->>CFO: financial analysis
        YOLO->>COO: operational analysis
    end

    CEO-->>Merger: blockers, allocation, build-vs-buy
    CTO-->>Merger: architecture, debt, risks
    CFO-->>Merger: burn, runway, ROI
    COO-->>Merger: stale work, broken processes

    Merger->>User: unified Hard Truths report
    alt YOLO mode
        User->>YOLO: confirm autonomous execution
        YOLO->>User: execute with per-action confirm
    end
```

> [!IMPORTANT]
> `Hard Truths Merger` in the diagram above is the **main `/ops:yolo` skill orchestrator** running in the Claude Code main agent context — NOT a separate agent. It reads all four parallel analysis files (`ceo-analysis.md`, `cto-analysis.md`, `cfo-analysis.md`, `coo-analysis.md`) and composes the unified report. `yolo-ceo` is a peer agent with its own strategic perspective; it does not synthesize the others' work.

### `yolo-ceo` · `agents/yolo-ceo.md`
- **Model**: `claude-opus-4-6`
- **Effort**: high · **maxTurns**: 20
- **Purpose**: Strategic priority analysis. Growth blockers, resource allocation, build vs. buy decisions, investor-readiness. No sugar-coating.

### `yolo-cto` · `agents/yolo-cto.md`
- **Model**: `claude-opus-4-6`
- **Effort**: high · **maxTurns**: 25
- **Purpose**: Technical health analysis. Architecture, tech debt, production risks, scalability limits, and cut corners. Brutally honest about what will break.

### `yolo-cfo` · `agents/yolo-cfo.md`
- **Model**: `claude-opus-4-6`
- **Effort**: high · **maxTurns**: 20
- **Purpose**: Financial analysis. AWS burn rate, runway, ROI on current work, credits expiry, cost anomalies. No optimism without data.

### `yolo-coo` · `agents/yolo-coo.md`
- **Model**: `claude-opus-4-6`
- **Effort**: high · **maxTurns**: 25
- **Purpose**: Operations execution analysis. Stale work, broken processes, missing automation, communication failures. What the CEO doesn't see.

> [!WARNING]
> C-suite agents produce unfiltered "Hard Truths" — they will flag risks, dead projects, and wasted spend by name. Review before sharing with investors or teammates.

---

## ⚙️ Daemon & System Agents

### `daemon-agent` · `agents/daemon-agent.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Purpose**: Manages the ops background daemon — start, stop, restart services, check health. Spawned by `ops-doctor` and `ops-setup` when daemon configuration changes are needed.

### `doctor-agent` · `agents/doctor-agent.md`
- **Model**: `claude-sonnet-4-6`
- **Effort**: high · **maxTurns**: 30
- **Tools**: Bash, Read, Write, Edit, Grep, Glob (no Agent spawning)
- **Purpose**: Diagnoses and auto-fixes ops plugin configuration errors, manifest issues, broken permissions, invalid JSON, and stale cache copies. Spawned by `/ops:doctor`.

### `memory-extractor` · `agents/memory-extractor.md`
- **Model**: `claude-haiku-4-5-20251001`
- **Effort**: low · **maxTurns**: 10
- **Memory**: project scope
- **Purpose**: Background agent that extracts user profiles, contact cards, and behavioral patterns from chat history. Runs as a daemon service every 30 minutes. Writes structured markdown to `memories/`. Used by all communication skills for context-aware drafting.

> [!NOTE]
> The `memory-extractor` is the only agent that still runs on **Haiku 4.5** — it's optimised for cheap high-frequency extraction. See [`memories-system.md`](memories-system.md) for details.

---

## 🧠 Agent Memory Scopes

| Scope | What persists |
|-------|--------------|
| `project` | Remembered across sessions within the same project context |
| `user` | Remembered across all projects for the same user |
| worktree isolation | Agent runs in a sandboxed worktree — changes don't bleed into main tree |

> [!TIP]
> Memory scope is declared in each agent file's frontmatter. To reset an agent's memory, delete the matching subdirectory in `~/.claude/plugins/data/ops-ops-marketplace/memories/`.
