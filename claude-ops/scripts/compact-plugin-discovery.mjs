#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const skillsDir = path.join(pluginRoot, 'skills');
const agentsDir = path.join(pluginRoot, 'agents');
const indexPath = path.join(skillsDir, 'ops', 'references', 'capabilities.json');
const checkOnly = process.argv.includes('--check');

const SKILL_PREFIX = 'OPS on-demand: ';

// Read in one syscall: an existsSync/readFileSync pair is a time-of-check/
// time-of-use race if the file is removed between the two calls.
function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const AGENT_PREFIX = 'OPS specialist: ';

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function frontmatterDescription(content, file) {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error(`Missing frontmatter: ${file}`);
  const description = match[1].match(/^description:\s*(.+)$/m);
  if (!description) throw new Error(`Missing one-line description: ${file}`);
  return parseScalar(description[1]);
}

function frontmatterName(content, file) {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error(`Missing frontmatter: ${file}`);
  const name = match[1].match(/^name:\s*(.+)$/m);
  if (!name) throw new Error(`Missing name: ${file}`);
  return parseScalar(name[1]);
}

function replaceDescription(content, description) {
  return content.replace(/^description:.*$/m, `description: ${JSON.stringify(description)}`);
}

function firstClause(description, maxLength) {
  const normalized = description.replace(/\s+/g, ' ').trim();
  let clause = normalized.split(/\s+[—–]\s+|\.\s+|;\s+/u, 1)[0];
  if (clause.length <= maxLength) return clause.replace(/[.:;,]+$/, '');

  clause = clause.slice(0, maxLength + 1);
  const lastSpace = clause.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLength * 0.65)) clause = clause.slice(0, lastSpace);
  return `${clause.replace(/[.:;,]+$/, '')}…`;
}

function markdownFiles(directory, nestedSkillFiles = false) {
  if (nestedSkillFiles) {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, 'SKILL.md'))
      .filter((file) => fs.existsSync(file))
      .sort();
  }

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

const previousIndexRaw = readFileOrNull(indexPath);
const hasPreviousIndex = previousIndexRaw !== null;
const previousIndex = hasPreviousIndex ? JSON.parse(previousIndexRaw) : { skills: [], agents: [] };
const previousSkills = new Map(previousIndex.skills.map((entry) => [entry.name, entry.summary]));
const previousAgents = new Map(previousIndex.agents.map((entry) => [entry.name, entry.summary]));

const pendingWrites = new Map();
const missingSummaries = [];
const skillIndex = [];
for (const file of markdownFiles(skillsDir, true)) {
  const content = fs.readFileSync(file, 'utf8');
  const name = frontmatterName(content, file);
  const currentDescription = frontmatterDescription(content, file);
  const summary = currentDescription.startsWith(SKILL_PREFIX) ? previousSkills.get(name) : currentDescription;

  if (!summary) {
    missingSummaries.push(`skill ${name}`);
    continue;
  }
  skillIndex.push({ name, summary });

  if (name === 'ops') continue;
  const compactDescription = `${SKILL_PREFIX}${firstClause(summary, 88)}`;
  pendingWrites.set(file, replaceDescription(content, compactDescription));
}

const agentIndex = [];
for (const file of markdownFiles(agentsDir)) {
  const content = fs.readFileSync(file, 'utf8');
  const name = frontmatterName(content, file);
  const currentDescription = frontmatterDescription(content, file);
  const summary = currentDescription.startsWith(AGENT_PREFIX) ? previousAgents.get(name) : currentDescription;

  if (!summary) {
    missingSummaries.push(`agent ${name}`);
    continue;
  }
  agentIndex.push({ name, summary });

  const compactDescription = `${AGENT_PREFIX}${firstClause(summary, 84)}`;
  pendingWrites.set(file, replaceDescription(content, compactDescription));
}

if (missingSummaries.length > 0) {
  const relIndex = path.relative(pluginRoot, indexPath);
  console.error(
    hasPreviousIndex
      ? `Capability index ${relIndex} is missing entries for already-compacted descriptions:`
      : `Capability index ${relIndex} does not exist, and these descriptions are already compacted:`,
  );
  for (const entry of missingSummaries) console.error(`  ${entry}`);
  console.error(
    'The full text lives only in that index, so it cannot be rebuilt from the tree. ' +
      `Restore it with: git checkout -- ${relIndex}`,
  );
  process.exit(1);
}

const index = {
  version: 1,
  purpose: 'Full OPS capability descriptions loaded by the ops router only when needed.',
  skills: skillIndex,
  agents: agentIndex,
};
const expectedIndex = `${JSON.stringify(index, null, 2)}\n`;

if (checkOnly) {
  let failed = false;
  for (const [file, expected] of pendingWrites) {
    if (readFileOrNull(file) !== expected) {
      console.error(`Discovery metadata is not compact: ${path.relative(pluginRoot, file)}`);
      failed = true;
    }
  }
  if (readFileOrNull(indexPath) !== expectedIndex) {
    console.error(`Capability index is stale: ${path.relative(pluginRoot, indexPath)}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`Compact discovery verified: ${skillIndex.length} skills, ${agentIndex.length} agents`);
  process.exit(0);
}

for (const [file, expected] of pendingWrites) fs.writeFileSync(file, expected);
fs.mkdirSync(path.dirname(indexPath), { recursive: true });
fs.writeFileSync(indexPath, expectedIndex);
console.log(`Compacted discovery metadata for ${skillIndex.length} skills and ${agentIndex.length} agents`);
