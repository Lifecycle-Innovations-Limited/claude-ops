import { normalizeClaudeModelArgs } from './model-args.mjs';
// ── Background-session respawn after rotation ────────────────────────────────
// Daemon-hosted `claude --bg` sessions have no TTY, so the /login-injection
// path in rotate.mjs can never reach them. They also never register in the
// statusline pidfile (`/tmp/claude-pids-<email>`), so the SIGHUP hot-swap
// misses them too. Net effect (observed 2026-06-11): after a rotation the bg
// fleet keeps running on the outgoing account's token until it expires
// (~1-2h), then wedges on 401s until a human runs /login.
//
// The supported refresh path for bg sessions is `claude respawn <id>` — the
// supervisor re-execs the session (transcript preserved, session resumes) and
// the fresh process reads the post-rotation keychain.
//
// Policy:
//   idle / waiting  → respawn immediately (nothing in flight, zero disruption)
//   busy            → defer (marker file); the daemon sweep retries until the
//                     session goes idle, or force-respawns after
//                     BUSY_FORCE_AFTER_MS (better to lose one tool call than
//                     wedge on an expired token for hours)
//
// Used by rotate.mjs (post-rotation) and daemon.mjs (periodic deferred sweep).

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  statSync,
  existsSync,
} from 'fs';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getTokenForSession, extractAccessToken, readLeases, recordSessionLease } from './session-router.mjs';
import { isLegacyRelayBase, isLegacyRelayToken, readRouteState } from './route-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const RESPAWNED_MARKER = (id) => `/tmp/claude-rotation-respawned-${id}`;
const DEFERRED_MARKER = (id) => `/tmp/claude-respawn-deferred-${id}`;
const RESPAWN_THROTTLE_MS = 10 * 60_000; // never respawn the same session twice in 10 min
const BUSY_FORCE_AFTER_MS = 90 * 60_000; // busy this long after rotation → respawn anyway

// A retired relay backend once left this marker to explain a "direct" session.
// Respawn is always direct now, so the only thing left to do with it is clear it.
const LEGACY_RELAY_DOWN_MARKER = '/tmp/claude-crs-relay-down';
const LEGACY_SESSION_SETTINGS_SUFFIX = 'crs-session-settings.json';

// TTY hygiene helper: on abnormal paths or exit, attempt to restore sane mode so
// background errors or claude subprocs do not leave ^C ^[ etc. in a raw-mode TUI.
function resetTty() {
  try {
    execSync('stty sane 2>/dev/null || true', { stdio: 'ignore', timeout: 800 });
  } catch {}
}
process.once('exit', resetTty);

/** Drop the leftovers a retired relay backend may have left on this machine. */
function clearLegacyRelayArtifacts(log) {
  try {
    if (existsSync(LEGACY_RELAY_DOWN_MARKER)) {
      unlinkSync(LEGACY_RELAY_DOWN_MARKER);
      log(`[bg-respawn] cleared stale relay marker ${LEGACY_RELAY_DOWN_MARKER}`);
    }
  } catch {}
}

// Graceful rotation-over stagger: respawn bg sessions ONE AT A TIME with this gap
// so the fleet doesn't all re-auth onto the new account in the same instant and
// stampede it into a rate-limit. Default 5s; tune via
// CLAUDE_ROTATION_SESSION_STAGGER_MS (0 disables). Kept in sync with rotate.mjs.
const SESSION_STAGGER_MS = (() => {
  const v = parseInt(process.env.CLAUDE_ROTATION_SESSION_STAGGER_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 5000;
})();

// Synchronous sleep (this module is sync end-to-end; respawn uses execSync).
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    execSync(`sleep ${(ms / 1000).toFixed(2)}`, { timeout: ms + 5000 });
  } catch {}
}

let _claudeBin = null;
function claudeBin() {
  if (_claudeBin) return _claudeBin;
  const candidates = [
    process.env.CLAUDE_BIN,
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) {
      _claudeBin = c;
      return c;
    }
  }
  try {
    const w = execSync('which claude', { timeout: 3000 }).toString().trim();
    if (w) {
      _claudeBin = w;
      return w;
    }
  } catch {}
  _claudeBin = 'claude'; // last resort: rely on PATH
  return _claudeBin;
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markerFresh(path, maxAgeMs) {
  try {
    return Date.now() - statSync(path).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

function preserveDeferredMarker(id) {
  try {
    writeFileSync(DEFERRED_MARKER(id), String(Date.now()), { mode: 0o600 });
  } catch {}
}

function activeKeychainAccessToken() {
  try {
    if (process.platform === 'linux') {
      const store = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
      return store?.claudeAiOauth?.accessToken || null;
    }
    const account = process.env.USER || 'unknown';
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', account, '-w'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function respawnStateCoherent(stateFile) {
  try {
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!Array.isArray(persisted.respawnFlags)) return true;
    const normalized = normalizeClaudeModelArgs(persisted.respawnFlags);
    if (!normalized.every((flag, index) => flag === persisted.respawnFlags[index])) return false;
    // A relay session-settings overlay must not survive into a respawn.
    return !persisted.respawnFlags.some(
      (flag, index) =>
        flag === '--settings' &&
        String(persisted.respawnFlags[index + 1] || '').endsWith(LEGACY_SESSION_SETTINGS_SUFFIX),
    );
  } catch {
    return false;
  }
}

export function routeCredentialFingerprint(token) {
  if (!token) return null;
  return createHash('sha256').update('bg-respawn-route\0').update(String(token)).digest('hex');
}

function normalizedRoute(route) {
  if (!route || typeof route !== 'object') return null;
  return {
    mode: String(route.mode || ''),
    baseUrl: route.baseUrl ? String(route.baseUrl).replace(/\/+$/, '') : null,
    credentialSource: String(route.credentialSource || ''),
    credentialFingerprint: route.credentialFingerprint ? String(route.credentialFingerprint) : null,
    settings: route.settings ? String(route.settings) : null,
  };
}

export function effectiveRouteMatches(actual, expected) {
  const left = normalizedRoute(actual);
  const right = normalizedRoute(expected);
  if (!left || !right) return false;
  return (
    left.mode === right.mode &&
    left.baseUrl === right.baseUrl &&
    left.credentialSource === right.credentialSource &&
    left.credentialFingerprint === right.credentialFingerprint &&
    left.settings === right.settings
  );
}

function processEnvironment(pid) {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/environ`)
        .toString()
        .split('\0')
        .filter(Boolean)
        .reduce((env, entry) => {
          const split = entry.indexOf('=');
          if (split > 0) env[entry.slice(0, split)] = entry.slice(split + 1);
          return env;
        }, {});
    }
    const command = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const env = {};
    for (const entry of command.split(/\s+/)) {
      const split = entry.indexOf('=');
      if (split <= 0) continue;
      const key = entry.slice(0, split);
      if (
        [
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_API_BASE',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ].includes(key)
      ) {
        env[key] = entry.slice(split + 1);
      }
    }
    return env;
  } catch {
    return null;
  }
}

export function effectiveRouteFromProcess(pid, expectedSettings) {
  const env = processEnvironment(pid);
  if (!env) return null;
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '');
  const apiBase = String(env.ANTHROPIC_API_BASE || '');
  if (baseUrl && apiBase && baseUrl !== apiBase) return null;
  const effectiveBase = baseUrl || apiBase || null;
  const tokens = [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN].filter(Boolean);
  void expectedSettings;
  // Any base-URL override, or any relay-shaped token, means the child is not on
  // the direct OAuth route this module now guarantees.
  if (effectiveBase) return null;
  if (tokens.some((token) => isLegacyRelayToken(token))) return null;
  const directToken = tokens[0] || activeKeychainAccessToken();
  if (!directToken || tokens.some((token) => token !== directToken)) return null;
  return {
    mode: 'direct',
    baseUrl: null,
    credentialSource: tokens.length ? 'session-oauth' : 'keychain',
    credentialFingerprint: routeCredentialFingerprint(directToken),
    settings: null,
  };
}

function findNewLiveSession(id, oldPid, expectedRoute) {
  const found = listLiveBgSessions().find(
    (candidate) => String(candidate.id) === String(id) && candidate.pid !== oldPid && pidAlive(candidate.pid),
  );
  if (!found) return null;
  try {
    const sessionFile = readdirSync(SESSIONS_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => join(SESSIONS_DIR, file))
      .find((file) => {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        const valueId = value.jobId || value.sessionId || value.id;
        return String(valueId) === String(id) && Number(value.pid) === found.pid;
      });
    if (!sessionFile) return null;
    const record = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const processRoute = effectiveRouteFromProcess(found.pid, expectedRoute.settings);
    if (!effectiveRouteMatches(processRoute, expectedRoute)) return null;
    return effectiveRouteMatches(record.effectiveRoute, processRoute) ? found : null;
  } catch {
    return null;
  }
}

/** Enumerate live daemon-hosted bg sessions from ~/.claude/sessions/*.json. */
export function listLiveBgSessions() {
  const out = [];
  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
      if (s.kind !== 'bg') continue;
      const pid = Number(s.pid) || 0;
      if (!pidAlive(pid)) continue;
      if (pid === process.pid || pid === process.ppid) continue; // never respawn ourselves
      // Session-state files are PID-named, but `claude respawn` needs the job/
      // session id, NOT the PID. Resolve from file CONTENT (OS-agnostic, no
      // reliance on the PID filename): prefer jobId (short id in the fleet UI),
      // then full sessionId, then any explicit id; filename is last-resort only.
      const id = s.jobId || s.sessionId || s.id || f.replace(/\.json$/, '');
      out.push({ id, pid, status: s.status || 'unknown' });
    } catch {}
  }
  return out;
}

export function doRespawn(session, log, opts = {}) {
  const route = readRouteState();
  clearLegacyRelayArtifacts(log);
  if (route.mode === 'fail-closed') {
    // OPT-IN: a connection-wedged session must still be respawnable while the
    // route is fail-closed. The env scrub below strips any leaked base URL or
    // relay token, so the respawn boots cleanly on direct keychain OAuth — the
    // intended "fall back to local OAuth". Without the opt-in, keep refusing so
    // no existing caller (rotate.mjs post-rotation, daemon deferred sweep)
    // changes behavior.
    if (!opts.allowFailClosedDirect) {
      log(
        `[bg-respawn] route=fail-closed; refusing to respawn session ${session.id} without healthy OAuth or confirmed Bedrock`,
      );
      return false;
    }
    log(
      `[bg-respawn] route=fail-closed + allowFailClosedDirect — respawning session ${session.id} onto direct keychain OAuth`,
    );
  }

  // (resetTty is defined at module scope with process handler)
  const stateFile = join(homedir(), '.claude', 'jobs', String(session.id), 'state.json');
  let state = null;
  // Read the file rather than ask whether it exists. The reconciliation further
  // down rewrites this same path, and a stat here is a check that write would
  // then hang off. ENOENT says "no saved state" just as well; any other read
  // failure, or unparseable contents, leaves state null without claiming the
  // session is a spare — same as the two existsSync calls this replaces.
  let stateMissing = false;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    state = null;
    if (err.code === 'ENOENT') stateMissing = true;
  }
  if (stateMissing) {
    log(
      `[bg-respawn] session ${session.id} (pid ${session.pid}) has no saved state (spare) — terminating process to refresh`,
    );
    try {
      process.kill(session.pid, 'SIGTERM');
      try {
        // mode keeps the marker owner-only; the path under /tmp is predictable.
        writeFileSync(RESPAWNED_MARKER(session.id), String(Date.now()), { mode: 0o600 });
      } catch {}
      try {
        unlinkSync(DEFERRED_MARKER(session.id));
      } catch {}
      return true;
    } catch (e) {
      log(`[bg-respawn] failed to terminate spare session ${session.id} (pid ${session.pid}): ${e.message}`);
      return false;
    }
  }

  try {
    const childEnv = { ...process.env };
    let selectedDirectToken = null;
    let directCredentialSource = 'keychain';
    try {
      const config = readConfig();
      const tokenJson = getTokenForSession(session.id, config);
      const token = tokenJson ? extractAccessToken(tokenJson) : null;
      if (token) {
        selectedDirectToken = token;
        directCredentialSource = 'session-oauth';
        childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        delete childEnv.CLAUDE_CODE_USE_BEDROCK;
        delete childEnv.ANTHROPIC_MODEL;
        log(`[bg-respawn] Injecting CLAUDE_CODE_OAUTH_TOKEN for session ${session.id}`);
      } else {
        // BEDROCK FALLBACK DISABLED (2026-06-13): the prior else-branch injected
        // CLAUDE_CODE_USE_BEDROCK + the unservable `anthropic.claude-fable-5`,
        // which stranded sessions ("Claude Fable 5 is currently unavailable").
        // With no per-session token, respawn on the global keychain instead —
        // never boot a child onto Bedrock. Strip any inherited Bedrock env too.
        delete childEnv.CLAUDE_CODE_USE_BEDROCK;
        delete childEnv.ANTHROPIC_MODEL;
        log(
          `[bg-respawn] no per-session token for ${session.id}; respawning on global keychain (bedrock fallback disabled)`,
        );
      }
    } catch (err) {
      log(`[bg-respawn] Failed to retrieve session token: ${err.message}`);
    }

    // Every respawned session authenticates directly with its own OAuth token.
    // A retired relay backend used to override the base URL and inject a `cr_`
    // bearer token here; both are now stripped rather than set, so a leftover
    // pair inherited from settings.json or a parent env can never re-point a
    // child at a relay this plugin no longer manages.
    const scrubbed = [];
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE']) {
      if (isLegacyRelayBase(childEnv[key])) {
        delete childEnv[key];
        scrubbed.push(key);
      }
    }
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (isLegacyRelayToken(childEnv[key])) {
        delete childEnv[key];
        scrubbed.push(key);
      }
    }
    if (scrubbed.length) {
      log(`[bg-respawn] session ${session.id}: dropped leftover relay env (${scrubbed.join(', ')})`);
    }

    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.ANTHROPIC_API_BASE;
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    const effectiveEnvToken = String(childEnv.CLAUDE_CODE_OAUTH_TOKEN || '');
    if (effectiveEnvToken) {
      selectedDirectToken = effectiveEnvToken;
      directCredentialSource = 'session-oauth';
    } else if (!selectedDirectToken) {
      selectedDirectToken = activeKeychainAccessToken();
      directCredentialSource = 'keychain';
    }
    if (!selectedDirectToken) {
      preserveDeferredMarker(session.id);
      log(`[bg-respawn] cannot fingerprint intended direct credential for ${session.id}; deferring retry`);
      return false;
    }

    const expectedRoute = {
      mode: 'direct',
      baseUrl: null,
      credentialSource: directCredentialSource,
      credentialFingerprint: routeCredentialFingerprint(selectedDirectToken),
      settings: null,
    };
    childEnv.CLAUDE_OPS_EXPECTED_ROUTE = JSON.stringify(expectedRoute);

    // A relay session-settings overlay passed via --settings survives a respawn
    // because Claude Code re-reads it at startup. Drop it from the persisted
    // flags so an upgraded machine stops re-applying it.
    try {
      const originalFlags = Array.isArray(state.respawnFlags) ? state.respawnFlags : null;
      const flags = originalFlags ? normalizeClaudeModelArgs(originalFlags) : null;
      if (flags) {
        const isLegacySettingsVal = (v) => typeof v === 'string' && v.endsWith(LEGACY_SESSION_SETTINGS_SUFFIX);
        let mutated = flags.some((flag, index) => flag !== originalFlags[index]);
        for (let i = flags.length - 1; i >= 0; i--) {
          if (flags[i] === '--settings' && isLegacySettingsVal(flags[i + 1])) {
            flags.splice(i, 2);
            mutated = true;
            log(`[bg-respawn] session ${session.id}: removed --settings relay overlay from respawnFlags`);
          }
        }
        if (mutated) {
          state.respawnFlags = flags;
          writeJsonAtomic(stateFile, state);
        }
      }
    } catch (err) {
      log(`[bg-respawn] RECONCILE: failed to reconcile respawnFlags for ${session.id}: ${err.message}`);
    }


    let respawnOut = '';
    try {
      respawnOut = execFileSync(claudeBin(), ['respawn', String(session.id)], {
        timeout: 30_000,
        stdio: 'pipe',
        env: childEnv,
      }).toString();
    } catch (e) {
      try {
        respawnOut = Buffer.concat(
          [e.stdout, e.stderr]
            .filter((part) => part !== undefined && part !== null)
            .map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part)))),
        ).toString();
      } catch {}
      if (respawnOut) {
        try {
          const LOGP = join(__dirname, 'bg-respawn.out.log');
          appendFileSync(LOGP, `[${new Date().toISOString()}] ${session.id}: ${respawnOut.slice(0, 2000)}\n`);
        } catch {}
      }
      preserveDeferredMarker(session.id);
      log(`[bg-respawn] respawn command failed for ${session.id}: ${String(e.message || e).slice(0, 120)}`);
      return false;
    }
    if (respawnOut && respawnOut.length > 0) {
      try {
        const LOGP = join(__dirname, 'bg-respawn.out.log');
        appendFileSync(LOGP, `[${new Date().toISOString()}] ${session.id}: ${respawnOut.slice(0, 2000)}\n`);
      } catch {}
    }
    if (!respawnStateCoherent(stateFile)) {
      preserveDeferredMarker(session.id);
      log(`[bg-respawn] respawn state verification failed for ${session.id}; deferring retry`);
      return false;
    }
    let liveRespawn = null;
    for (let i = 0; i < 20; i++) {
      liveRespawn = findNewLiveSession(session.id, session.pid, expectedRoute);
      if (liveRespawn) break;
      sleepSync(100);
    }
    if (!liveRespawn) {
      preserveDeferredMarker(session.id);
      log(`[bg-respawn] no verified new live PID/effective route for ${session.id}; deferring retry`);
      return false;
    }
    try {
      writeFileSync(RESPAWNED_MARKER(session.id), String(Date.now()), { mode: 0o600 });
    } catch {}
    try {
      unlinkSync(DEFERRED_MARKER(session.id));
    } catch {}
    log(
      `[bg-respawn] respawned bg session ${session.id} (new pid ${liveRespawn.pid}, old pid ${session.pid}, was ${session.status})`,
    );

    try {
      const lease = readLeases()[session.id];
      if (lease) recordSessionLease(session.id, lease.accountKey, liveRespawn.pid);
    } catch (err) {
      log(`[bg-respawn] Error updating lease with new PID: ${err.message}`);
    }

    return true;
  } catch (e) {
    log(`[bg-respawn] respawn ${session.id} failed: ${e.message?.slice(0, 80)}`);
    resetTty();
    return false;
  }
}

/**
 * Post-rotation pass: respawn idle/waiting bg sessions so they pick up the
 * new keychain token; defer busy ones to the daemon sweep.
 */
export function respawnBgSessions(log = () => {}) {
  const sessions = listLiveBgSessions();
  if (sessions.length === 0) {
    log('[bg-respawn] no live bg sessions to refresh');
    return { respawned: 0, deferred: 0 };
  }
  let respawned = 0;
  let deferred = 0;
  for (const s of sessions) {
    if (markerFresh(RESPAWNED_MARKER(s.id), RESPAWN_THROTTLE_MS)) {
      log(`[bg-respawn] ${s.id} respawned <10min ago — skipping`);
      continue;
    }
    if (s.status === 'busy') {
      try {
        // 'wx' creates the marker in one step, so a second process cannot slip in
        // between a check and the write. EEXIST just means the marker is already
        // there, which is the same outcome we wanted. mode keeps it owner-only.
        writeFileSync(DEFERRED_MARKER(s.id), String(Date.now()), { flag: 'wx', mode: 0o600 });
      } catch {}
      deferred++;
      log(`[bg-respawn] ${s.id} busy — deferred (daemon sweep will retry, force after 90min)`);
      continue;
    }
    // Graceful rotation-over: space respawns so the fleet doesn't all re-auth
    // onto the new account at once. Gap only between real respawns.
    if (respawned > 0) sleepSync(SESSION_STAGGER_MS);
    if (doRespawn(s, log)) respawned++;
  }
  return { respawned, deferred };
}

/**
 * Daemon sweep: retry deferred (busy-at-rotation-time) sessions. Respawns when
 * the session goes idle/waiting, force-respawns if it stayed busy past
 * BUSY_FORCE_AFTER_MS, and clears markers for sessions that exited.
 */
export function sweepDeferredRespawns(log = () => {}) {
  let markers = [];
  try {
    markers = readdirSync('/tmp').filter((f) => f.startsWith('claude-respawn-deferred-'));
  } catch {
    return 0;
  }
  if (markers.length === 0) return 0;
  const live = new Map(listLiveBgSessions().map((s) => [String(s.id), s]));
  let handled = 0;
  for (const m of markers) {
    const id = m.replace('claude-respawn-deferred-', '');
    const markerPath = `/tmp/${m}`;
    const s = live.get(id);
    if (!s) {
      // session exited or state file gone — nothing to refresh
      try {
        unlinkSync(markerPath);
      } catch {}
      continue;
    }
    const deferredAgo = (() => {
      try {
        return Date.now() - statSync(markerPath).mtimeMs;
      } catch {
        return 0;
      }
    })();
    if (s.status !== 'busy' || deferredAgo > BUSY_FORCE_AFTER_MS) {
      if (s.status === 'busy') {
        log(
          `[bg-respawn] ${id} still busy after ${Math.round(deferredAgo / 60000)}min — force-respawning before token expiry`,
        );
      }
      // Graceful rotation-over: space respawns so a deferred batch doesn't all
      // re-auth onto the new account in the same instant.
      if (handled > 0) sleepSync(SESSION_STAGGER_MS);
      if (doRespawn(s, log)) handled++;
    }
  }
  return handled;
}
