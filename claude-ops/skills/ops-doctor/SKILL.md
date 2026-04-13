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
---

# OPS ► DOCTOR

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

## Phase 2 — Decision

If `$ARGUMENTS` contains `--check-only`: stop here, display results only.

If there are **errors or warnings**:

Display: "Found [N] issues. Spawning doctor agent to auto-fix..."

Then spawn the doctor agent:

```
Agent({
  subagent_type: "ops:doctor-agent",
  prompt: "Fix the following ops plugin issues.\n\nDIAGNOSTIC_JSON: [paste full JSON]\nPLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}\nCACHE_DIR: ~/.claude/plugins/cache/ops-marketplace/ops\n\nFix all errors and warnings. Re-run diagnostics after to verify.",
  description: "Fix ops plugin issues"
})
```

If there are **no errors and no warnings**:

Display: "All checks passed. Plugin is healthy."

## Phase 3 — Post-fix verification

After the agent completes, re-run diagnostics:

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-doctor 2>/dev/null
```

Display updated results. If errors remain, report them to the user with manual fix instructions.
