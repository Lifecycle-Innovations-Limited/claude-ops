#!/usr/bin/env node
// collect.mjs — gather the unified agent fleet (local Mac + FRA EC2) as one JSON
// array. The same host-probe.mjs runs locally and (piped over ssh) on FRA, so
// derivation lives in exactly one place. Remote is cached 30s; every probe has a
// hard timeout so a wedged host degrades to empty rather than hanging the dash.
//
// Usage:
//   node collect.mjs            # pretty-ish JSON of the merged fleet
//   import { collect } from './collect.mjs'   # programmatic
//
// Cache: ~/.claude/state/agent-dash-remote-cache.json (FRA result + timestamp)

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const PROBE = join(HERE, 'host-probe.mjs');
const STATE_DIR = join(HOME, '.claude', 'state');
const REMOTE_CACHE = join(STATE_DIR, 'agent-dash-remote-cache.json');
const REMOTE_TTL_MS = 30 * 1000;

// FRA ssh targets, tried in order. dev-sandbox-fra-cf is the Cloudflare-Access
// fallback when Tailscale/direct is down (see workspace CLAUDE.md).
const FRA_HOSTS = (process.env.AGENT_DASH_FRA_HOSTS || 'fra-direct,dev-sandbox-fra-cf').split(',');

function readCache() {
  try {
    const c = JSON.parse(readFileSync(REMOTE_CACHE, 'utf8'));
    if (c && Array.isArray(c.agents)) return c;
  } catch { /* none */ }
  return null;
}

function writeCache(agents, meta) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(REMOTE_CACHE, JSON.stringify({ agents, meta, ts: nowTs() }));
  } catch { /* best effort */ }
}

// nowTs avoids Date.now() (banned in workflow scripts; fine here but keep one source)
function nowTs() { return Date.now(); }

// --- local -----------------------------------------------------------------

export function collectLocal() {
  try {
    const out = execFileSync(process.execPath, [PROBE], {
      env: { ...process.env, AGENT_DASH_HOST: 'mac' },
      timeout: 20000,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// --- remote (FRA) ----------------------------------------------------------

function probeRemoteHost(sshHost, probeSrc) {
  // Ship the probe over stdin, run it with the remote node, label records 'fra'.
  // One round-trip, hard timeout, read-only on the remote box.
  const remoteCmd =
    'cat > /tmp/agent-dash-probe.mjs && AGENT_DASH_HOST=fra ' +
    'node /tmp/agent-dash-probe.mjs; rm -f /tmp/agent-dash-probe.mjs';
  const out = execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', sshHost, remoteCmd],
    { input: probeSrc, timeout: 25000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const arr = JSON.parse(out);
  if (!Array.isArray(arr)) throw new Error('bad remote payload');
  return arr;
}

export function collectRemote({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache && nowTs() - cache.ts < REMOTE_TTL_MS) {
    return { agents: cache.agents, stale: false, source: cache.meta?.source || 'cache', cached: true };
  }

  let probeSrc;
  try { probeSrc = readFileSync(PROBE, 'utf8'); } catch {
    return { agents: cache?.agents || [], stale: true, source: 'no-probe', cached: !!cache };
  }

  for (const h of FRA_HOSTS) {
    try {
      const agents = probeRemoteHost(h.trim(), probeSrc);
      writeCache(agents, { source: h.trim() });
      return { agents, stale: false, source: h.trim(), cached: false };
    } catch { /* try next host */ }
  }

  // all FRA hosts failed — serve last-known cache, flagged stale
  if (cache) return { agents: cache.agents, stale: true, source: cache.meta?.source || 'cache', cached: true };
  return { agents: [], stale: true, source: 'unreachable', cached: false };
}

// --- unified ---------------------------------------------------------------

export function collect({ force = false, localOnly = false } = {}) {
  const local = collectLocal();
  let remote = { agents: [], stale: false, source: 'skipped', cached: false };
  if (!localOnly) remote = collectRemote({ force });
  return {
    ts: nowTs(),
    hosts: {
      mac: { count: local.length },
      fra: { count: remote.agents.length, stale: remote.stale, source: remote.source, cached: remote.cached },
    },
    agents: [...local, ...remote.agents],
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force');
  const localOnly = process.argv.includes('--local');
  process.stdout.write(JSON.stringify(collect({ force, localOnly }), null, 2));
  process.stdout.write('\n');
}
