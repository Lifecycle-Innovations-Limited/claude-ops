---
name: ops-doctor
description: Health check and auto-repair for the ops plugin. Diagnoses manifest errors, broken permissions, invalid configs, stale caches, and missing files — then spawns an agent to fix everything automatically.
argument-hint: "[--check-only|--verbose]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
  - WebFetch
  - TeamCreate
  - SendMessage
effort: medium
maxTurns: 30
---

## Runtime Context

Before diagnosing, load:
1. **Preferences**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json` — check all configured channels and services
2. **Daemon health**: `cat ${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json` — primary diagnostic input
3. **Secrets**: Verify secret resolution chain works: Doppler MCP → env → Doppler CLI → password manager


# OPS ► DOCTOR

## CLI/API Reference

### ops-doctor bin script

| Command | Usage | Output |
|---------|-------|--------|
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-doctor` | Run full health diagnostics | JSON with `errors`, `warnings`, `tools`, `env_vars`, `registry` |
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-doctor 2>/dev/null \|\| echo '{"errors":["diagnostic_script_failed"]}'` | Run with fallback | JSON or error sentinel |

### Key files read by diagnostics

| File | Purpose |
|------|---------|
| `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json` | Primary daemon health input |
| `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` | Configured channels and services |
| `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` | Plugin manifest validation |
| `${CLAUDE_PLUGIN_ROOT}/scripts/registry.json` | Project registry validation |

---

## Phase 1 — Run diagnostics

Run the diagnostic script to get a full health report:

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-doctor 2>/dev/null || echo '{"errors":["diagnostic_script_failed"],"warnings":[]}'
```

Parse the JSON output. Display a summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DOCTOR — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Plugin:     [version] at [plugin_root]
 Skills:     [count] defined
 Agents:     [count] defined
 Bin scripts:[count] available

 ERRORS      [count]
 [list each error with description]

 WARNINGS    [count]
 [list each warning with description]

 TOOLS
 [table of CLI tool availability]

 ENV VARS
 [table of env var status]

 Registry:   [status] ([project_count] projects)
 Preferences:[status]
 Cache:      [versions list]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** when multiple independent fix categories are identified (e.g., manifest issues + permission issues + registry issues). This enables:
- Fix agents work in parallel on different issue categories without stepping on each other
- You can prioritize: "fix manifest errors first, then permissions"
- Agents share context so a manifest fix can inform the registry repair

**Team setup** (only when flag is enabled, multiple issue categories):
```
TeamCreate("doctor-fixers")
Agent(team_name="doctor-fixers", name="fix-manifest", subagent_type="ops:doctor-agent", ...)
Agent(team_name="doctor-fixers", name="fix-permissions", subagent_type="ops:doctor-agent", ...)
Agent(team_name="doctor-fixers", name="fix-registry", subagent_type="ops:doctor-agent", ...)
```

If the flag is NOT set or only one issue category exists, use a single `doctor-agent` subagent.

## Phase 2 — Decision

If `$ARGUMENTS` contains `--check-only`: stop here, display results only.

If there are **errors or warnings**:

Display: "Found [N] issues. Spawning doctor agent to auto-fix..."

Then spawn the doctor agent (or Agent Team — see above):

```
Agent({
  subagent_type: "ops:doctor-agent",
  prompt: "Fix the following ops plugin issues.\n\nDIAGNOSTIC_JSON: [paste full JSON]\nPLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}\nCACHE_DIR: ~/.claude/plugins/cache/ops-marketplace/ops\n\nFix all errors and warnings. Re-run diagnostics after to verify.",
  description: "Fix ops plugin issues"
})
```

If there are **no errors and no warnings**:

Display: "All checks passed. Plugin is healthy."

## MCP watchdog health probe

After Phase 1 diagnostics, parse the `5f` block warnings from `bin/ops-doctor`. The bin script emits these MCP-specific keys:

- `claude_json_invalid` — `~/.claude.json` is not valid JSON (hard error — all MCP tooling breaks)
- `claude_json_missing` — no `~/.claude.json` (warning — no servers configured)
- `mcp_stdio_cmd_missing_<name>` — stdio server `command` binary not on PATH
- `mcp_watchdog_stale` — watchdog health not updated in >1h (cron not running)
- `mcp_watchdog_no_health` — watchdog has never run (never registered)
- `mcp_servers_degraded_long` — one or more HTTP MCP servers degraded >1h

For each warning, surface a one-line fix hint:

| Warning | Fix hint |
|---------|----------|
| `claude_json_invalid` | `python3 -c "import json; json.load(open('$HOME/.claude.json'))"` to find the syntax error |
| `mcp_stdio_cmd_missing_<name>` | Verify the command path and install the missing binary; update `~/.claude.json` if path changed |
| `mcp_watchdog_stale` or `mcp_watchdog_no_health` | `/ops:mcp restart` to register crontab entries |
| `mcp_servers_degraded_long` | `/ops:mcp status` for full detail, then `/ops:mcp reauth <name>` for each `needs_bootstrap` |

Include these warnings in the doctor-agent prompt for auto-fix where applicable (e.g., crontab registration is safe to do automatically).

## Pocket health probe

After Phase 1 diagnostics, run the pocket probe if the `pocket` section is configured in preferences or if `--verbose` was passed. The bin script already includes these checks (section 5e); this section describes what the SKILL layer adds on top.

Parse the `pocket` block from the `bin/ops-doctor` JSON output. Surface any pocket-specific warnings:

- `pocket_health_stale_*` — health file exists but mtime > 5 minutes
- `pocket_health_missing_*` — health file does not exist
- `pocket_health_error_*` — health file has `"status": "error"`
- `pocket_tmux_missing` — `pocket-exec` tmux session not found
- `pocket_config_invalid_*` — whatsapp-config.json or email-config.json not valid JSON
- `pocket_email_auth` — `gog gmail status` not authenticated
- `pocket_bridge_port` — Baileys bridge port 8080 not listening

For each warning, surface a one-line fix hint:

| Warning | Fix hint |
|---------|----------|
| `pocket_health_stale_activity-notifier` | `launchctl kickstart -k gui/$UID/com.claude-ops.pocket-activity-notifier` |
| `pocket_health_missing_*` | `bash $CLAUDE_PLUGIN_ROOT/scripts/install-pocket-notifier.sh` |
| `pocket_health_error_*` | `tail -30 ~/.claude/state/pocket/activity-notifier.stderr.log` |
| `pocket_tmux_missing` | Executor not running — start with `python3 $CLAUDE_PLUGIN_ROOT/scripts/ops-cron-pocket-executor.py` |
| `pocket_config_invalid_whatsapp` | Re-run `/ops:setup pocket` to write a valid whatsapp-config.json |
| `pocket_config_invalid_email` | Re-run `/ops:setup pocket` to write a valid email-config.json |
| `pocket_email_auth` | `gog auth add <your-email> --services gmail` |
| `pocket_bridge_port` | `launchctl kickstart -k gui/$UID/com.samrenders.whatsapp-bridge` |

Include pocket warnings in the doctor-agent prompt so it can auto-fix where possible.
## Phase 3 — Post-fix verification

After the agent completes, re-run diagnostics:

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-doctor 2>/dev/null
```

Display updated results. If errors remain, report them to the user with manual fix instructions.

---

## Native tool usage

### WebSearch — known issue lookup

When diagnostics find errors, use `WebSearch` to check if the issue is a known Claude Code plugin bug, MCP server issue, or configuration problem. Include links to relevant GitHub issues or docs.

### WebFetch — MCP health check

For MCP servers that appear disconnected, use `WebFetch` to test their underlying APIs directly (e.g., `https://api.linear.app/graphql` with a simple query) to distinguish between "MCP broken" and "API down".
