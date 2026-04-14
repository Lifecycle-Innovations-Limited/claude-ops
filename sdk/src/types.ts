/** Effort levels for skills and agents */
export type EffortLevel = 'low' | 'medium' | 'high';

/** Tool names allowed in skill/agent tool lists */
export type ToolName =
  | 'Bash' | 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob'
  | 'Skill' | 'Agent' | 'AskUserQuestion' | 'WebSearch' | 'WebFetch'
  | 'TodoRead' | 'TodoWrite' | 'NotebookRead' | 'NotebookEdit'
  | 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet'
  | 'TeamCreate' | 'SendMessage' | 'Monitor'
  | (string & {}); // allow MCP tool names like "mcp__linear__..."

/** Memory scope for agents */
export type MemoryScope = 'project' | 'global' | 'none';

/** Isolation mode for agents */
export type IsolationMode = 'worktree' | 'none';

/**
 * Frontmatter schema for SKILL.md files.
 * All fields correspond to Claude Code plugin skill manifest specification.
 */
export interface SkillManifest {
  /** Skill name — used in slash command routing (e.g., "ops-monitor" → /ops:ops-monitor) */
  name: string;
  /** One-sentence description shown in /help and marketplace */
  description: string;
  /** Hint shown after the slash command (e.g., "[--watch] [--setup]") */
  'argument-hint'?: string;
  /** Tools this skill is allowed to use. Max: all Claude Code tools + MCP tools. */
  'allowed-tools': ToolName[];
  /** Effort level — controls default maxTurns if maxTurns not set */
  effort?: EffortLevel;
  /** Maximum number of agentic turns before the skill auto-exits */
  maxTurns?: number;
  /** Model override — if omitted, inherits from user's Claude Code settings */
  model?: string;
  /** Memory scope — 'project' reads/writes project memory, 'global' reads global memory */
  memory?: MemoryScope;
  /** Tools explicitly disallowed (overrides allowed-tools) */
  disallowedTools?: ToolName[];
  /** Isolation mode — 'worktree' creates an isolated git worktree for execution */
  isolation?: IsolationMode;
}

/**
 * Frontmatter schema for agent .md files in agents/.
 */
export interface AgentManifest {
  /** Agent name — referenced by Agent tool calls in skills */
  name: string;
  /** One-sentence description of what the agent does */
  description: string;
  /** Model to use — defaults to claude-sonnet-4-6 if not set */
  model?: string;
  /** Effort level */
  effort?: EffortLevel;
  /** Maximum agentic turns */
  maxTurns?: number;
  /** Tools this agent can use */
  tools?: ToolName[];
  /** Tools explicitly blocked */
  disallowedTools?: ToolName[];
  /** Memory scope */
  memory?: MemoryScope;
  /** Injected as the first user message before the agent body */
  initialPrompt?: string;
}

/** A single userConfig field definition in plugin.json */
export interface UserConfigField {
  title: string;
  description: string;
  type: 'string' | 'boolean' | 'number';
  sensitive: boolean;
  default: string | boolean | number;
}

/**
 * Schema for .claude-plugin/plugin.json
 */
export interface PluginManifest {
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

/**
 * Schema for .claude/hooks.json or settings.json hooks section
 */
export interface HooksConfig {
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  UserPromptSubmit?: HookEntry[];
  Stop?: HookEntry[];
}

export interface HookEntry {
  matcher?: string;
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number;
  }>;
}

/** Marketplace entry for .claude-plugin/marketplace.json */
export interface MarketplaceEntry {
  name: string;
  description: string;
  source: string;
  version: string;
  category: string;
  screenshots?: string[];
}
