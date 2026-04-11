# Phase 1: Plugin Scaffold + Registry + bin/ Scripts - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Establish the publishable Claude Code plugin directory structure with all data-gathering shell scripts. The `ops-gather` master script runs all sub-scripts in parallel and outputs complete JSON in <10s.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and Claude Code plugin reference docs to guide decisions.

Key constraints from research:
- Plugin structure: .claude-plugin/plugin.json at root, skills/ agents/ hooks/ bin/ at root level
- bin/ scripts added to PATH automatically — callable as bare commands
- registry.json is the single config file users edit
- Shell scripts output JSON for consumption by `!`command`` in skills
- Sam's project registry data available from the /go morning briefing analysis

</decisions>

<code_context>
## Existing Code Insights

### Plugin System
- Plugin manifest: .claude-plugin/plugin.json (name, version, description, author, userConfig)
- Skills: skills/<name>/SKILL.md with YAML frontmatter
- Agents: agents/<name>.md with YAML frontmatter
- bin/: executables added to Bash tool PATH
- hooks/hooks.json for lifecycle events
- output-styles/ for consistent formatting

### Available CLIs
- wacli: WhatsApp (auth, chats, contacts, messages, groups, send)
- gog v0.12.0: Google (gmail, calendar, tasks, contacts, drive, docs, sheets)
- sentry-cli 3.1.0: Sentry error tracking
- gh 2.89.0: GitHub
- aws-cli 2.34.24: AWS
- doppler v3.75.3: Secrets

### Sam's Project Registry (from /go analysis)
19 projects across Lifecycle-Innovations-Limited and auroracapital orgs.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
