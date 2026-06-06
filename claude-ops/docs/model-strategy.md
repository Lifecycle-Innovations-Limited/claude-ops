# Model Strategy — Balanced Claude Tiers

**Date:** 2026-06-06  
**Status:** Recommended for all new claude-ops installations and updates  
**Rationale:** Balanced speed/cost/quality optimization via benchmarking across skills and /ops commands

## Overview

This document describes the recommended model assignment strategy for all gstack skills and /ops commands. The strategy uses three Claude tiers to balance latency, cost, and output quality:

- **Claude Opus 4.8** — Heavy reasoning, complex analysis, high-stakes decisions
- **Claude Sonnet 4.6** — Balanced reasoning, decision-making, synthesis
- **Claude Haiku 4.5** — Fast, lightweight tasks, navigation, simple extraction

## Benchmark Data

### Code Review (Representative Heavy Task)
- **Claude Opus 4.8:** 14.7s, 1144 tokens, $0.15 ✓
- **Gemini 2.5 Pro:** 105.8s timeout, 0 tokens, auth failure ✗
- **GPT 5.4:** Auth broken (token reuse), unreliable ✗

**Verdict:** Claude Opus 7.2x faster, only viable option for code analysis.

### Specification Generation (Complex Task)
- **Claude Opus 4.8:** 35.9s, 22,190→825 tokens, $0.51 ✓
- GPT/Gemini: Failures, auth issues ✗

**Verdict:** Only Claude works reliably on this EC2 instance.

## Skill Tier Mapping

### Opus (Heavy Reasoning)
Complex analysis, multi-step reasoning, high-stakes decisions. Cost: high.

**Skills:**
- `review` — code review, PR analysis
- `qa` — QA testing, browser interaction + decisions
- `investigate` — systematic debugging
- `spec` — specification generation
- `ship` — deployment decisions
- `design-review` — visual + design analysis
- `plan-ceo-review`, `plan-eng-review`, `plan-design-review` — strategic planning
- `autoplan` — cross-phase synthesis

**Ops Commands:**
- `ops-fires` — production incident triage
- `ops-triage` — cross-platform issue analysis
- `ops-go` — strategic morning briefing

### Sonnet (Balanced Reasoning)
Straightforward decision-making, status aggregation, routing logic. Cost: medium.

**Skills:**
- `land-and-deploy` — merge + deploy workflow
- `canary` — post-deploy monitoring
- `health` — project health checks
- `cso` — chief security officer mode

**Ops Commands:**
- `ops-deploy` — deployment status
- `ops-monitor` — health checks
- `ops-comms` — message composition

### Haiku (Fast/Lightweight)
Navigation, extraction, simple formatting. Cost: low.

**Skills:**
- `browse` — headless browser navigation
- `scrape` — content extraction
- `setup-browser-cookies` — credential setup
- `context-save` / `context-restore` — session management
- `skillify` — skill discovery

## Provider Fallback

Current EC2 environment: **Claude only** (GPT/Gemini auth broken).

Future installations: Add fallback to Claude (no other providers reliable as of 2026-06-06).

```json
"provider_priority": ["claude"]
```

## Configuration

See `config/model-strategy.json` for the complete mapping and rationale per skill/command.

### Loading the Strategy

On `claude-ops` installation/update, load the model strategy:

```bash
if [ -f ~/.claude/config/model-strategy.json ]; then
  # Use it for skill dispatch
  source ~/.claude/scripts/lib/model-dispatch.sh
fi
```

### Overriding Per-Skill

Individual skills can override the default tier if benchmarks show better results:

```json
"skill_overrides": {
  "my-skill": {
    "model": "claude-haiku-4-5",
    "reason": "Simple logic, fast response needed"
  }
}
```

## Maintenance

Rerun benchmarks quarterly to detect:
- New model releases and performance changes
- Provider auth/reliability shifts
- Cost changes due to tier pricing

Update `model-strategy.json` and re-deploy.

## References

- **Benchmark results:** `~/.gstack/benchmarks/20260606-*.json`
- **Live config:** `~/.gstack/model-config.json`
- **CLAUDE.md:** `~/.claude/CLAUDE.md` (MODEL STRATEGY section)
