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
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getTokenForSession, extractAccessToken, readLeases, recordSessionLease } from './session-router.mjs';

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

// /loop sessions are idle BY DESIGN between iterations, and their loop timer
// (CronCreate/ScheduleWakeup) is session-only — a respawn wipes it and the
// loop never fires again (observed 2026-06-12: logmonitor 41e6eaf0 killed
// every ~10min by the idle-respawn pass, 15m loop never survived to fire).
// Treat them like busy: defer, force-respawn only after BUSY_FORCE_AFTER_MS.
export function isLoopSession(id) {
  let st;
  try {
    st = JSON.parse(
      readFileSync(join(homedir(), '.claude', 'jobs', String(id), 'state.json'), 'utf8'),
    );
  } catch {
    return false;
  }
  if (/^\/loop\b/.test(st.detail || '')) return true;
  // `detail` is the live narration line and gets overwritten — the durable
  // signal is a /loop invocation (or autonomous-loop sentinel) in the
  // transcript. Scan the tail only (loops re-arm near the end).
  const transcript =
    st.linkScanPath ||
    (st.sessionId &&
      join(
        homedir(),
        '.claude',
        'projects',
        String(st.cwd || st.originCwd || '').replace(/\//g, '-'),
        `${st.sessionId}.jsonl`,
      ));
  if (!transcript || !existsSync(transcript)) return false;
  try {
    const size = statSync(transcript).size;
    const TAIL = 1024 * 1024; // 1MB tail
    const fd = openSync(transcript, 'r');
    const buf = Buffer.alloc(Math.min(TAIL, size));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    closeSync(fd);
    const tail = buf.toString('utf8');
    return tail.includes('<<autonomous-loop') || tail.includes('<command-name>/loop</command-name>');
  } catch {
    return false;
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

export function doRespawn(session, log) {
  const stateFile = join(homedir(), '.claude', 'jobs', String(session.id), 'state.json');
  if (!existsSync(stateFile)) {
    log(
      `[bg-respawn] session ${session.id} (pid ${session.pid}) has no saved state (spare) — terminating process to refresh`,
    );
    try {
      process.kill(session.pid, 'SIGTERM');
      try {
        writeFileSync(RESPAWNED_MARKER(session.id), String(Date.now()));
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
    try {
      const config = readConfig();
      const tokenJson = getTokenForSession(session.id, config);
      const token = tokenJson ? extractAccessToken(tokenJson) : null;
      if (token) {
        childEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        delete childEnv.CLAUDE_CODE_USE_BEDROCK;
        log(`[bg-respawn] Injecting CLAUDE_CODE_OAUTH_TOKEN for session ${session.id}`);
      } else {
        const leases = readLeases();
        if (leases[session.id]?.accountKey === 'bedrock') {
          childEnv.CLAUDE_CODE_USE_BEDROCK = "1";
          childEnv.AWS_BEDROCK_REGION = "us-east-1";
          childEnv.AWS_REGION = "us-east-1";
          childEnv.ANTHROPIC_MODEL = "anthropic.claude-fable-5";
          delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
          log(`[bg-respawn] Injecting Bedrock Fallback variables for session ${session.id}`);
        }
      }
    } catch (err) {
      log(`[bg-respawn] Failed to retrieve session token: ${err.message}`);
    }

    execFileSync(claudeBin(), ['respawn', String(session.id)], {
      timeout: 30_000,
      stdio: 'pipe',
      env: childEnv,
    });
    try {
      writeFileSync(RESPAWNED_MARKER(session.id), String(Date.now()));
    } catch {}
    try {
      unlinkSync(DEFERRED_MARKER(session.id));
    } catch {}
    log(`[bg-respawn] respawned bg session ${session.id} (pid ${session.pid}, was ${session.status})`);

    // Synchronously resolve new PID and update the lease
    try {
      const leases = readLeases();
      const lease = leases[session.id];
      if (lease) {
        let newPid = null;
        for (let i = 0; i < 20; i++) {
          try {
            execSync('sleep 0.5');
          } catch {}
          const live = listLiveBgSessions();
          const found = live.find(ls => String(ls.id) === String(session.id));
          if (found && found.pid !== session.pid) {
            newPid = found.pid;
            break;
          }
        }
        if (newPid) {
          log(`[bg-respawn] Updated lease for session ${session.id} with new PID ${newPid}`);
          recordSessionLease(session.id, lease.accountKey, newPid);
        } else {
          log(`[bg-respawn] Warning: could not resolve new PID for session ${session.id}`);
        }
      }
    } catch (err) {
      log(`[bg-respawn] Error updating lease with new PID: ${err.message}`);
    }

    return true;
  } catch (e) {
    log(`[bg-respawn] respawn ${session.id} failed: ${e.message?.slice(0, 80)}`);
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
    if (s.status === 'busy' || isLoopSession(s.id)) {
      try {
        if (!existsSync(DEFERRED_MARKER(s.id))) writeFileSync(DEFERRED_MARKER(s.id), String(Date.now()));
      } catch {}
      deferred++;
      log(
        `[bg-respawn] ${s.id} ${s.status === 'busy' ? 'busy' : 'has an armed /loop'} — deferred (daemon sweep will retry, force after 90min)`,
      );
      continue;
    }
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
    const protectedNow = s.status === 'busy' || isLoopSession(id);
    if (!protectedNow || deferredAgo > BUSY_FORCE_AFTER_MS) {
      if (protectedNow) {
        log(
          `[bg-respawn] ${id} still ${s.status === 'busy' ? 'busy' : 'looping'} after ${Math.round(deferredAgo / 60000)}min — force-respawning before token expiry`,
        );
      }
      if (doRespawn(s, log)) handled++;
    }
  }
  return handled;
}
