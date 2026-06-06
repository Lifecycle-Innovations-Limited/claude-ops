# Model Strategy — Balanced Claude Tiers

**Date:** 2026-06-06  
**Rationale:** Balanced speed/cost/quality optimization via benchmarking across skills and /ops commands

## Overview

Recommended model assignment strategy for all gstack skills and /ops commands:

- **Claude Opus 4.8** — Heavy reasoning, complex analysis, high-stakes decisions
- **Claude Sonnet 4.6** — Balanced reasoning, decision-making, synthesis
- **Claude Haiku 4.5** — Fast, lightweight tasks, navigation, simple extraction

## Benchmark Data

### Code Review
- **Claude Opus 4.8:** 14.7s, 1144 tokens, $0.15 ✓
- **Gemini 2.5 Pro:** 105.8s timeout ✗
- **GPT 5.4:** Auth broken ✗

**Verdict:** Claude Opus **7.2x faster**.

## Skill Tier Mapping

### Opus (Heavy Reasoning)
`review`, `qa`, `investigate`, `spec`, `ship`, `design-review`, `plan-ceo-review`, `plan-eng-review`, `autoplan`, `ops-fires`, `ops-triage`, `ops-go`

### Sonnet (Balanced)
`land-and-deploy`, `canary`, `health`, `cso`, `ops-deploy`, `ops-monitor`, `ops-comms`

### Haiku (Fast/Lightweight)
`browse`, `scrape`, `setup-browser-cookies`, `context-save`, `context-restore`, `skillify`

See `config/model-strategy.json` for full mapping and rationale.
