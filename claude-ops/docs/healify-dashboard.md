# Healify Dashboard

`ops-healify-dash` is a dedicated Healify.ai command center for terminal and tmux workflows. It is read-only by default and designed for dark terminals with an orange Healify.ai brand treatment.

## Commands

```bash
ops-healify-dash --once
ops-healify-dash --watch
ops-healify-dash --refresh
ops-healify-dash --json
ops-healify-bi-refresh
```

`--refresh` refreshes bounded local caches first. `--watch` rerenders on an interval. Neither mode changes tmux focus or selects another window.

`ops-dash` can explicitly delegate to this surface:

```bash
OPS_HEALIFY_DASH=1 ops-dash
```

## Data Sources

The dashboard aggregates only local, already-configured sources:

- `ops:projects` cache: `$OPS_DATA_DIR/cache/projects_health.json`
- statusline KPI cache: `~/.claude/state/statusline-kpi.json`
- live endpoint health cache: `~/.cache/agent-hub/infra-health.json`
- AWS ECS health cache: `~/.cache/agent-hub/aws-ecs-health.json`
- plugin inventory: `~/.cache/agent-hub/plugin-inventory.json`
- Healify BI cache: `~/.cache/agent-hub/healify-bi.json`
- runtime health: `~/.cache/agent-hub/fleet/runtime-health.txt`
- local Healify git repos under `~/Projects/healify-workspace`
- important ops and agent-hub logs

`ops-healify-bi-refresh` warms the BI cache from authenticated local and ops-dashboard sources when available:

- EAS latest iOS builds
- App Store Connect app versions, build numbers, processing state, and reviews
- App Store Connect sales/download status, clearly marked blocked when the vendor number is missing
- AppsFlyer installs, organic split, loyal users, and cost
- Amplitude active/new-user status
- Sentry unresolved issue counts by Healify project
- BetterStack uptime/incidents
- Linear priority issue counts
- mobile QA and Pact/contract health from the operating dashboard integration source

It shows business KPIs, acquisition and marketing state, App Store/TestFlight release state, reviews, project execution state, service health, ECS deployment status, repo drift, agent/MCP/CLI readiness, plugin coverage, and recent important logs.

## Branding

The 1:1 pixel icon lives at:

```text
assets/healify-pixel-logo.svg
```

It follows the current Healify.ai app-icon direction: orange/pink rounded square, high contrast, and a white heart/pill health mark. The terminal dashboard renders the same concept as ANSI pixel blocks.

## Tmux Integration

Any tmux binding should open this dashboard only through explicit user action, for example:

```tmux
bind v display-popup -E -w 96% -h 92% "ops-healify-dash --watch"
```

Background watchdogs, prewarmers, doctors, and repair hooks must not call `select-window` or `switch-client`. While a user is working in a window, focus should remain there unless the user explicitly presses a navigation key.
