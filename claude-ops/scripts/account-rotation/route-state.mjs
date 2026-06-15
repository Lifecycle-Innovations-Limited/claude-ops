import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, hostname } from 'os';

export const ROUTE_MODES = new Set(['crs-oauth', 'bedrock-confirmed', 'fail-closed']);

const STATE_PATH = join(homedir(), '.claude', 'claude-routing-state.json');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CRKEY_PATH = join(homedir(), '.claude', 'scripts', 'account-rotation', '.crkey');

const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
];

const BEDROCK_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_BEDROCK_REGION'];

const ANTHROPIC_DIRECT_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

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

function readSettingsEnv() {
  return readJson(SETTINGS_PATH, { env: {} }).env || {};
}

function defaultCrsConfig() {
  const env = readSettingsEnv();
  const baseUrl = process.env.CRS_BASE_URL || env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:3000/api';
  const healthUrl = process.env.CRS_HEALTH_URL || baseUrl.replace(/\/api\/?$/, '/health');
  return {
    baseUrl,
    healthUrl,
    authority: 'fra-primary',
  };
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function crKey() {
  try {
    return readFileSync(CRKEY_PATH, 'utf8').trim();
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
  if (mode === 'bedrock-confirmed') {
    if (!options.confirmMetered) {
      throw new Error('Bedrock is metered AWS usage; pass confirmMetered=true to activate a TTL-scoped confirmation');
    }
    const confirmedAt = nowIso();
    next.bedrockConfirmation = {
      confirmedAt,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      reason,
      confirmedBy: options.updatedBy || process.env.USER || 'unknown',
    };
  } else {
    next.bedrockConfirmation = null;
  }
  const state = writeRouteState(next);
  applyRouteToSettings(state, options);
  return state;
}

export function applyRouteToSettings(state = readRouteState(), options = {}) {
  const settings = readJson(SETTINGS_PATH, {});
  const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  for (const key of [...MODEL_KEYS, ...ANTHROPIC_DIRECT_KEYS]) delete env[key];
  delete settings.model;
  delete settings.availableModels;

  if (state.mode === 'bedrock-confirmed') {
    if (!bedrockConfirmationActive(state)) {
      throw new Error('Bedrock route lacks an active TTL confirmation');
    }
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.AWS_BEDROCK_REGION = options.region || env.AWS_REGION || process.env.AWS_BEDROCK_REGION || 'us-east-1';
    env.AWS_REGION = env.AWS_BEDROCK_REGION;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (state.mode === 'crs-oauth') {
    for (const key of BEDROCK_KEYS) delete env[key];
    env.AWS_REGION = env.AWS_REGION || process.env.AWS_REGION || 'us-east-1';
    const key = crKey();
    if (!key.startsWith('cr_')) {
      throw new Error(`CRS relay key missing or invalid at ${CRKEY_PATH}`);
    }
    env.ANTHROPIC_BASE_URL = state.crs?.baseUrl || defaultCrsConfig().baseUrl;
    env.CLAUDE_CODE_OAUTH_TOKEN = key;
  } else {
    for (const key of BEDROCK_KEYS) delete env[key];
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  settings.env = env;
  writeJsonAtomic(SETTINGS_PATH, settings);
  return settings;
}

export function settingsRouteSnapshot() {
  const settings = readJson(SETTINGS_PATH, { env: {} });
  const env = settings.env || {};
  const base = String(env.ANTHROPIC_BASE_URL || '');
  const token = String(env.CLAUDE_CODE_OAUTH_TOKEN || '');
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
