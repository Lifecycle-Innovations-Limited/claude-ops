---
name: ops-deploy
description: Deploy status across all projects. Shows ECS service versions, Vercel deployments, recent deploys, pending deploys, and CI/CD pipeline state.
argument-hint: "[project-alias|ecs|vercel|all]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
  - mcp__claude_ai_Vercel__list_deployments
  - mcp__claude_ai_Vercel__list_projects
  - mcp__claude_ai_Vercel__get_deployment
  - mcp__claude_ai_Vercel__get_runtime_logs
  - mcp__claude_ai_Vercel__get_deployment_build_logs
---

# OPS ► DEPLOY STATUS

## Phase 1 — Gather deploy data in parallel

### ECS services (all clusters)
```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-infra 2>/dev/null || \
aws ecs list-clusters --output json 2>/dev/null
```

### ECS service details
```bash
for cluster in $(aws ecs list-clusters --output json 2>/dev/null | jq -r '.clusterArns[]'); do
  cluster_name=$(basename "$cluster")
  aws ecs list-services --cluster "$cluster_name" --output json 2>/dev/null | \
    jq -r '.serviceArns[]' | while read svc; do
    aws ecs describe-services --cluster "$cluster_name" --services "$svc" \
      --output json 2>/dev/null | jq '.services[] | {name: .serviceName, desired: .desiredCount, running: .runningCount, pending: .pendingCount, image: (.taskDefinition // "unknown"), status: .status}'
  done
done
```

### Recent GitHub Actions runs
```bash
for repo in Lifecycle-Innovations-Limited/healify Lifecycle-Innovations-Limited/healify-api Lifecycle-Innovations-Limited/healify-langgraphs; do
  echo "=== $repo ==="
  gh run list --repo "$repo" --limit 5 --json status,conclusion,name,headBranch,createdAt,databaseId 2>/dev/null
done
```

### Vercel deployments
Use `mcp__claude_ai_Vercel__list_projects` then `mcp__claude_ai_Vercel__list_deployments` for each project (limit 5 per project).

---

## Phase 2 — Render dashboard

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DEPLOY STATUS — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ECS SERVICES
 CLUSTER    SERVICE         D/R/P   STATUS   LAST DEPLOY
 ─────────────────────────────────────────────────────
 [cluster]  [service]       [x/x/x] ACTIVE   [time ago]
 ...

VERCEL DEPLOYMENTS
 PROJECT     ENV        STATUS    COMMIT    DEPLOYED
 ─────────────────────────────────────────────────────
 [project]   production  READY    [sha]     [time ago]
 ...

CI/CD PIPELINE
 REPO              BRANCH   WORKFLOW        STATUS    AGE
 ─────────────────────────────────────────────────────
 healify-api       main     Deploy API      ✓ success  2h
 healify           dev      Build iOS       ✗ failure  1h
 ...

PENDING DEPLOYS (branch ready, not yet deployed)
 [repo] [branch] [PR#] [CI status] → needs merge to trigger

──────────────────────────────────────────────────────
 Actions:
 a) View logs for [failing service]
 b) Trigger manual deploy for [project]
 c) View build logs for [failing CI run]
 d) Check Vercel [project] runtime logs
 e) Open GitHub Actions for [repo]

 → Type a letter, project alias, or describe
──────────────────────────────────────────────────────
```

---

## Deep-dive by project

If `$ARGUMENTS` has a project alias, show only that project's deploy info + last 10 CI runs + option to view logs.

For failing deploys: offer to view logs via `mcp__claude_ai_Vercel__get_deployment_build_logs` or ECS CloudWatch logs.

Use AskUserQuestion after the dashboard.
