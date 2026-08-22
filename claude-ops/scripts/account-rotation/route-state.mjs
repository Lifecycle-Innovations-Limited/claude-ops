import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, hostname } from 'os';

/**
 * Claude routing state.
 *
 * Two modes:
 *   oauth       — Claude Code's own OAuth credential. settings.json carries no
 *                 base URL and no injected API key.
 *   fail-closed — OAuth is unavailable and Bedrock has not been confirmed, so
 *                 the PreToolUse guard blocks rather than spending on Bedrock.
 *
 * `crs-oauth` and `proxy-oauth` are read as aliases of `oauth` so an existing
 * ~/.claude/claude-routing-state.json keeps resolving after the relay removal.
 *
 * Multi-account rotation and OAuth seat management live in CLIProxyAPI. Nothing
 * here injects pool credentials into settings.json any more.
 */
export const ROUTE_MODES = new Set(['oauth', 'fail-closed']);

const LEGACY_ROUTE_MODES = new Map([
  ['crs-oauth', 'oauth'],
  ['proxy-oauth', 'oauth'],
]);

/** Map a stored or user-supplied mode onto a current one. */
export function normalizeRouteMode(mode) {
  const raw = String(mode || '');
  return LEGACY_ROUTE_MODES.get(raw) || raw;
}

// A retired relay answered on one of these ports and issued `cr_` bearer
// tokens. Both are scrubbed from any settings this module writes.
// A relay reachable somewhere else (a tailnet address, say) can be named in
// OPS_RELAY_HOSTS as a comma-separated host:port list; nothing site-specific
// is hardcoded here.
const LEGACY_RELAY_PORT_RE = /:(3000|3002|3005|8091|18091)(\/|$)/;
const EXTRA_RELAY_HOSTS = (process.env.OPS_RELAY_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export function isLegacyRelayBase(baseUrl) {
  if (!baseUrl) return false;
  const value = String(baseUrl);
  if (LEGACY_RELAY_PORT_RE.test(value)) return true;
  return EXTRA_RELAY_HOSTS.some((host) => value.includes(host));
}

export function isLegacyRelayToken(token) {
  return String(token || '').startsWith('cr_');
}

/** True when settings.env still carries credentials for the removed relay. */
export function hasLegacyRelayEnv(env = {}) {
  const e = env && typeof env === 'object' ? env : {};
  return (
    isLegacyRelayBase(e.ANTHROPIC_BASE_URL) ||
    isLegacyRelayBase(e.ANTHROPIC_API_BASE) ||
    isLegacyRelayToken(e.ANTHROPIC_API_KEY) ||
    isLegacyRelayToken(e.ANTHROPIC_AUTH_TOKEN) ||
    isLegacyRelayToken(e.CLAUDE_CODE_OAUTH_TOKEN)
  );
}

/** Delete every relay leftover from an env map, in place. Returns the map. */
export function scrubLegacyRelayEnv(env = {}) {
  const e = env && typeof env === 'object' ? env : {};
  if (isLegacyRelayBase(e.ANTHROPIC_BASE_URL)) delete e.ANTHROPIC_BASE_URL;
  if (isLegacyRelayBase(e.ANTHROPIC_API_BASE)) delete e.ANTHROPIC_API_BASE;
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (isLegacyRelayToken(e[key])) delete e[key];
  }
  return e;
}

const STATE_PATH = join(homedir(), '.claude', 'claude-routing-state.json');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
];

const BEDROCK_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_BEDROCK_REGION'];

const ANTHROPIC_DIRECT_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readSettingsForUpdate() {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`refusing settings update: cannot read valid JSON at ${SETTINGS_PATH}: ${error.message}`);
  }
  const hooks = settings?.hooks;
  let commands = 0;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
        commands += group.hooks.filter(
          (entry) => entry && typeof entry.command === 'string' && entry.command.trim(),
        ).length;
      }
    }
  }
  if (commands === 0) {
    throw new Error(`refusing settings update: hooks are missing or empty at ${SETTINGS_PATH}`);
  }
  return settings;
}

function writeJsonAtomic(path, data, defaultMode = null) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  let mode = defaultMode;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function readRouteState() {
  const state = readJson(STATE_PATH, null);
  const mode = normalizeRouteMode(state?.mode);
  if (!state || !ROUTE_MODES.has(mode)) {
    return {
      mode: 'oauth',
      updatedAt: nowIso(),
      updatedBy: 'default',
      reason: 'default',
      bedrockConfirmation: null,
      host: hostname(),
    };
  }
  const { crs, ...rest } = state;
  void crs; // a retired relay block may still be on disk; it is not read
  return { ...rest, mode };
}

export function writeRouteState(next) {
  const prev = readRouteState();
  const merged = {
    ...prev,
    ...next,
    mode: normalizeRouteMode(next?.mode ?? prev.mode),
    updatedAt: nowIso(),
    host: hostname(),
  };
  delete merged.crs;
  if (!ROUTE_MODES.has(merged.mode)) {
    throw new Error(`invalid route mode: ${merged.mode}`);
  }
  writeJsonAtomic(STATE_PATH, merged);
  return merged;
}

export function bedrockConfirmationActive(state = readRouteState(), at = Date.now()) {
  const confirmation = state.bedrockConfirmation;
  if (!confirmation?.confirmedAt || !confirmation?.expiresAt) return false;
  return Date.parse(confirmation.expiresAt) > at;
}

export function setRouteMode(mode, options = {}) {
  const resolved = normalizeRouteMode(mode);
  if (!ROUTE_MODES.has(resolved)) throw new Error(`invalid route mode: ${mode}`);
  const next = {
    mode: resolved,
    reason: options.reason || 'manual',
    updatedBy: options.updatedBy || process.env.USER || 'unknown',
    bedrockConfirmation: null,
  };
  const state = writeRouteState(next);
  applyRouteToSettings(state, options);
  return state;
}

/**
 * Reconcile ~/.claude/settings.json with the route state.
 *
 * Both modes produce the same env: no Bedrock, no injected base URL, no
 * injected API key. Claude Code uses its own OAuth credential. The difference
 * between them is what the PreToolUse guard does, not what settings contain.
 * This is also the migration step that clears a leftover relay pair.
 */
export function applyRouteToSettings(state = readRouteState(), options = {}) {
  void options;
  const settings = readSettingsForUpdate();
  const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  for (const key of [...MODEL_KEYS, ...ANTHROPIC_DIRECT_KEYS, ...BEDROCK_KEYS]) delete env[key];
  delete settings.model;
  delete settings.availableModels;
  void state;

  settings.env = env;
  writeJsonAtomic(SETTINGS_PATH, settings);
  return settings;
}

export function settingsRouteSnapshot() {
  const settings = readJson(SETTINGS_PATH, { env: {} });
  const env = settings.env || {};
  const base = String(env.ANTHROPIC_BASE_URL || '');
  const token = String(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || '');
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const legacyRelay = hasLegacyRelayEnv(env);
  return {
    settingsPath: SETTINGS_PATH,
    bedrock,
    baseUrl: base || null,
    tokenKind: isLegacyRelayToken(token) ? 'legacy-relay' : token ? 'other' : 'none',
    legacyRelay,
    mixedProvider: bedrock && (!!base || !!token),
    modelOverride: settings.model || null,
    availableModelsOverride: existsSync(SETTINGS_PATH) && Array.isArray(settings.availableModels),
  };
}

export function routeStatus() {
  const state = readRouteState();
  return {
    statePath: STATE_PATH,
    state,
    bedrockConfirmationActive: bedrockConfirmationActive(state),
    settings: settingsRouteSnapshot(),
  };
}
