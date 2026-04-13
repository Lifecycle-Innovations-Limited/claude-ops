---
created: 2026-04-13T14:39:49.080Z
title: Port OpenClaw features to claude-ops
area: tooling
files:
  - claude-ops/skills/ops/SKILL.md
  - claude-ops/skills/ops-orchestrate/SKILL.md
  - claude-ops/.claude-plugin/plugin.json
---

## Problem

OpenClaw has several features that claude-ops lacks. Research completed 2026-04-13 identified these gaps. Implementing them would make claude-ops a full replacement for OpenClaw-style orchestration within Claude Code.

## Features to Port

### 1. Multi-Agent Workspace System (HIGH)
- Isolated workspaces per agent with routing bindings
- Per-agent model selection and automatic fallbacks
- Skill/tool access control per agent
- Config: `agents.list[].workspace`, `agents.list[].tools`, `agents.list[].skills`

### 2. Capability Profiles / Tool Access Control (HIGH)
- Defined tool groups: `minimal`, `coding`, `messaging`
- Per-skill tool restrictions instead of listing every tool in SKILL.md
- Hierarchical skill/tool inheritance with overrides
- Example: `capabilities: "coding"` instead of listing 15 tools

### 3. Provider Failover & Model Aliases (HIGH)
- Primary model with automatic fallbacks (Opus → Sonnet → Haiku)
- Model aliases for human-friendly references
- Provider-level auth ordering
- Useful for rate-limit resilience in ops-orchestrate

### 4. Config $include / Composable Config (MEDIUM)
- Split large configs into composable files with `$include`
- Hot reload without restart
- CLI-driven validation via `ops config validate`
- registry.json + preferences.json could become modular

### 5. Webhook → Agent Routing (MEDIUM)
- External events (GitHub push, Sentry alert) trigger specific agents
- Path matching + template rendering
- Route to specific agents/channels
- Pattern for ops incident automation (Sentry alert → auto-dispatch fix agent)

### 6. Session Isolation Strategies (MEDIUM)
- `per-channel-peer` isolation for multi-user/multi-channel
- Thread binding with auto-unbind on idle
- Identity links across channels (same person on WhatsApp + Slack)
- Useful for ops-inbox maintaining per-contact state

### 7. Exec Approval Allowlisting (LOW)
- Persistent approval for known-safe commands
- Per-session elevated access toggling
- Skip confirmation for low-risk ops commands
- File: `exec-approvals.json`

### 8. Node Distributed Execution (LOW)
- Run tools on remote machines via WebSocket nodes
- Device pairing for mobile/remote server
- Camera/screen/location capabilities
- Useful for ops-deploy on remote servers

### 9. Plugin Registration SDK (LOW — architectural)
- `registerProvider`, `registerTool`, `registerChannel` API
- Plugin manifests with `openclaw.plugin.json`
- Separate concerns: providers, channels, tools, hooks, services
- Would formalize ops skill/agent registration

## Solution

Prioritize by impact:
1. **Provider failover** → add to ops-orchestrate agent dispatch (Opus → Sonnet fallback)
2. **Capability profiles** → define tool groups, reference by name in SKILL.md frontmatter
3. **Webhook routing** → new `ops-webhooks` skill or `bin/ops-webhook-handler`
4. **Multi-workspace** → extend registry.json with per-project agent configs
5. **Config includes** → split preferences.json into modular files
6. Rest → backlog for future milestones
