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

const AWS_PROFILE_CANDIDATES = ['default', 'ec2-user-cli', 'healify', 'workshop'];

function awsProfileProbeEnv(profile, region = 'us-east-1') {
  const env = {
    ...process.env,
    AWS_PROFILE: profile,
    AWS_DEFAULT_PROFILE: profile,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
  env.AWS_ACCESS_KEY_ID = '';
  env.AWS_SECRET_ACCESS_KEY = '';
  env.AWS_SESSION_TOKEN = '';
  return env;
}

export function resolveWorkingAwsEnv(region = 'us-east-1') {
  try {
    execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    });
    return {
      env: { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
      profile: process.env.AWS_PROFILE || '',
    };
  } catch {}
  for (const profile of AWS_PROFILE_CANDIDATES) {
    const env = awsProfileProbeEnv(profile, region);
    try {
      execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env,
      });
      return { env, profile };
    } catch {}
  }
  return {
    env: { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    profile: process.env.AWS_PROFILE || '',
  };
}

function getFallbacksForPrefix(prefix) {
  return {
    primary: `${prefix}anthropic.claude-sonnet-4-6`,
    small: `${prefix}anthropic.claude-haiku-4-5-20251001-v1:0`,
    opus: `${prefix}anthropic.claude-opus-4-1-20250805-v1:0`,
    fable: `${prefix}anthropic.claude-fable-5`,
  };
}

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
  const aws = resolveWorkingAwsEnv(region);
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
      env: aws.env,
    });
    const data = JSON.parse(out);
    summaries.push(...(data.inferenceProfileSummaries || []));
    startingToken = data.NextToken;
    if (!startingToken) break;
  }
  return summaries;
}

export function parseModelRank(inferenceProfileId) {
  // Strip trailing version flags like -v1:0, :v1:0, or v1
  const cleanId = inferenceProfileId.replace(/[-:]v\d+(:\d+)?$/i, '').replace(/v\d+$/i, '');
  const matches = cleanId.match(/\d+/g);
  if (!matches) return [0, 0, 0];
  const nums = matches.map((n) => parseInt(n, 10));
  const major = nums[0];
  let minor = 0;
  let date = 0;
  if (nums.length > 1) {
    const last = nums[nums.length - 1];
    if (last >= 20000000 && last <= 21000000) {
      date = last;
      if (nums.length === 3) {
        minor = nums[1];
      }
    } else {
      minor = nums[1];
    }
  }
  return [major, minor, date];
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

function pickLatestModel(profiles, prefix, pattern, fallback) {
  const c = candidatesWithPrefix(profiles, prefix, (id) => pattern.test(id));
  if (!c.length) return fallback;
  c.sort((x, y) => rankCompareDesc(parseModelRank(x.inferenceProfileId), parseModelRank(y.inferenceProfileId)));
  return c[0].inferenceProfileId;
}

/**
 * Resolve latest Bedrock inference profile IDs for Claude Code (Sonnet, Haiku, Opus, Fable).
 * @param {string} region - AWS region for `list-inference-profiles` (e.g. us-east-1)
 * @returns {{ primary: string, small: string, opus: string, fable: string, source: 'api' | 'fallback', detail?: string }}
 */
export function resolveBedrockClaudeModelIds(region = 'us-east-1') {
  const prefix = preferredInferencePrefix(region);
  const fallbacks = getFallbacksForPrefix(prefix);
  if (process.env.BEDROCK_SKIP_RESOLVE === '1') {
    return {
      primary: fallbacks.primary,
      small: fallbacks.small,
      opus: fallbacks.opus,
      fable: fallbacks.fable,
      source: 'fallback',
      detail: 'BEDROCK_SKIP_RESOLVE',
    };
  }
  try {
    const profiles = listAllInferenceProfilesSync(region);
    const primary = pickLatestModel(profiles, prefix, /\.anthropic\.claude-sonnet-/, fallbacks.primary);
    const small = pickLatestModel(
      profiles,
      prefix,
      /(\.anthropic\.claude-.*haiku|\.anthropic\.claude-3-.*haiku)/,
      fallbacks.small,
    );
    const opus = pickLatestModel(profiles, prefix, /\.anthropic\.claude-opus-/, fallbacks.opus);
    const fable = pickLatestModel(profiles, prefix, /\.anthropic\.claude-fable-/, fallbacks.fable);
    return { primary, small, opus, fable, source: 'api' };
  } catch (e) {
    return {
      primary: fallbacks.primary,
      small: fallbacks.small,
      opus: fallbacks.opus,
      fable: fallbacks.fable,
      source: 'fallback',
      detail: (e.message || String(e)).slice(0, 200),
    };
  }
}

/** Match use-bedrock.sh: Bedrock env + strip top-level model lists (OAuth catalog ids break Bedrock). */
export function persistBedrockClaudeSettings(region = 'us-east-1') {
  const { primary, small, opus, fable } = resolveBedrockClaudeModelIds(region);
  const aws = resolveWorkingAwsEnv(region);
  const s = readSettings();
  const env = s.env && typeof s.env === 'object' ? { ...s.env } : {};
  env.CLAUDE_CODE_USE_BEDROCK = '1';
  env.AWS_BEDROCK_REGION = region;
  env.AWS_REGION = region;
  env.AWS_DEFAULT_REGION = region;
  if (aws.profile) {
    env.AWS_PROFILE = aws.profile;
    env.AWS_DEFAULT_PROFILE = aws.profile;
  }
  env.AWS_ACCESS_KEY_ID = '';
  env.AWS_SECRET_ACCESS_KEY = '';
  env.AWS_SESSION_TOKEN = '';
  env.ANTHROPIC_MODEL = primary;
  env.ANTHROPIC_SMALL_FAST_MODEL = small;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = primary;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable;
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
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
  ]) {
    delete env[k];
  }
  s.env = env;
  delete s.model;
  delete s.availableModels;
  writeSettingsAtomic(s);
}
