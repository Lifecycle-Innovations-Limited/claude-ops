import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALLOWED_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CRS_API_KEY',
  'CRS_HARNESS_NAME',
]);
const REQUIRED_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CRS_API_KEY',
  'CRS_HARNESS_NAME',
]);
const ALLOWED_BASES = new Set(['http://127.0.0.1:3005/api', 'http://127.0.0.1:8091/api']);
const TOKEN_RE = /^cr_[A-Za-z0-9._~-]+$/;
const HARNESS_RE = /^[A-Za-z0-9._-]+$/;

function invalid() {
  return new Error('Claude CRS harness env validation failed');
}

export function claudeHarnessEnvPath(home = homedir()) {
  return join(home, '.claude', 'crs-keys', 'claude-cli.env');
}

export function loadClaudeHarnessEnv(options = {}) {
  const path = options.path || claudeHarnessEnvPath(options.home);
  let mode;
  let source;
  try {
    if (lstatSync(path).isSymbolicLink()) throw invalid();
    mode = statSync(path).mode & 0o777;
    source = readFileSync(path, 'utf8');
  } catch {
    throw invalid();
  }
  if (mode !== 0o600) throw invalid();

  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    const separator = rawLine.indexOf('=');
    if (separator <= 0) throw invalid();
    const name = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    if (!ALLOWED_KEYS.has(name) || Object.hasOwn(values, name)) throw invalid();
    values[name] = value;
  }
  if ([...REQUIRED_KEYS].some((name) => !Object.hasOwn(values, name))) {
    throw invalid();
  }
  // API_KEY optional in file; when present must match the harness cr_ key.
  if (Object.hasOwn(values, 'ANTHROPIC_API_KEY') && values.ANTHROPIC_API_KEY !== values.CRS_API_KEY) {
    throw invalid();
  }
  if (
    !ALLOWED_BASES.has(values.ANTHROPIC_BASE_URL) ||
    values.ANTHROPIC_API_BASE !== values.ANTHROPIC_BASE_URL ||
    !TOKEN_RE.test(values.ANTHROPIC_AUTH_TOKEN) ||
    values.CLAUDE_CODE_OAUTH_TOKEN !== values.ANTHROPIC_AUTH_TOKEN ||
    values.CRS_API_KEY !== values.ANTHROPIC_AUTH_TOKEN ||
    !HARNESS_RE.test(values.CRS_HARNESS_NAME)
  ) {
    throw invalid();
  }
  // Always surface API_KEY=cr_ so launch paths do not strip the only usable CRS credential.
  values.ANTHROPIC_API_KEY = values.CRS_API_KEY;
  return values;
}
