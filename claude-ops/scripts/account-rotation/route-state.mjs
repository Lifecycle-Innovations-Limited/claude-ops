import { loadClaudeHarnessEnv } from './claude-harness-env.mjs';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { homedir, hostname } from 'os';

export const ROUTE_MODES = new Set(['crs-oauth', 'fail-closed']);

// CRS base⇄token desync guard (the safety net for every settings/overlay write).
// INVARIANT: ANTHROPIC_BASE_URL points at the CRS relay XNOR a cr_-prefixed
// relay key in ANTHROPIC_API_KEY. Auth-token fields are reserved for the
// launcher-created child environment and must not persist in settings.
const CRS_BASE_RE = /127\.0\.0\.1:(3000|3002|3005|8091|18091)|100\.87\.53\.96:8091|:(3000|3002|3005|8091|18091)\/api/;

function currentCrsToken(env = {}) {
  return isCrsToken(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : '';
}

export function isCrsBase(baseUrl) {
  return !!baseUrl && CRS_BASE_RE.test(String(baseUrl));
}

export function isCrsToken(token) {
  return String(token || '').startsWith('cr_');
}

export function assertCrsInvariant(env, where = 'crs-env') {
  const e = env && typeof env === 'object' ? env : {};
  const baseIsCrs = isCrsBase(e.ANTHROPIC_BASE_URL) || isCrsBase(e.ANTHROPIC_API_BASE);
  const tokIsCr = isCrsToken(currentCrsToken(e));
  if (baseIsCrs !== tokIsCr) {
    throw new Error(
      `[${where}] CRS base-token desync (fail-closed, refusing write): ` +
        `base=${baseIsCrs ? 'CRS' : 'non-CRS'} token=${tokIsCr ? 'cr_' : 'non-cr_'}. ` +
        'ANTHROPIC_BASE_URL and CRS token vars must be set together or not at all.',
    );
  }
  if (isCrsToken(e.ANTHROPIC_AUTH_TOKEN) || isCrsToken(e.CLAUDE_CODE_OAUTH_TOKEN)) {
    throw new Error(`[${where}] refusing to persist cr_ relay key in auth-token fields`);
  }
  return env;
}

const STATE_PATH = join(homedir(), '.claude', 'claude-routing-state.json');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CRS_SESSION_SETTINGS_PATH = join(homedir(), '.claude', 'crs-session-settings.json');
const CRKEY_PATH = join(homedir(), '.claude', 'scripts', 'account-rotation', '.crkey');
const FALLBACK_MARKER = join(homedir(), '.claude', 'scripts', 'account-rotation', 'crs-fallback-active');
const HEALTH_WATCH_STATE = join(homedir(), '.claude', 'scripts', 'account-rotation', 'crs-health-watch.state.json');

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

function readSettingsEnv() {
  return readJson(SETTINGS_PATH, { env: {} }).env || {};
}

function defaultCrsConfig() {
  const env = readSettingsEnv();
  const defaultBase = process.platform === 'darwin' ? 'http://127.0.0.1:8091/api' : 'http://127.0.0.1:3005/api';
  const inheritedBase = isCrsBase(env.ANTHROPIC_BASE_URL) ? env.ANTHROPIC_BASE_URL : null;
  const baseUrl = process.env.CRS_BASE_URL || inheritedBase || defaultBase;
  const healthUrl = process.env.CRS_HEALTH_URL || baseUrl.replace(/\/api\/?$/, '/health');
  return {
    baseUrl,
    healthUrl,
    authority: process.platform === 'darwin' ? 'mac-local-primary' : 'dev-us',
  };
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

function crKey() {
  try {
    return loadClaudeHarnessEnv().CRS_API_KEY;
  } catch {
    return '';
  }
}

export function readRouteState() {
  const state = readJson(STATE_PATH, null);
  if (!state || !ROUTE_MODES.has(state.mode)) {
    return {
      mode: 'crs-oauth',
      updatedAt: nowIso(),
      updatedBy: 'default',
      reason: 'default',
      bedrockConfirmation: null,
      crs: defaultCrsConfig(),
      host: hostname(),
    };
  }
  return state;
}

export function writeRouteState(next) {
  const prev = readRouteState();
  const merged = {
    ...prev,
    ...next,
    updatedAt: nowIso(),
    host: hostname(),
  };
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
  if (!ROUTE_MODES.has(mode)) throw new Error(`invalid route mode: ${mode}`);
  const reason = options.reason || 'manual';
  const ttlMinutes = Number.isFinite(options.ttlMinutes) ? options.ttlMinutes : 60;
  const next = {
    mode,
    reason,
    updatedBy: options.updatedBy || process.env.USER || 'unknown',
  };
  if (options.crs) next.crs = options.crs;
  next.bedrockConfirmation = null;
  const state = writeRouteState(next);
  applyRouteToSettings(state, options);
  return state;
}

export function applyRouteToSettings(state = readRouteState(), options = {}) {
  const settings = readSettingsForUpdate();
  const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  for (const key of [...MODEL_KEYS, ...ANTHROPIC_DIRECT_KEYS]) delete env[key];
  delete settings.model;
  delete settings.availableModels;

  if (state.mode === 'crs-oauth') {
    for (const key of BEDROCK_KEYS) delete env[key];
    env.AWS_REGION = env.AWS_REGION || process.env.AWS_REGION || 'us-east-1';
    const key = crKey();
    if (!key.startsWith('cr_')) {
      throw new Error(`CRS relay key missing or invalid at ${CRKEY_PATH}`);
    }
    env.ANTHROPIC_BASE_URL = state.crs?.baseUrl || defaultCrsConfig().baseUrl;
    env.ANTHROPIC_API_BASE = env.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_API_KEY = key;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    for (const key of BEDROCK_KEYS) delete env[key];
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  settings.env = env;
  assertCrsInvariant(env, `applyRouteToSettings:${state.mode}`);
  writeJsonAtomic(SETTINGS_PATH, settings);
  return settings;
}

export function assertCrsSessionInvariant(env, where = 'crs-session-env') {
  const e = env && typeof env === 'object' ? env : {};
  const baseUrl = String(e.ANTHROPIC_BASE_URL || '');
  const apiBase = String(e.ANTHROPIC_API_BASE || '');
  const authToken = String(e.ANTHROPIC_AUTH_TOKEN || '');
  const oauthToken = String(e.CLAUDE_CODE_OAUTH_TOKEN || '');
  if (
    !isCrsBase(baseUrl) ||
    baseUrl !== apiBase ||
    !isCrsToken(authToken) ||
    authToken !== oauthToken ||
    e.ANTHROPIC_API_KEY !== undefined
  ) {
    throw new Error(`[${where}] invalid CRS model-child auth contract; refusing settings write`);
  }
  return env;
}

export function applyCrsSessionSettings(options = {}) {
  const settings = readJson(CRS_SESSION_SETTINGS_PATH, {});
  const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  const key = options.key || crKey();
  if (!key.startsWith('cr_')) {
    throw new Error(`CRS relay key missing or invalid at ${CRKEY_PATH}`);
  }
  const baseUrl = options.baseUrl || readRouteState().crs?.baseUrl || defaultCrsConfig().baseUrl;
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_BASE = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.CLAUDE_CODE_OAUTH_TOKEN = key;
  delete env.ANTHROPIC_API_KEY;
  settings.env = env;
  assertCrsSessionInvariant(env, 'applyCrsSessionSettings');
  writeJsonAtomic(CRS_SESSION_SETTINGS_PATH, settings, 0o600);
  return settings;
}

export function settingsRouteSnapshot() {
  const settings = readJson(SETTINGS_PATH, { env: {} });
  const env = settings.env || {};
  const base = String(env.ANTHROPIC_BASE_URL || '');
  const token = currentCrsToken(env);
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  return {
    settingsPath: SETTINGS_PATH,
    bedrock,
    baseUrl: base || null,
    tokenKind: token.startsWith('cr_') ? 'crs-relay' : token ? 'other' : 'none',
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

export function probeCrsHealth(state = readRouteState()) {
  const healthUrl = process.env.CRS_HEALTH_URL || state.crs?.healthUrl || defaultCrsConfig().healthUrl;
  try {
    const code = execFileSync('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', healthUrl], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return code === '200';
  } catch {
    return false;
  }
}

export function clearCrsFallbackMarker() {
  try {
    if (existsSync(FALLBACK_MARKER)) unlinkSync(FALLBACK_MARKER);
  } catch {}
}

function resetHealthWatchCounters() {
  try {
    writeJsonAtomic(HEALTH_WATCH_STATE, {
      down: 0,
      up: 0,
      inferenceDown: 0,
      lastInferenceHealAt: 0,
      mode: 'crs',
    });
  } catch {}
}

export function restoreCrsRouteIfHealthy(options = {}) {
  const state = readRouteState();
  if (state.mode !== 'fail-closed') {
    return { restored: false, reason: 'not-fail-closed', mode: state.mode };
  }
  if (!probeCrsHealth(state)) {
    return { restored: false, reason: 'crs-unhealthy', mode: state.mode };
  }
  try {
    setRouteMode('crs-oauth', {
      reason: options.reason || 'CRS live probe healthy',
      updatedBy: options.updatedBy || 'crs-route-recovery',
    });
    clearCrsFallbackMarker();
    resetHealthWatchCounters();
    return { restored: true, reason: 'crs-oauth', mode: 'crs-oauth' };
  } catch (e) {
    return { restored: false, reason: e.message || String(e), mode: state.mode };
  }
}
