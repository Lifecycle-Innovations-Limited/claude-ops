---
name: ops-research-audit
description: "OPS on-demand: This skill should be used when the user asks to \"audit my search tools\", \"check my MCP…"
argument-hint: '[tool-or-server]'
allowed-tools:
  - Read
  - Grep
  - Glob
  - WebSearch
  - WebFetch
  - Skill
effort: medium
maxTurns: 30
---

# OPS ► RESEARCH AUDIT

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Read [the research contract](references/research-contract.md) in full first. Its audit section (§5) defines this command; sections 1–4 govern every source you cite.

## Steps

1. **Discovery/configuration:** list the research and search tools this host offers in this session. Do not read shell configuration, dotfiles or secret stores to find more.
2. **Actual invocation:** make one harmless read-only call per relevant tool. Record the real result or error. A listed tool or a handshake is not proof it works; a failure is a coverage gap.
3. **Best-practice evidence:** read the official source for each tool you report on (contract §1, two-route cap §2).
4. Report the three parts separately. Per finding: current state, official source (URL + passage), effect, smallest proposal, acceptance test.

Never install, change configuration, send outbound messages, rotate secrets or restart services as part of the audit. Proposals go to the operator.
