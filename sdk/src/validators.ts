import type { SkillManifest, AgentManifest } from './types.js';

/** Returns true if the manifest has required fields for a valid SKILL.md */
export function isValidSkillManifest(obj: unknown): obj is SkillManifest {
  if (typeof obj !== 'object' || obj === null) return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.description === 'string' &&
    Array.isArray(m['allowed-tools'])
  );
}

/** Returns true if the manifest has required fields for a valid agent .md */
export function isValidAgentManifest(obj: unknown): obj is AgentManifest {
  if (typeof obj !== 'object' || obj === null) return false;
  const m = obj as Record<string, unknown>;
  return typeof m.name === 'string' && typeof m.description === 'string';
}
