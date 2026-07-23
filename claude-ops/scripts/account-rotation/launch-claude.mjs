#!/usr/bin/env node
import { loadClaudeHarnessEnv } from './claude-harness-env.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ADMISSION_GATE 2026-07-13
import { spawnSync as __admSpawnSync } from 'node:child_process';
function __admissionAllow(args) {
  if (process.env.ADMISSION_FORCE === '1') return;
  const cmd = args.find((a) => a && !String(a).startsWith('-')) || '';
  const control = new Set([
    'agents',
    'attach',
    'auth',
    'config',
    'daemon',
    'doctor',
    'help',
    'kill',
    'logs',
    'mcp',
    'plugin',
    'plugins',
    'rm',
    'respawn',
    'status',
    'stop',
    'update',
  ]);
  if (control.has(cmd)) return;
  try {
    __admSpawnSync('bash', [`${process.env.HOME}/.claude/scripts/admission-write.sh`], { stdio: 'ignore' });
  } catch {}
  const r = __admSpawnSync('bash', [`${process.env.HOME}/.claude/scripts/admission-gate.sh`], { encoding: 'utf8' });
  if (r.status === 3) {
    console.error('ADMISSION: over_ceiling — launch-claude.mjs refusing model spawn');
    process.exit(3);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, 'state.json');
const ROUTER_PATH = join(__dirname, 'session-router.mjs');
const home = process.env.HOME || '';
const CLAUDE_SETTINGS_PATH = join(home, '.claude', 'settings.json');
const REAL_CLAUDE_BIN = join(home, '.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const defaultCandidates =
  process.platform === 'win32'
    ? [
        process.env.CLAUDE_REAL_BIN,
        process.env.CLAUDE_BIN,
        join(home, '.npm-global/bin/claude.exe'),
        join(home, '.local/bin/claude'),
      ]
    : [
        process.env.CLAUDE_REAL_BIN,
        process.env.CLAUDE_BIN,
        REAL_CLAUDE_BIN,
        join(home, '.npm-global/bin/claude'),
        join(home, '.local/bin/claude'),
        '/usr/local/bin/claude',
        'claude',
      ];
const CLAUDE_BIN = (() => {
  for (const candidate of defaultCandidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
})();
const rawArgs = process.argv.slice(2);
__admissionAllow(rawArgs);

const CONTROL_SUBCOMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'config',
  'daemon',
  'doctor',
  'help',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'rm',
  'respawn',
  'status',
  'stop',
  'update',
]);

function firstCommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) return arg;
    if (
      [
        '--add-dir',
        '--agent',
        '--append-system-prompt',
        '--cwd',
        '--effort',
        '--model',
        '--name',
        '--output-format',
        '--permission-mode',
        '--resume',
        '--settings',
      ].includes(arg)
    ) {
      i += 1;
    }
  }
  return null;
}

function shouldBypassPermissions(args) {
  if (
    args.includes('--remote-control') ||
    args.includes('--version') ||
    args.includes('-v') ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    return false;
  }
  const cmd = firstCommand(args);
  if (cmd && CONTROL_SUBCOMMANDS.has(cmd)) return false;
  return true;
}

function withBypassPermissions(args) {
  if (!shouldBypassPermissions(args)) return args;
  const next = [...args];
  if (!next.includes('--dangerously-skip-permissions')) {
    next.push('--dangerously-skip-permissions');
  }
  if (!next.includes('--permission-mode')) {
    next.push('--permission-mode', 'bypassPermissions');
  }
  return next;
}

const args = withBypassPermissions(rawArgs);
const isModelLaunch = shouldBypassPermissions(rawArgs);
const settingsEnv = (() => {
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'))?.env || {};
  } catch {
    return {};
  }
})();
const baseEnv = { ...process.env, ...settingsEnv };
for (const key of [
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'CEREBRAS_API_KEY',
  'DEEPINFRA_API_KEY',
  'PERPLEXITY_API_KEY',
  'PPLX_API_KEY',
  'REPLICATE_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
]) {
  delete baseEnv[key];
}
delete baseEnv.CLAUDE_CODE_USE_BEDROCK;
delete baseEnv.ANTHROPIC_MODEL;

if (isModelLaunch) {
  let harnessEnv;
  try {
    harnessEnv = loadClaudeHarnessEnv({ home });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  Object.assign(baseEnv, harnessEnv);
  // Keep API_KEY=cr_ (derived from harness). Stripping it left BASE→CRS with no key.
  baseEnv.ANTHROPIC_API_KEY = baseEnv.ANTHROPIC_API_KEY || baseEnv.CRS_API_KEY || baseEnv.ANTHROPIC_AUTH_TOKEN;
} else {
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_BASE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CRS_API_KEY',
    'CRS_HARNESS_NAME',
  ]) {
    delete baseEnv[key];
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function fallback() {
  const result = spawnSync(CLAUDE_BIN, args, {
    env: baseEnv,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const config = readJson(CONFIG_PATH);
const state = readJson(STATE_PATH);
if (!config || !state) {
  fallback();
}

let spawnWithAccount;
try {
  ({ spawnWithAccount } = await import(ROUTER_PATH));
} catch (err) {
  console.error(`claude-rotate-launcher: failed to load session-router (${err.message})`);
  fallback();
}

if (typeof spawnWithAccount !== 'function') {
  fallback();
}

let session;
try {
  session = spawnWithAccount(args, config, state, { env: baseEnv, detached: false, stdio: 'inherit' });
} catch (err) {
  console.error(`claude-rotate-launcher: spawnWithAccount failed (${err.message})`);
  fallback();
}

const proc = session?.proc;
if (!proc || typeof proc.once !== 'function') {
  fallback();
}

proc.once('exit', (code) => {
  process.exit(code ?? 1);
});

proc.once('error', () => {
  fallback();
});
