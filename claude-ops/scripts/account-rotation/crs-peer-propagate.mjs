/**
 * crs-peer-propagate.mjs — push a freshly-refreshed rotation token to the peer box.
 *
 * OAuth refresh tokens are single-use: whichever box refreshes an account last
 * holds the only valid refresh token. Without handing that token to the peer,
 * the peer's vault goes stale and its next refresh attempt 400s (invalid_grant),
 * producing needs-reauth quarantine churn. This helper closes that gap by
 * mirroring the fresh token into the peer's file vault over SSH, under the
 * caller's already-held single-writer refresh lock. The peer's own feeder then
 * propagates it into the peer relay on its next cycle (and, on macOS, readRotationToken
 * heals the fresh file token into the Keychain).
 *
 * Best-effort: never throws. A propagation failure must not break the local feed.
 */
import { execFileSync } from 'child_process';

function peerSshHosts() {
  if (process.env.CRS_PEER_SSH_HOSTS) {
    return process.env.CRS_PEER_SSH_HOSTS.split(',')
      .map((h) => h.trim())
      .filter(Boolean);
  }
  // From dev-us the peer is the Mac; from the Mac the peer is dev-us. The alias
  // set mirrors ~/.ssh/config blocks managed by crs-resolve-ips.sh.
  return process.platform === 'darwin' ? ['devus', 'llm-dev-us'] : ['mac'];
}

// Runs on the peer: merge the incoming token into ~/.claude/.credentials.json,
// but only when it is strictly newer than what the peer already holds.
const PEER_MIRROR_SCRIPT = String.raw`
const fs = require('fs');
const os = require('os');
const path = require('path');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const target = path.join(os.homedir(), '.claude', '.credentials.json');
let store = {};
try { store = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
const service = 'Claude-Rotation-' + payload.key;
const prev = store[service] || {};
const curExp = Number(prev.claudeAiOauth && prev.claudeAiOauth.expiresAt || 0);
const newExp = Number(payload.claudeAiOauth && payload.claudeAiOauth.expiresAt || 0);
if (!(newExp > curExp)) {
  process.stdout.write(JSON.stringify({ ok: true, written: false, reason: 'not-newer' }));
  process.exit(0);
}
store[service] = { claudeAiOauth: payload.claudeAiOauth, mcpOAuth: prev.mcpOAuth || {} };
const tmp = target + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
fs.renameSync(tmp, target);
process.stdout.write(JSON.stringify({ ok: true, written: true, exp: newExp }));
`;

export function propagateFreshTokenToPeer(key, oauth, { log = () => {} } = {}) {
  if (process.env.CRS_PEER_PROPAGATE === '0') return { ok: false, skipped: 'disabled' };
  if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
    return { ok: false, skipped: 'incomplete-token' };
  }
  const hosts = peerSshHosts();
  const b64 = Buffer.from(PEER_MIRROR_SCRIPT, 'utf8').toString('base64');
  const remoteCmd =
    'PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH" ' +
    `CRS_PEER_MIRROR_B64=${b64} node -e 'eval(Buffer.from(process.env.CRS_PEER_MIRROR_B64, "base64").toString())'`;
  const input = JSON.stringify({ key, claudeAiOauth: oauth });
  let lastError;
  for (const host of hosts) {
    try {
      const out = execFileSync('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, remoteCmd], {
        input,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      let parsed = {};
      try {
        parsed = JSON.parse(out);
      } catch {}
      if (parsed.written) log(`${key}: propagated fresh token to peer ${host}`);
      else log(`${key}: peer ${host} already current (${parsed.reason || 'no-op'})`);
      return { ok: true, host, ...parsed };
    } catch (error) {
      lastError = error;
    }
  }
  log(`${key}: peer propagation failed (${String((lastError && lastError.message) || lastError).split('\n')[0]})`);
  return { ok: false, error: lastError && lastError.message };
}
