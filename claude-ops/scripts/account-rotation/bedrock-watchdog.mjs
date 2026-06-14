// bedrock-watchdog.mjs — force real Bedrock sessions back to OAuth, no defer.
//
// The deferred-respawn sweep (bg-respawn.sweepDeferredRespawns) defers busy and
// /loop sessions for up to BUSY_FORCE_AFTER_MS (~90 min) before force-respawning.
// For OAuth→OAuth token refreshes that's fine. For a session bleeding METERED
// Bedrock spend it's a 90-minute leak. owner directive (2026-06-14): "Bedrock
// should never be in use if any /rotate OAuth account has tokens available."
//
// This watchdog detects sessions actually running inference on Bedrock (by
// reading /proc/<pid>/environ for CLAUDE_CODE_USE_BEDROCK=1) and FORCE-swaps
// them to OAuth immediately — no 90-min defer — whenever any account has a
// usable token. It is sandbox-safe: /proc reads that fail are skipped, never
// fatal, and the network corroboration layer (scanBedrockNetwork) degrades to
// a graceful "unknown" rather than ever false-alarming.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

import { listLiveBgSessions, doRespawn } from './bg-respawn.mjs';
import { pickAccountForSession, recordSessionLease } from './session-router.mjs';

const PROC = '/proc';

// Infra/transient session arg-markers that inherit the Bedrock env but do NOT
// run real inference — never worth a force-swap.
const SKIP_ARG_MARKERS = ['--bg-pty-host', '--bg-spare'];
const SKIP_CMD_SUBSTRINGS = ['auth login']; // `claude auth login` etc.

/** Read /proc/<pid>/environ into a {KEY:VALUE} map. Returns null if unreadable. */
function readProcEnviron(pid) {
  try {
    const raw = readFileSync(`${PROC}/${pid}/environ`, 'utf8');
    const env = {};
    for (const pair of raw.split('\0')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/** Read /proc/<pid>/cmdline as a single space-joined string. '' if unreadable. */
function readProcCmdline(pid) {
  try {
    return readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/**
 * Scan every ec2-user `claude` process whose /proc environ has
 * CLAUDE_CODE_USE_BEDROCK=1, skipping infra (--bg-pty-host, --bg-spare) and
 * transient (auth login) processes.
 * @returns {Array<{pid:number, sessionId:string|null, cmdline:string}>}
 */
export function scanBedrockSessions() {
  const out = [];
  let pids = [];
  try {
    pids = readdirSync(PROC).filter((f) => /^\d+$/.test(f));
  } catch {
    return out; // /proc unreadable (non-Linux / sandbox) — nothing to do.
  }
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid === process.pid || pid === process.ppid) continue;
    const cmdline = readProcCmdline(pid);
    if (!cmdline || !/\bclaude\b/.test(cmdline)) continue;
    if (SKIP_ARG_MARKERS.some((m) => cmdline.includes(m))) continue;
    if (SKIP_CMD_SUBSTRINGS.some((m) => cmdline.includes(m))) continue;

    const env = readProcEnviron(pid);
    if (!env) continue;
    if (env.CLAUDE_CODE_USE_BEDROCK !== '1') continue;

    out.push({
      pid,
      sessionId: env.CLAUDE_CODE_SESSION_ID || null,
      cmdline,
    });
  }
  return out;
}

/**
 * Best-effort: which of the given PIDs have a LIVE established connection to a
 * Bedrock-runtime endpoint (port 443 to an AWS range, reverse-resolving to
 * bedrock-runtime). Used only to CORROBORATE env detection and to VALIDATE that
 * traffic stopped after a swap — NEVER as the sole trigger.
 *
 * Sandbox-safe: `ss` can be socket-blind in a sandboxed shell on FRA (see memory
 * sandboxed-ss-port-checks-blind). On any failure / empty output this returns
 * { available:false, pids:new Set() } so callers treat it as "unknown" and never
 * false-alarm.
 *
 * @param {number[]} [pids] optional filter; when omitted, all matching are returned
 * @returns {{available:boolean, pids:Set<number>}}
 */
export function scanBedrockNetwork(pids) {
  const want = pids && pids.length ? new Set(pids.map(Number)) : null;
  let raw = '';
  try {
    // -t tcp, -n numeric, -p processes, state established.
    raw = execFileSync('ss', ['-tnp', 'state', 'established'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { available: false, pids: new Set() };
  }
  if (!raw || !raw.trim()) {
    // ss ran but returned nothing — could be genuinely no connections OR
    // socket-blind. Either way we can't assert traffic, so signal "unknown".
    return { available: false, pids: new Set() };
  }

  // Bedrock-runtime resolves into AWS ranges; we can't reverse-resolve every IP
  // cheaply, so match on the well-known bedrock-runtime hostname when present in
  // the line, else fall back to :443 peers owned by a claude pid. This is
  // corroboration only — a miss never blocks a swap.
  const found = new Set();
  for (const line of raw.split('\n')) {
    if (!line.includes(':443')) continue;
    const isBedrock = /bedrock-runtime/i.test(line);
    const m = line.match(/pid=(\d+)/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (want && !want.has(pid)) continue;
    if (isBedrock) found.add(pid);
  }
  // If we couldn't positively identify any bedrock-runtime peer by name, report
  // unavailable rather than guessing from bare :443 (avoids false-alarm).
  if (found.size === 0) return { available: false, pids: new Set() };
  return { available: true, pids: found };
}

/**
 * Is this session protected by a hot-swap hold marker?
 * (touch /tmp/claude-hotswap-hold-<pid> — see memory hotswap-hold-protection)
 */
function hasHotSwapHold(pid) {
  return existsSync(`/tmp/claude-hotswap-hold-${pid}`);
}

/**
 * Force every real Bedrock session back to OAuth when a usable token exists.
 * No defer for Bedrock — metered bleed overrides loop/busy preservation.
 *
 * @param {object} config rotation config (config.accounts)
 * @param {object} state  rotation state (utilization cache)
 * @param {(msg:string)=>void} log
 * @returns {{swapped:number, scanned:number, swappedPids:number[]}}
 */
export function sweepBedrockSessions(config, state, log) {
  const sessions = scanBedrockSessions();
  if (sessions.length === 0) return { swapped: 0, scanned: 0, swappedPids: [] };

  // Map PID → live bg-session record (id needed for `claude respawn <id>`).
  const live = listLiveBgSessions();
  const byPid = new Map(live.map((s) => [Number(s.pid), s]));

  let swapped = 0;
  const swappedPids = [];

  for (const sess of sessions) {
    // Is an OAuth account actually available? pickAccountForSession returns
    // 'bedrock' only when ZERO accounts have a usable token (true last resort).
    const sid = sess.sessionId || (byPid.get(sess.pid) && byPid.get(sess.pid).id) || `pid-${sess.pid}`;
    const target = pickAccountForSession(sid, config, state);
    if (!target || target === 'bedrock') {
      // No OAuth headroom anywhere — Bedrock is the legitimate fallback. Leave it.
      continue;
    }

    const bgSession = byPid.get(sess.pid);
    if (!bgSession) {
      // Bedrock claude PID with no resolvable bg-session record — can't respawn
      // it by id (could be a foreground/--resume host). Log loudly; skip.
      log(
        `[bedrock-watchdog] pid ${sess.pid} on Bedrock but no bg-session id resolved — cannot force-swap (OAuth target=${target})`,
      );
      continue;
    }

    if (hasHotSwapHold(sess.pid)) {
      // Honor the hold, but warn loudly — a held session is still bleeding Bedrock.
      log(
        `[bedrock-watchdog] ⚠️ session ${bgSession.id} (pid ${sess.pid}) is hot-swap HELD but STILL ON METERED BEDROCK (OAuth target=${target} available) — leaving per hold marker, but money is bleeding`,
      );
      continue;
    }

    // FORCE swap now. Do NOT defer busy/loop sessions for Bedrock.
    try {
      recordSessionLease(bgSession.id, target, bgSession.pid);
      log(
        `[bedrock-watchdog] FORCE-swapping ${bgSession.id} (pid ${sess.pid}, status ${bgSession.status}) Bedrock→OAuth ${target} (no defer — metered)`,
      );
      doRespawn(bgSession, log);
      swapped++;
      swappedPids.push(sess.pid);
    } catch (e) {
      log(`[bedrock-watchdog] force-swap of ${bgSession.id} failed: ${e.message?.slice(0, 100)}`);
    }
  }

  return { swapped, scanned: sessions.length, swappedPids };
}

/**
 * Post-swap verification: confirm the (old) swapped PIDs are no longer on
 * Bedrock. Reads /proc environ (authoritative) and corroborates with the
 * network scan when it is available. Logs results; returns a summary.
 *
 * @param {number[]} swappedPids PIDs we force-swapped on the previous sweep
 * @param {(msg:string)=>void} log
 * @returns {{stillBedrock:number[], cleared:number[]}}
 */
export function verifyBedrockSwaps(swappedPids, log) {
  const stillBedrock = [];
  const cleared = [];
  for (const pid of swappedPids) {
    const env = readProcEnviron(pid);
    if (env === null) {
      // PID gone (respawn re-execs into a NEW pid) — the old Bedrock process is
      // dead, which is exactly what we want.
      cleared.push(pid);
      continue;
    }
    if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
      stillBedrock.push(pid);
    } else {
      cleared.push(pid);
    }
  }
  if (stillBedrock.length) {
    const net = scanBedrockNetwork(stillBedrock);
    const detail = net.available
      ? ` (live bedrock-runtime traffic on: ${[...net.pids].join(',') || 'none'})`
      : ' (network corroboration unavailable)';
    log(
      `[bedrock-watchdog] post-swap VERIFY: ${stillBedrock.length} pid(s) still report USE_BEDROCK=1: ${stillBedrock.join(',')}${detail}`,
    );
  } else if (swappedPids.length) {
    log(`[bedrock-watchdog] post-swap VERIFY: all ${swappedPids.length} swapped pid(s) off Bedrock`);
  }
  return { stillBedrock, cleared };
}
