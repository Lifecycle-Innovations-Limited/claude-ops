---
name: infra-monitor
description: ECS, Vercel, and AWS health checker. Returns structured JSON with service health, recent deployments, and anomaly flags. Used by ops-fires and ops-deploy.
model: claude-sonnet-4-5
effort: low
maxTurns: 15
tools:
  - Bash
  - Read
  - mcp__claude_ai_Vercel__list_projects
  - mcp__claude_ai_Vercel__list_deployments
  - mcp__claude_ai_Vercel__get_deployment
  - mcp__claude_ai_Vercel__get_runtime_logs
disallowedTools:
  - Write
  - Edit
  - Agent
---

# INFRA MONITOR AGENT

Scan all infrastructure and return structured health data. Read-only.

## Task

Run all checks in parallel:

### ECS health
```bash
for cluster in $(aws ecs list-clusters --output json 2>/dev/null | jq -r '.clusterArns[]'); do
  name=$(basename "$cluster")
  aws ecs describe-clusters --clusters "$name" \
    --include STATISTICS \
    --output json 2>/dev/null | \
    jq --arg c "$name" '{cluster: $c, services: .clusters[0].statistics, status: .clusters[0].status}'
  
  aws ecs list-services --cluster "$name" --output json 2>/dev/null | \
    jq -r '.serviceArns[]' | while read svc; do
    aws ecs describe-services --cluster "$name" --services "$(basename $svc)" \
      --output json 2>/dev/null | \
      jq '.services[] | {name: .serviceName, desired: .desiredCount, running: .runningCount, pending: .pendingCount, status: .status, rolloutState: (.deployments[0].rolloutState // "STABLE"), lastEvent: (.events[0].message // "none")}'
  done
done
```

### Recent ECS events (anomalies)
```bash
aws ecs describe-services \
  --cluster healify-prod \
  --services healify-api \
  --output json 2>/dev/null | \
  jq '.services[].events[:5]' 2>/dev/null || echo '[]'
```

### Vercel deployments
Fetch via `mcp__claude_ai_Vercel__list_projects`, then for each project call `mcp__claude_ai_Vercel__list_deployments` with limit 3.

### GitHub Actions (recent runs)
```bash
for repo in Lifecycle-Innovations-Limited/healify Lifecycle-Innovations-Limited/healify-api Lifecycle-Innovations-Limited/healify-langgraphs; do
  gh run list --repo "$repo" --limit 3 \
    --json status,conclusion,name,headBranch,createdAt 2>/dev/null | \
    jq --arg r "$repo" 'map(. + {repo: $r})'
done | jq -s 'add // []'
```

## Output format

```json
{
  "timestamp": "[ISO8601]",
  "overall_health": "healthy|degraded|critical",
  "ecs": {
    "clusters": [
      {
        "name": "[cluster]",
        "services": [
          {
            "name": "[service]",
            "desired": 0,
            "running": 0,
            "pending": 0,
            "status": "ACTIVE|INACTIVE",
            "health": "healthy|degraded|stopped",
            "last_event": "[text]"
          }
        ]
      }
    ]
  },
  "vercel": {
    "projects": [
      {
        "name": "[project]",
        "latest_deployment": {
          "id": "[id]",
          "state": "READY|ERROR|BUILDING",
          "url": "[url]",
          "created_at": "[ISO8601]"
        }
      }
    ]
  },
  "ci": {
    "recent_runs": []
  },
  "fires": [
    {
      "severity": "critical|high|medium",
      "service": "[name]",
      "issue": "[description]",
      "since": "[ISO8601]"
    }
  ]
}
```

## Fire detection rules

Flag as `critical` if:
- ECS service running < desired AND running == 0
- Vercel deployment state == "ERROR" on production
- CI conclusion == "failure" on `main` or `dev` branch

Flag as `high` if:
- ECS service running < desired (partial)
- Vercel deployment state == "ERROR" on preview
- CI failure on feature branch with open PR

Print only the JSON to stdout.
