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

function preferenceHosts() {
  const dataDir =
    process.env.CLAUDE_PLUGIN_DATA_DIR ||
    process.env.OPS_DATA_DIR ||
    join(HOME, '.claude', 'plugins', 'data', 'ops-ops-marketplace');
  try {
    const prefs = JSON.parse(readFileSync(join(dataDir, 'preferences.json'), 'utf8'));
    const hosts = prefs?.agent_dash?.remote_hosts;
    return Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string' && h.trim()) : [];
  } catch {
    return [];
  }
}

// Remote ssh targets to scan, tried in order. Preferences are the durable source;
// env is an explicit per-run override for operators and tests. Empty means local-only.
const REMOTE_HOSTS = (process.env.AGENT_DASH_REMOTE_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(preferenceHosts())
  .filter((host, index, all) => all.indexOf(host) === index);

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

function collectBandJam() {
  const band = readOnlyCommand('band', ['preflight'], 7000);
  const peers = readOnlyCommand('band', ['peers'], 7000);
  const status = readOnlyCommand('band', ['status'], 7000);
  const activity = readOnlyCommand('band', ['activity'], 7000);
  const work = readOnlyCommand('band', ['work'], 7000);
  const available = Boolean(band || peers || status || activity || work);
  return {
    available,
    source: available ? 'band-cli' : 'unavailable',
    preflight: band || null,
    peers: peers || null,
    status: status || null,
    activity: activity || null,
    work: work || null,
    readOnly: true,
  };
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
    `cat > /tmp/agent-dash-probe.mjs && AGENT_DASH_HOST=${JSON.stringify(sshHost)} ` +
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
  // No remote configured is not the same as a remote that failed to answer.
  // Report it as its own state so the dashboard never prints a confident 0.
  if (REMOTE_HOSTS.length === 0) {
    return { agents: [], stale: false, source: 'not-configured', cached: false, known: true, hosts: {} };
  }

  const cache = readCache();
  if (!force && cache && nowTs() - cache.ts < REMOTE_TTL_MS) {
    return {
      agents: cache.agents,
      stale: false,
      source: cache.meta?.source || 'cache',
      cached: true,
      known: true,
      hosts: cache.meta?.hosts || {},
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
      hosts: cache?.meta?.hosts || {},
    };
  }

  const hostStates = {};
  for (const host of REMOTE_HOSTS) {
    try {
      const agents = probeRemoteHost(host, probeSrc);
      hostStates[host] = { count: agents.length, known: true, stale: false, source: host, cached: false };
      writeCache(agents, { source: host, hosts: hostStates });
      return { agents, stale: false, source: host, cached: false, known: true, hosts: hostStates };
    } catch {
      hostStates[host] = { count: null, known: false, stale: true, source: 'unreachable', cached: false };
    }
  }

  if (cache) {
    return {
      agents: cache.agents,
      stale: true,
      source: cache.meta?.source || 'cache',
      cached: true,
      known: true,
      hosts: cache.meta?.hosts || hostStates,
    };
  }
  return { agents: [], stale: true, source: 'unreachable', cached: false, known: false, hosts: hostStates };
}

// --- unified ---------------------------------------------------------------

export function collect({ force = false, localOnly = false } = {}) {
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
      band: collectBandJam(),
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
