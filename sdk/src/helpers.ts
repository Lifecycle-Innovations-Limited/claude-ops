/**
 * Parses YAML frontmatter from a SKILL.md or agent .md string.
 * Returns the frontmatter as a plain object and the body as a string.
 * Does NOT require a yaml library — uses a minimal key:value parser
 * sufficient for the flat frontmatter schema used in claude-ops.
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const [, yaml, body] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    // Parse arrays: [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      frontmatter[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (raw === 'true') {
      frontmatter[key] = true;
    } else if (raw === 'false') {
      frontmatter[key] = false;
    } else if (!isNaN(Number(raw)) && raw !== '') {
      frontmatter[key] = Number(raw);
    } else {
      frontmatter[key] = raw.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body: body.trim() };
}

/** Serializes a frontmatter object back to YAML frontmatter string */
export function serializeSkillFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(String).join(', ')}]`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---', '', body);
  return lines.join('\n');
}
