# Phase 4: Project Management + Linear + Triage — Context

## Scope
Verify ops-projects, ops-linear, ops-triage, ops-fires, ops-deploy reference correct MCP tools.

## Verified Skills

### ops-projects
- References bin/ops-git, bin/ops-prs, bin/ops-ci via `!` injection
- Reads registry.json for GSD projects
- No external MCP needed (all CLI-based)

### ops-linear
- Uses mcp__claude_ai_Linear__* tools: list_teams, list_cycles, list_issues, save_issue, save_comment
- Sprint board, create, update, sync, backlog routing

### ops-triage
- Uses mcp__sentry__authenticate for Sentry access
- Uses mcp__claude_ai_Linear__list_issues, save_issue for Linear
- GitHub via gh CLI
- Auto-resolves confirmed-fixed issues

### ops-fires
- Uses mcp__sentry__authenticate
- Pre-gathers from bin/ops-infra, bin/ops-ci
- Severity classification: CRITICAL → HIGH → MEDIUM → LOW

### ops-deploy
- Uses mcp__claude_ai_Vercel__list_deployments, list_projects, get_deployment, get_runtime_logs
- ECS via AWS CLI + bin/ops-infra
- GitHub Actions via gh CLI
