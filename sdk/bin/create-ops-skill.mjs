#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: 'boolean', short: 'a', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(`
create-ops-skill — Scaffold a new claude-ops skill

Usage:
  npx create-ops-skill <skill-name> [options]

Options:
  --agent, -a   Also create an agent .md file for this skill
  --help, -h    Show this help

Examples:
  npx create-ops-skill my-skill
  npx create-ops-skill my-skill --agent
`);
  process.exit(0);
}

const skillName = positionals[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
const skillDir = join(process.cwd(), 'skills', skillName);
const agentsDir = join(process.cwd(), 'agents');

// Read templates
const skillTemplate = readFileSync(
  join(__dirname, '../templates/skill/SKILL.md.template'),
  'utf8',
);
const agentTemplate = values.agent
  ? readFileSync(join(__dirname, '../templates/agent/AGENT.md.template'), 'utf8')
  : null;

// Interpolate
function interpolate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v),
    template,
  );
}

const skillContent = interpolate(skillTemplate, { SKILL_NAME: skillName });
const agentContent = agentTemplate
  ? interpolate(agentTemplate, { SKILL_NAME: skillName })
  : null;

// Write skill
if (existsSync(skillDir)) {
  console.error(`Error: skills/${skillName}/ already exists`);
  process.exit(1);
}
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), skillContent);
console.log(`✅ Created skills/${skillName}/SKILL.md`);

// Write agent
if (agentContent) {
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
  const agentFile = join(agentsDir, `${skillName}-agent.md`);
  writeFileSync(agentFile, agentContent);
  console.log(`✅ Created agents/${skillName}-agent.md`);
}

console.log(`
Next steps:
  1. Edit skills/${skillName}/SKILL.md — add your skill logic
  2. Register the skill in skills/ops/SKILL.md router
  3. Run: bash tests/test-skills-lint.sh
`);
