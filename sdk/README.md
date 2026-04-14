# @claude-ops/sdk

SDK and scaffolder for building [claude-ops](https://github.com/Lifecycle-Innovations-Limited/claude-ops) skills and agents.

## Overview

The `@claude-ops/sdk` package provides:

- **TypeScript types** — `SkillManifest`, `AgentManifest`, `PluginManifest`, `HooksConfig` interfaces for type-safe skill authoring
- **Runtime validators** — `isValidSkillManifest`, `isValidAgentManifest` for runtime validation
- **Helpers** — `parseSkillFrontmatter`, `serializeSkillFrontmatter` utilities
- **CLI scaffolder** — `create-ops-skill` generates a new skill or agent from templates

## Installation

**For types only** (in your skill's TypeScript project):

```bash
npm install @claude-ops/sdk
```

**For scaffolding** (no install needed):

```bash
npx create-ops-skill my-skill
npx create-ops-skill my-skill --agent
```

## Quick Start

```bash
# 1. Scaffold a new skill
npx create-ops-skill my-skill

# 2. Edit the generated SKILL.md
open skills/my-skill/SKILL.md

# 3. Register in the ops router
# Add routing in skills/ops/SKILL.md

# 4. Run the lint test
bash tests/test-skills-lint.sh
```

## `create-ops-skill` CLI

```
create-ops-skill — Scaffold a new claude-ops skill

Usage:
  npx create-ops-skill <skill-name> [options]

Options:
  --agent, -a   Also create an agent .md file for this skill
  --help, -h    Show this help

Examples:
  npx create-ops-skill my-skill
  npx create-ops-skill my-skill --agent
```

- Skill name is lowercased and sanitized (`[^a-z0-9-]` → `-`)
- Creates `skills/<name>/SKILL.md` from the built-in template
- With `--agent`: also creates `agents/<name>-agent.md`
- Fails with an error if `skills/<name>/` already exists

## Type Reference

### `SkillManifest`

Frontmatter schema for `SKILL.md` files:

```typescript
interface SkillManifest {
  name: string;                    // Skill name → slash command routing
  description: string;             // Shown in /help and marketplace
  'argument-hint'?: string;        // e.g., "[--watch] [--setup]"
  'allowed-tools': ToolName[];     // Claude Code tools this skill may use
  effort?: EffortLevel;            // 'low' | 'medium' | 'high'
  maxTurns?: number;               // Max agentic turns before auto-exit
  model?: string;                  // Model override (inherits from settings if omitted)
  memory?: MemoryScope;            // 'project' | 'global' | 'none'
  disallowedTools?: ToolName[];    // Tools explicitly blocked
  isolation?: IsolationMode;       // 'worktree' | 'none'
}
```

### `AgentManifest`

Frontmatter schema for agent `.md` files in `agents/`:

```typescript
interface AgentManifest {
  name: string;                    // Agent name — referenced by Agent tool calls
  description: string;             // What the agent does
  model?: string;                  // Defaults to claude-sonnet-4-6
  effort?: EffortLevel;
  maxTurns?: number;
  tools?: ToolName[];
  disallowedTools?: ToolName[];
  memory?: MemoryScope;
  initialPrompt?: string;          // Injected as first user message
}
```

### `PluginManifest`

Schema for `.claude-plugin/plugin.json`:

```typescript
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  userConfig?: Record<string, UserConfigField>;
}
```

### `HooksConfig`

Schema for hooks configuration in Claude Code settings:

```typescript
interface HooksConfig {
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  UserPromptSubmit?: HookEntry[];
  Stop?: HookEntry[];
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number;
  }>;
}
```

## Helper Functions

### `parseSkillFrontmatter(content: string)`

Parses YAML frontmatter from a `SKILL.md` string. Does not require a YAML library — uses a minimal parser sufficient for the flat frontmatter schema used in claude-ops.

```typescript
import { parseSkillFrontmatter } from '@claude-ops/sdk';

const content = `---
name: my-skill
description: Does something.
allowed-tools: [Bash, Read]
---

# My Skill body here.
`;

const { frontmatter, body } = parseSkillFrontmatter(content);
// frontmatter: { name: 'my-skill', description: 'Does something.', 'allowed-tools': ['Bash', 'Read'] }
// body: '# My Skill body here.'
```

### `isValidSkillManifest(obj: unknown): obj is SkillManifest`

Runtime validator — checks that an object has the required fields for a valid skill manifest.

```typescript
import { parseSkillFrontmatter, isValidSkillManifest } from '@claude-ops/sdk';

const { frontmatter } = parseSkillFrontmatter(content);
if (!isValidSkillManifest(frontmatter)) {
  throw new Error('Invalid SKILL.md: missing name, description, or allowed-tools');
}
// frontmatter is now typed as SkillManifest
```

### `isValidAgentManifest(obj: unknown): obj is AgentManifest`

Same for agent manifests — checks for `name` and `description` fields.

## Plugin Rules Summary

All claude-ops skills must follow these rules (enforced by `CLAUDE.md`):

| Rule | Requirement |
|------|-------------|
| **Rule 0** | Public repo — no real credentials, names, or URLs in committed files |
| **Rule 1** | Max 4 options per `AskUserQuestion` call (schema hard limit) |
| **Rule 2** | Never delegate CLI commands to the user — run via Bash tool instead |
| **Rule 3** | Never auto-skip setup steps — always offer `[Skip]` explicitly |
| **Rule 4** | Background-by-default during setup flows (`run_in_background: true`) |
| **Rule 5** | Destructive actions require per-action confirmation via `AskUserQuestion` |

## Contributing

1. Fork `Lifecycle-Innovations-Limited/claude-ops`
2. Create a feature branch: `git checkout -b feat/my-skill`
3. Scaffold your skill: `npx create-ops-skill my-skill`
4. Add logic, run `bash tests/test-skills-lint.sh`
5. Open a PR to `main`

## License

MIT © Lifecycle Innovations Limited
