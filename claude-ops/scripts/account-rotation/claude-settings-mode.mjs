/**
 * Mutate ~/.claude/settings.json for OAuth vs Bedrock so Claude Code does not
 * keep stale hardcoded model IDs when switching modes (daemon + rotate paths).
 * Model selection is left to Claude Code / the provider default.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { setRouteMode } from './route-state.mjs';

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

function getFallbacksForPrefix(prefix) {
  return {
    primary: '',
    small: '',
    opus: '',
    fable: '',
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
  return setRouteMode('bedrock-confirmed', {
    reason: process.env.CLAUDE_BEDROCK_REASON || 'fallback',
    confirmMetered: process.env.CLAUDE_CONFIRM_METERED_BEDROCK === '1',
    ttlMinutes: Number.parseInt(process.env.CLAUDE_BEDROCK_CONFIRM_TTL_MINUTES || '60', 10),
    region,
    updatedBy: 'claude-settings-mode',
  });
}

/** Match use-oauth.sh: no hardcoded models — Claude Code loads subscription catalog from API. */
export function clearHardcodedModelsForOAuthClaudeSettings() {
  return setRouteMode('crs-oauth', {
    reason: process.env.CLAUDE_ROUTE_REASON || 'oauth-restored',
    updatedBy: 'claude-settings-mode',
  });
}
