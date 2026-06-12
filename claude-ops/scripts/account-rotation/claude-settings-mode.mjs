/**
 * Mutate ~/.claude/settings.json for OAuth vs Bedrock so Claude Code does not
 * keep stale hardcoded model IDs when switching modes (daemon + rotate paths).
 *
 * Bedrock primary + small-fast IDs are resolved from `aws bedrock list-inference-profiles`
 * when possible (latest Sonnet / Haiku by version rank); falls back to pinned defaults
 * if AWS CLI fails. Set BEDROCK_SKIP_RESOLVE=1 to force defaults only.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

function claudeSettingsPath() {
  return join(process.env.HOME || '', '.claude', 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettingsAtomic(s) {
  const p = claudeSettingsPath();
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

/** Pinned fallbacks when list-inference-profiles fails or returns nothing. */
const BEDROCK_PRIMARY_FALLBACK = 'us.anthropic.claude-sonnet-4-6';
const BEDROCK_SMALL_FALLBACK = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Map AWS region to preferred cross-region inference profile prefix. */
export function preferredInferencePrefix(awsRegion) {
  const r = (awsRegion || 'us-east-1').toLowerCase();
  if (r.startsWith('us-')) return 'us.';
  if (r.startsWith('eu-')) return 'eu.';
  if (r.startsWith('ap-northeast')) return 'jp.';
  if (r.startsWith('ap-southeast-2')) return 'au.';
  return 'us.';
}

function listAllInferenceProfilesSync(region) {
  const summaries = [];
  let startingToken;
  for (;;) {
    const args = [
      'bedrock',
      'list-inference-profiles',
      '--region',
      region,
      '--type-equals',
      'SYSTEM_DEFINED',
      '--output',
      'json',
    ];
    if (startingToken) args.push('--starting-token', startingToken);
    const out = execFileSync('aws', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    const data = JSON.parse(out);
    summaries.push(...(data.inferenceProfileSummaries || []));
    startingToken = data.NextToken;
    if (!startingToken) break;
  }
  return summaries;
}

function rankCompareDesc(ra, rb) {
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const a = ra[i] ?? 0;
    const b = rb[i] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

function sonnetRank(inferenceProfileId) {
  const m = inferenceProfileId.match(/\.anthropic\.claude-sonnet-(.+)$/);
  if (!m) return [-1];
  const tail = m[1].replace(/-v\d+:\d+$/i, '');
  // Order matters: `4-20250514` must not match as major-minor (second group YYYYMMDD).
  let mm = tail.match(/^(\d+)-(\d+)-(\d{8})$/);
  if (mm) {
    return [parseInt(mm[1], 10), parseInt(mm[2], 10), parseInt(mm[3], 10)];
  }
  mm = tail.match(/^(\d+)-(\d{8})$/);
  if (mm) return [parseInt(mm[1], 10), 0, parseInt(mm[2], 10)];
  mm = tail.match(/^(\d+)-(\d+)$/);
  if (mm) {
    const second = mm[2];
    if (/^\d{8}$/.test(second)) {
      return [parseInt(mm[1], 10), 0, parseInt(second, 10)];
    }
    return [parseInt(mm[1], 10), parseInt(second, 10), 0];
  }
  return [0, 0, 0];
}

function haikuRank(inferenceProfileId) {
  let m = inferenceProfileId.match(/\.anthropic\.claude-haiku-(\d+)-(\d+)-(\d{8})/);
  if (m) {
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }
  m = inferenceProfileId.match(/\.anthropic\.claude-3-5-haiku-(\d{8})/);
  if (m) return [3, 5, parseInt(m[1], 10)];
  m = inferenceProfileId.match(/\.anthropic\.claude-3-haiku-(\d{8})/);
  if (m) return [3, 0, parseInt(m[1], 10)];
  return [-1, 0, 0];
}

function isActiveSystem(p) {
  return p?.type === 'SYSTEM_DEFINED' && p?.status === 'ACTIVE' && p?.inferenceProfileId;
}

function candidatesWithPrefix(profiles, prefix, predicate) {
  const active = profiles.filter((p) => isActiveSystem(p) && predicate(p.inferenceProfileId));
  const pref = active.filter((p) => p.inferenceProfileId.startsWith(prefix));
  if (pref.length) return pref;
  const glob = active.filter((p) => p.inferenceProfileId.startsWith('global.'));
  if (glob.length) return glob;
  return active;
}

function pickLatestSonnet(profiles, prefix) {
  const c = candidatesWithPrefix(profiles, prefix, (id) => id.includes('.anthropic.claude-sonnet-'));
  if (!c.length) return null;
  c.sort((x, y) => rankCompareDesc(sonnetRank(x.inferenceProfileId), sonnetRank(y.inferenceProfileId)));
  return c[0].inferenceProfileId;
}

function pickLatestHaiku(profiles, prefix) {
  const c = candidatesWithPrefix(profiles, prefix, (id) => {
    if (id.includes('.anthropic.claude-haiku-')) return haikuRank(id)[0] >= 0;
    if (id.includes('.anthropic.claude-3-') && id.includes('haiku')) return true;
    return false;
  });
  if (!c.length) return null;
  c.sort((x, y) => rankCompareDesc(haikuRank(x.inferenceProfileId), haikuRank(y.inferenceProfileId)));
  return c[0].inferenceProfileId;
}

/**
 * Resolve latest Bedrock inference profile IDs for Claude Code (Sonnet + Haiku).
 * @param {string} region - AWS region for `list-inference-profiles` (e.g. us-east-1)
 * @returns {{ primary: string, small: string, source: 'api' | 'fallback', detail?: string }}
 */
export function resolveBedrockClaudeModelIds(region = 'us-east-1') {
  if (process.env.BEDROCK_SKIP_RESOLVE === '1') {
    return {
      primary: BEDROCK_PRIMARY_FALLBACK,
      small: BEDROCK_SMALL_FALLBACK,
      source: 'fallback',
      detail: 'BEDROCK_SKIP_RESOLVE',
    };
  }
  try {
    const profiles = listAllInferenceProfilesSync(region);
    const prefix = preferredInferencePrefix(region);
    const primary = pickLatestSonnet(profiles, prefix);
    const small = pickLatestHaiku(profiles, prefix);
    if (primary && small) {
      return { primary, small, source: 'api' };
    }
    return {
      primary: primary || BEDROCK_PRIMARY_FALLBACK,
      small: small || BEDROCK_SMALL_FALLBACK,
      source: 'fallback',
      detail: primary ? 'missing-haiku' : small ? 'missing-sonnet' : 'missing-both',
    };
  } catch (e) {
    return {
      primary: BEDROCK_PRIMARY_FALLBACK,
      small: BEDROCK_SMALL_FALLBACK,
      source: 'fallback',
      detail: (e.message || String(e)).slice(0, 200),
    };
  }
}

/** Match use-bedrock.sh: Bedrock env + strip top-level model lists (OAuth catalog ids break Bedrock). */
export function persistBedrockClaudeSettings(region = 'us-east-1') {
  const { primary, small } = resolveBedrockClaudeModelIds(region);
  const s = readSettings();
  const env = s.env && typeof s.env === 'object' ? { ...s.env } : {};
  env.CLAUDE_CODE_USE_BEDROCK = '1';
  env.AWS_BEDROCK_REGION = region;
  env.AWS_REGION = region;
  env.ANTHROPIC_MODEL = primary;
  env.ANTHROPIC_SMALL_FAST_MODEL = small;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  s.env = env;
  delete s.model;
  delete s.availableModels;
  writeSettingsAtomic(s);
}

/** Match use-oauth.sh: no hardcoded models — Claude Code loads subscription catalog from API. */
export function clearHardcodedModelsForOAuthClaudeSettings() {
  const s = readSettings();
  const env = s.env && typeof s.env === 'object' ? { ...s.env } : {};
  for (const k of [
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_BEDROCK_REGION',
    'AWS_REGION',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ]) {
    delete env[k];
  }
  s.env = env;
  delete s.model;
  delete s.availableModels;
  writeSettingsAtomic(s);
}
