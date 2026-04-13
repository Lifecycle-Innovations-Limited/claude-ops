---
created: 2026-04-13T14:42:00.000Z
title: Auto-maintained user profile second brain
area: tooling
files:
  - claude-ops/skills/setup/SKILL.md
  - claude-ops/skills/ops-go/SKILL.md
  - claude-ops/skills/ops-next/SKILL.md
  - claude-ops/skills/ops-orchestrate/SKILL.md
---

## Problem

The plugin has no persistent understanding of the user. Every session starts cold — agents don't know the user's role, preferences, expertise, communication style, project priorities, or accumulated knowledge. This means:
- Briefings can't be tailored (senior dev vs junior, technical vs business focus)
- Comms drafts don't match the user's voice/tone
- Priority rankings don't reflect personal weighting
- Agents repeat mistakes the user already corrected

Claude Code has auto-memory in `~/.claude/projects/*/memory/`, but that's per-conversation and not structured for ops agents to consume.

## Solution

### 1. `profile.md` — auto-maintained user profile

Location: `$PREFS_DIR/profile.md` (alongside preferences.json)

Structure:
```markdown
---
updated: 2026-04-13T14:42:00Z
confidence: 0.7
---

## Identity
- Role: [inferred from usage patterns]
- Expertise: [languages, frameworks, domains]
- Timezone: [from preferences]
- Communication style: [terse/detailed, emoji/no-emoji]

## Preferences
- PR style: [squash vs merge, bundled vs split]
- Code review focus: [security-first, perf-first, readability-first]
- Briefing verbosity: [from preferences]
- Autonomy level: [high/medium/low — how much confirmation they want]

## Knowledge Graph
- Projects: [which ones they work on most, expertise per project]
- Technologies: [strong in X, learning Y, avoids Z]
- People: [who they communicate with, relationship context]
- Patterns: [recurring decisions, preferences for libs/tools]

## Corrections
- [date]: "Don't mock the DB in tests" — reason: prior prod incident
- [date]: "Always use squash merge to dev" — reason: clean history
- [date]: "Skip Slack for urgent — use WhatsApp" — reason: faster response

## Session History
- [date]: worked on healify auth, merged 3 PRs, fixed Sentry P0
- [date]: inbox zero across all channels, deployed healify-api v2.1
```

### 2. Background profile updater

A hook or post-session process that:
- Observes what the user does (files touched, commands run, corrections given)
- Extracts preferences from feedback ("don't do X", "yes exactly like that")
- Updates profile.md with new observations + confidence scores
- Never overwrites — appends and adjusts confidence

### 3. Agent integration

All ops agents/skills read `profile.md` at start:
- `ops-go`: tailor briefing depth to user's expertise level
- `ops-comms`: match user's communication tone when drafting replies
- `ops-next`: weight priorities by user's project focus history
- `ops-orchestrate`: know which repos the user cares most about
- `ops-inbox`: know which contacts are high-priority

### 4. Implementation approach

- Add `bin/ops-profile-update` script that reads session context and updates profile
- Add profile reading to SKILL.md preambles: `cat $PREFS_DIR/profile.md 2>/dev/null`
- Use continuous-learning hooks to feed observations into profile
- Expose via `/ops:profile` skill to view/edit manually
