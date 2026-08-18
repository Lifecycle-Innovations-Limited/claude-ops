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

// Remote ssh targets to scan, tried in order. Set AGENT_DASH_FRA_HOSTS
// (comma-separated ssh host aliases) to point at your own remote box(es);
// empty by default so the dashboard is local-only out of the box.
const FRA_HOSTS = (process.env.AGENT_DASH_FRA_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
  // No remote configured is not the same as a remote that failed to answer.
  // Report it as its own state so the dashboard never prints a confident 0.
  if (FRA_HOSTS.length === 0) {
    return { agents: [], stale: false, source: 'not-configured', cached: false, known: true };
  }

  const cache = readCache();
  if (!force && cache && nowTs() - cache.ts < REMOTE_TTL_MS) {
    return { agents: cache.agents, stale: false, source: cache.meta?.source || 'cache', cached: true, known: true };
  }

  let probeSrc;
  try {
    probeSrc = readFileSync(PROBE, 'utf8');
  } catch {
    return { agents: cache?.agents || [], stale: true, source: 'no-probe', cached: !!cache, known: !!cache };
  }

  for (const h of FRA_HOSTS) {
    try {
      const agents = probeRemoteHost(h.trim(), probeSrc);
      writeCache(agents, { source: h.trim() });
      return { agents, stale: false, source: h.trim(), cached: false, known: true };
    } catch {
      /* try next host */
    }
  }

  // all FRA hosts failed — serve last-known cache, flagged stale
  if (cache) {
    return { agents: cache.agents, stale: true, source: cache.meta?.source || 'cache', cached: true, known: true };
  }
  // Configured, tried, no answer, and nothing cached: the agent count is UNKNOWN,
  // not zero. `known: false` tells consumers they may not report a number here.
  return { agents: [], stale: true, source: 'unreachable', cached: false, known: false };
}

// --- unified ---------------------------------------------------------------

export function collect({ force = false, localOnly = false } = {}) {
  const local = collectLocal();
  let remote = { agents: [], stale: false, source: 'skipped', cached: false, known: true };
  if (!localOnly) remote = collectRemote({ force });
  return {
    ts: nowTs(),
    hosts: {
      mac: { count: local.length },
      // `count` is null — never 0 — when the remote could not be reached and no
      // cache exists. Zero would read as "no agents there", which is a claim the
      // probe cannot support. Consumers must render null as unknown.
      fra: {
        count: remote.known === false ? null : remote.agents.length,
        known: remote.known !== false,
        stale: remote.stale,
        source: remote.source,
        cached: remote.cached,
      },
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
