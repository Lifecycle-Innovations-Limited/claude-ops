#!/usr/bin/env node
// collect.mjs — gather the unified agent fleet (local Mac + configured remote hosts)
// as one JSON array. Remote hosts are operator configuration, never public defaults.
// The same host-probe.mjs runs locally and over ssh, so derivation stays in one place.
// Remote is cached 30s; every probe has a hard timeout so a wedged host degrades to
// an explicit unknown state rather than hanging the dash.
//
// Usage:
//   node collect.mjs            # pretty-ish JSON of the merged fleet
//   import { collect } from './collect.mjs'   # programmatic
//
// Configuration (operator-owned, not committed):
//   AGENT_DASH_REMOTE_HOSTS=my-remote-host
//   preferences.json: { "agent_dash": { "remote_hosts": ["my-remote-host"] } }

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

import { configuredRemoteHosts, shellQuote } from './remote-hosts.mjs';

function readCache() {
  try {
    const c = JSON.parse(readFileSync(REMOTE_CACHE, 'utf8'));
    if (c && Array.isArray(c.agents)) return c;
  } catch {
    /* none */
  }
  return null;
}

function writeCache(agents, meta) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(REMOTE_CACHE, JSON.stringify({ agents, meta, ts: nowTs() }));
  } catch {
    /* best effort */
  }
}

// nowTs avoids Date.now() (banned in workflow scripts; fine here but keep one source)
function nowTs() {
  return Date.now();
}

function readOnlyCommand(command, args = [], timeout = 5000) {
  try {
    const out = execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch {
    return '';
  }
}

// Band/Jam probes are read-only but slow to answer when the daemon is wedged.
// Five sequential 7s calls would block the caller for up to 35s, so each probe is
// capped at 1.5s and the whole layer is cached for a short window. Subcommand paths
// (attach/steer/kill) and local-only collection never pay this cost at all.
const BAND_TTL_MS = 30 * 1000;
const BAND_PROBE_TIMEOUT_MS = 1500;
let bandCache = { ts: 0, value: null };

function collectBandJam() {
  const fresh = bandCache.value && nowTs() - bandCache.ts < BAND_TTL_MS;
  if (fresh) return bandCache.value;

  const band = readOnlyCommand('band', ['preflight'], BAND_PROBE_TIMEOUT_MS);
  const peers = readOnlyCommand('band', ['peers'], BAND_PROBE_TIMEOUT_MS);
  const status = readOnlyCommand('band', ['status'], BAND_PROBE_TIMEOUT_MS);
  const activity = readOnlyCommand('band', ['activity'], BAND_PROBE_TIMEOUT_MS);
  const work = readOnlyCommand('band', ['work'], BAND_PROBE_TIMEOUT_MS);
  const available = Boolean(band || peers || status || activity || work);
  const value = {
    available,
    source: available ? 'band-cli' : 'unavailable',
    cached: true,
    ts: nowTs(),
    preflight: band || null,
    peers: peers || null,
    status: status || null,
    activity: activity || null,
    work: work || null,
    readOnly: true,
  };
  bandCache = { ts: nowTs(), value };
  return value;
}

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

// --- configured remote hosts ------------------------------------------------

function probeRemoteHost(sshHost, probeSrc) {
  // Ship the probe over stdin, run it remotely, and label records with the
  // configured ssh alias. One round-trip, hard timeout, read-only on the host.
  const remoteCmd =
    `cat > /tmp/agent-dash-probe.mjs && AGENT_DASH_HOST=${shellQuote(sshHost)} ` +
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

// A host served from cache is not live, and a host we could not reach is not live either.
// The per-host states are stored without those flags, so they are applied here rather
// than being reported as live by the renderer.
function withCacheFlags(hosts, { cached = false, stale = false } = {}) {
  const out = {};
  for (const [host, info] of Object.entries(hosts || {})) {
    out[host] = { ...info, cached: cached || Boolean(info.cached), stale: stale || Boolean(info.stale) };
  }
  return out;
}

export function collectRemote({ force = false } = {}) {
  const REMOTE_HOSTS = configuredRemoteHosts();
  // No remote configured is not the same as a remote that failed to answer.
  // Report it as its own state so the dashboard never prints a confident 0.
  if (REMOTE_HOSTS.length === 0) {
    return { agents: [], stale: false, source: 'not-configured', cached: false, known: true, hosts: {} };
  }

  const storedCache = readCache();
  // A snapshot from another configuration cannot supply agents for this fleet.
  const cache =
    storedCache &&
    JSON.stringify(Object.keys(storedCache.meta?.hosts || {}).sort()) === JSON.stringify([...REMOTE_HOSTS].sort())
      ? storedCache
      : null;
  if (!force && cache && nowTs() - cache.ts < REMOTE_TTL_MS) {
    return {
      agents: cache.agents,
      stale: false,
      source: cache.meta?.source || 'cache',
      cached: true,
      known: true,
      hosts: withCacheFlags(cache.meta?.hosts, { cached: true }),
    };
  }

  let probeSrc;
  try {
    probeSrc = readFileSync(PROBE, 'utf8');
  } catch {
    return {
      agents: cache?.agents || [],
      stale: true,
      source: 'no-probe',
      cached: !!cache,
      known: !!cache,
      hosts: withCacheFlags(cache?.meta?.hosts, { cached: true, stale: true }),
    };
  }

  const hostStates = {};
  const allAgents = [];
  let anyLive = false;
  for (const host of REMOTE_HOSTS) {
    try {
      const agents = probeRemoteHost(host, probeSrc);
      hostStates[host] = { count: agents.length, known: true, stale: false, source: host, cached: false };
      allAgents.push(...agents);
      anyLive = true;
    } catch {
      hostStates[host] = { count: null, known: false, stale: true, source: 'unreachable', cached: false };
    }
  }

  // Every configured host is probed, so a host that answers never hides the ones behind it.
  if (anyLive) {
    writeCache(allAgents, { source: REMOTE_HOSTS.join(','), hosts: hostStates });
    return {
      agents: allAgents,
      stale: false,
      source: REMOTE_HOSTS.join(','),
      cached: false,
      known: true,
      hosts: hostStates,
    };
  }

  if (cache) {
    return {
      agents: cache.agents,
      stale: true,
      source: cache.meta?.source || 'cache',
      cached: true,
      known: true,
      hosts: withCacheFlags(cache.meta?.hosts || hostStates, { cached: true, stale: true }),
    };
  }
  return { agents: [], stale: true, source: 'unreachable', cached: false, known: false, hosts: hostStates };
}

// --- unified ---------------------------------------------------------------

export function collect({ force = false, localOnly = false, skipCollaboration = false } = {}) {
  const local = collectLocal();
  let remote = { agents: [], stale: false, source: 'skipped', cached: false, known: true, hosts: {} };
  if (!localOnly) remote = collectRemote({ force });
  const hosts = {
    mac: { count: local.length, known: true, stale: false, source: 'local', cached: false },
    ...remote.hosts,
  };
  return {
    ts: nowTs(),
    hosts,
    agents: [...local, ...remote.agents],
    collaboration: {
      band:
        localOnly || skipCollaboration
          ? { available: false, source: 'skipped', cached: true, readOnly: true }
          : collectBandJam(),
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force');
  const localOnly = process.argv.includes('--local');
  process.stdout.write(JSON.stringify(collect({ force, localOnly }), null, 2));
  process.stdout.write('\n');
}
