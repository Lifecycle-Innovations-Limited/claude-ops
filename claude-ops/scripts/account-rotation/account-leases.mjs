// ── Cross-machine account LEASES ─────────────────────────────────────────────
//
// Supersedes the static machine-pool split: every machine (e.g. a laptop and a
// remote/EC2 box) keeps its OWN rotation logic/daemon and may use ALL accounts.
// The ONLY cross-machine constraint is: the same account must NEVER be ACTIVE on
// two machines concurrently.
//
// Coordination store: a small private S3 object per account.
//   bucket: set CLAUDE_LEASE_BUCKET (e.g. "claude-account-leases-<account-id>");
//           create it with all public access blocked + SSE-AES256.
//   key:    leases/<accountKey>.json   (one object per account → no
//           read-modify-write races between machines)
//   body:   { "host": "<os.hostname()>", "account": "<key>", "ts": <epoch_ms> }
//
// A machine writes (PUT) its own lease when it ACTIVATES an account, and the
// daemon REFRESHES (heartbeats) the active account's lease every loop tick.
// Candidate selection EXCLUDES any account whose lease belongs to ANOTHER host
// and is still fresh (ts within LEASE_TTL_MS). A lease older than the TTL is
// stale and ignored (the other machine stopped heartbeating / is asleep).
//
// FAIL OPEN: every S3 call is best-effort with a short timeout. If the store is
// unreachable, missing, or errors, we log and proceed WITHOUT exclusion —
// rotation must never hard-fail because S3 is down. Worst case under an outage
// is the old behavior (possible double-active), which is exactly today's status
// quo, so failing open is strictly safe.
//
// PLATFORM-NEUTRAL: host identity is os.hostname(); all S3 access is via the
// `aws` CLI default credential chain (we delete AWS_PROFILE from the child env
// so a stale/broken AWS_PROFILE in the parent shell can't break it). For
// coordination to be MUTUAL, every participating machine needs (a) this same
// rotate.mjs/daemon.mjs version and (b) working AWS creds for the lease bucket.
// Until a machine is updated, the others honoring leases is one-sided but
// harmless (updated hosts yield; the unaware host simply ignores leases).

import { spawnSync } from 'child_process';
import { hostname } from 'os';

// Set CLAUDE_LEASE_BUCKET to your private lease bucket. When unset, cross-machine
// lease coordination is disabled (rotation runs single-machine, fail-open).
const LEASE_BUCKET = process.env.CLAUDE_LEASE_BUCKET || '';
const LEASE_PREFIX = 'leases/';
const LEASE_REGION = process.env.CLAUDE_LEASE_REGION || 'us-east-1';
// Daemon heartbeats every loop (seconds–minutes); 2h TTL tolerates pauses,
// GC pauses, and brief outages without falsely freeing a still-active lease.
export const LEASE_TTL_MS = Number(process.env.CLAUDE_LEASE_TTL_MS || 2 * 60 * 60 * 1000);
const AWS_TIMEOUT_MS = 6000;

export function selfHost() {
  return (process.env.CLAUDE_LEASE_HOST || hostname() || 'unknown').trim();
}

function keyFor(accountKey) {
  // accountKey is an email or label; both are S3-key-safe but normalize spaces.
  return `${LEASE_PREFIX}${String(accountKey).replace(/\s+/g, '_')}.json`;
}

// Run `aws` with a clean credential env (drop a broken/parent AWS_PROFILE).
function runAws(args, { input } = {}) {
  const env = { ...process.env };
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  return spawnSync('aws', args, {
    env,
    input,
    timeout: AWS_TIMEOUT_MS,
    encoding: 'utf8',
  });
}

// Read ALL leases in one S3 list+get pass. Returns a Map<accountKey,{host,ts}>.
// Fails open: any error → empty map (no exclusions).
export function readAllLeases(log = () => {}) {
  const leases = new Map();
  if (!LEASE_BUCKET) return leases; // no bucket configured → single-machine, no coordination
  try {
    const ls = runAws([
      's3api',
      'list-objects-v2',
      '--bucket',
      LEASE_BUCKET,
      '--prefix',
      LEASE_PREFIX,
      '--region',
      LEASE_REGION,
      '--output',
      'json',
    ]);
    if (ls.status !== 0) {
      if (ls.stderr) log(`[lease] list failed (fail-open): ${ls.stderr.trim().split('\n')[0]}`);
      return leases;
    }
    const parsed = JSON.parse(ls.stdout || '{}');
    for (const obj of parsed.Contents || []) {
      const k = obj.Key;
      if (!k || !k.endsWith('.json')) continue;
      const got = runAws(['s3', 'cp', `s3://${LEASE_BUCKET}/${k}`, '-', '--region', LEASE_REGION]);
      if (got.status !== 0) continue;
      try {
        const body = JSON.parse(got.stdout);
        if (body && body.account && body.host && body.ts) {
          leases.set(body.account, { host: body.host, ts: Number(body.ts) });
        }
      } catch {}
    }
  } catch (e) {
    log(`[lease] readAll error (fail-open): ${e.message}`);
  }
  return leases;
}

// Accounts (by key) currently leased by ANOTHER host with a FRESH lease.
// Per host, only the NEWEST fresh lease is considered active — older leases
// from the same host are stale rotations that were never cleaned up.
export function foreignActiveKeys(log = () => {}) {
  const me = selfHost();
  const now = Date.now();
  // group all fresh foreign leases by host, then keep only the newest per host
  const byHost = new Map(); // host → { acct, ts }
  for (const [acct, { host, ts }] of readAllLeases(log)) {
    if (host === me || now - ts >= LEASE_TTL_MS) continue;
    const existing = byHost.get(host);
    if (!existing || ts > existing.ts) byHost.set(host, { acct, ts });
  }
  const blocked = new Set();
  for (const { acct } of byHost.values()) blocked.add(acct);
  return blocked;
}

// Write/refresh THIS machine's lease for accountKey. Best-effort; logs on fail.
// Deletes stale leases from this host for other accounts so the other machine
// doesn't exclude accounts we're no longer using.
export function writeLease(accountKey, log = () => {}) {
  if (!LEASE_BUCKET) return false; // no bucket configured → nothing to coordinate
  try {
    const me = selfHost();
    const body = JSON.stringify({ host: me, account: accountKey, ts: Date.now() });
    const put = runAws(
      [
        's3',
        'cp',
        '-',
        `s3://${LEASE_BUCKET}/${keyFor(accountKey)}`,
        '--region',
        LEASE_REGION,
        '--content-type',
        'application/json',
      ],
      { input: body },
    );
    if (put.status !== 0) {
      if (put.stderr) log(`[lease] write ${accountKey} failed (non-fatal): ${put.stderr.trim().split('\n')[0]}`);
      return false;
    }
    // Clean up this host's stale leases for other accounts (best-effort).
    try {
      const all = readAllLeases(log);
      for (const [acct, { host }] of all) {
        if (host === me && acct !== accountKey) {
          const del = runAws(['s3', 'rm', `s3://${LEASE_BUCKET}/${keyFor(acct)}`, '--region', LEASE_REGION]);
          if (del.status === 0) log(`[lease] cleared stale own-lease for ${acct}`);
        }
      }
    } catch {}
    return true;
  } catch (e) {
    log(`[lease] write ${accountKey} error (non-fatal): ${e.message}`);
    return false;
  }
}

// Filter a config.accounts list, dropping accounts foreign-leased & fresh.
// Never drops `keepKey` (the account we're staying on / activating).
export function applyAccountLeases(config, { keepKey = null, log = () => {} } = {}) {
  try {
    const blocked = foreignActiveKeys(log);
    if (!blocked.size) return config;
    const keyOf = (a) => a.label || a.email;
    config.accounts = config.accounts.filter((a) => keyOf(a) === keepKey || !blocked.has(keyOf(a)));
    log(`[lease] excluding foreign-active accounts: ${[...blocked].join(', ')}`);
  } catch (e) {
    log(`[lease] applyAccountLeases error (fail-open): ${e.message}`);
  }
  return config;
}
