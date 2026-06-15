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

import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';

import { listLiveBgSessions, doRespawn } from './bg-respawn.mjs';
import { pickAccountForSession, recordSessionLease } from './session-router.mjs';

const PROC = '/proc';

// Transient processes that never run billable session inference.
// NOTE: `--bg-spare`/`--bg-pty-host` are intentionally NOT blanket-skipped here
// (a claimed spare keeps its `--bg-spare` marker forever); the scan skips them
// only when no Bedrock signal is present. See scanBedrockSessions.
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
 * Build a one-shot parent→children map of every /proc pid. Used to probe a
 * node session's child subshells for the RUNTIME Bedrock signal (see below).
 * O(P) — built once per sweep, not per session.
 */
function buildChildMap() {
  const kids = new Map(); // ppid -> [pid,...]
  let pids = [];
  try {
    pids = readdirSync(PROC).filter((f) => /^\d+$/.test(f));
  } catch {
    return kids;
  }
  for (const p of pids) {
    try {
      const stat = readFileSync(`${PROC}/${p}/stat`, 'utf8');
      // Format: `pid (comm) state ppid ...`; comm may contain spaces/parens,
      // so anchor on the LAST ')' then take field[1] (ppid) after state.
      const rp = stat.lastIndexOf(')');
      if (rp === -1) continue;
      const fields = stat.slice(rp + 2).split(' ');
      const ppid = Number(fields[1]);
      if (!Number.isFinite(ppid)) continue;
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(p));
    } catch {}
  }
  return kids;
}

/**
 * RUNTIME Bedrock detection. /proc/<pid>/environ is the EXEC-TIME snapshot only;
 * a node session that read CLAUDE_CODE_USE_BEDROCK=1 from settings.json at
 * startup (a past fallback window) carries it in its live process.env but NOT in
 * /proc/environ — invisible to the exec-env scan. That runtime value IS what
 * inference uses (the real metered bill) AND is inherited by every child
 * subshell the session spawns. So we probe the session's direct children: if any
 * child's /proc/environ has USE_BEDROCK=1, the parent's runtime env has it too.
 * Returns the first leaking child pid, or null.
 */
function runtimeBedrockChild(pid, childMap) {
  for (const kid of childMap.get(pid) || []) {
    const env = readProcEnviron(kid);
    if (env && env.CLAUDE_CODE_USE_BEDROCK === '1') return kid;
  }
  return null;
}

/**
 * Scan every ec2-user `claude` process on Bedrock — by EXEC env
 * (CLAUDE_CODE_USE_BEDROCK=1 in /proc/environ) OR by RUNTIME env (a child
 * subshell carries it; see runtimeBedrockChild). Transient `auth login`
 * processes are always skipped.
 *
 * The `--bg-spare` / `--bg-pty-host` arg-markers are NOT a blanket skip: a
 * claimed spare KEEPS `--bg-spare` in its cmdline even after it becomes a live,
 * inference-running session (the marker is never rewritten), so blanket-skipping
 * it permanently hides a real leaker (root cause of the fcfcc869 opus leak). We
 * only skip those markers when there is NO Bedrock signal at all — i.e. a
 * passive spare that merely inherited the env but isn't running inference. The
 * moment a runtime (or exec) Bedrock signal is present, it is a real leak and
 * gets reported regardless of the spare/pty marker.
 * @returns {Array<{pid:number, sessionId:string|null, cmdline:string, via:'exec'|'runtime', childPid:number|null}>}
 */
export function scanBedrockSessions() {
  const out = [];
  let pids = [];
  try {
    pids = readdirSync(PROC).filter((f) => /^\d+$/.test(f));
  } catch {
    return out; // /proc unreadable (non-Linux / sandbox) — nothing to do.
  }
  const childMap = buildChildMap();
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid === process.pid || pid === process.ppid) continue;
    const cmdline = readProcCmdline(pid);
    // A swap CANDIDATE is a Claude SESSION node process (daemon-hosted bg
    // sessions run `.../share/claude/versions/<ver> …`, foreground runs the
    // claude bin directly). Shell/bun children (gstack browse, `bash -c`, mac
    // helpers) inherit the Bedrock env but are NOT swappable sessions — they
    // serve only as the runtime-env PROBE (runtimeBedrockChild), never as
    // candidates. Matching the broad `.claude/` path substring here emitted
    // those children as bogus, un-respawnable hits.
    if (!cmdline) continue;
    const isSessionProc = /share\/claude\/versions\//.test(cmdline) || /(^|\/)claude(\s|$)/.test(cmdline);
    if (!isSessionProc) continue;
    if (SKIP_CMD_SUBSTRINGS.some((m) => cmdline.includes(m))) continue;

    const env = readProcEnviron(pid);
    if (!env) continue; // unreadable environ → can't resolve a session id anyway
    const execBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
    const childPid = execBedrock ? null : runtimeBedrockChild(pid, childMap);
    const hasBedrock = execBedrock || childPid !== null;

    // Passive inheritor (spare/pty-host with NO actual Bedrock inference) — skip.
    // A real leaker (runtime or exec signal) is reported even if it's a spare.
    if (!hasBedrock) continue;

    out.push({
      pid,
      sessionId: env.CLAUDE_CODE_SESSION_ID || null,
      cmdline,
      via: execBedrock ? 'exec' : 'runtime',
      childPid,
    });
  }
  return out;
}

// Regions where `us.anthropic.*` inference profiles + nearby Bedrock endpoints
// land. Resolved IPs are unioned; DNS rotates so we re-resolve on a short TTL.
const BEDROCK_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-2'];
let _bedrockIpCache = { ips: new Set(), at: 0 };
const BEDROCK_IP_TTL_MS = 5 * 60_000;

/**
 * Resolve the current bedrock-runtime endpoint IPs across BEDROCK_REGIONS.
 * Cached for BEDROCK_IP_TTL_MS (DNS rotates the A records). On total failure
 * returns whatever is cached (possibly empty) — callers degrade to no-op, never
 * false-alarm.
 * @returns {Set<string>}
 */
function resolveBedrockIps() {
  const now = Date.now();
  if (_bedrockIpCache.ips.size && now - _bedrockIpCache.at < BEDROCK_IP_TTL_MS) {
    return _bedrockIpCache.ips;
  }
  const ips = new Set();
  for (const r of BEDROCK_REGIONS) {
    try {
      const out = execFileSync('getent', ['ahosts', `bedrock-runtime.${r}.amazonaws.com`], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        const ip = line.trim().split(/\s+/)[0];
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) ips.add(ip);
      }
    } catch {}
  }
  if (ips.size) _bedrockIpCache = { ips, at: now };
  return ips.size ? ips : _bedrockIpCache.ips;
}

/**
 * Which PIDs hold a LIVE established TCP connection to a bedrock-runtime IP.
 * THIS IS A VALID STANDALONE TRIGGER (2026-06-15): an established TLS socket to
 * a bedrock-runtime endpoint is ground truth that the owning process is billing
 * Bedrock right now — there is no false-positive (you cannot hold that socket
 * without using Bedrock). It catches the case the env/child probes miss: a busy
 * inference session with runtime CLAUDE_CODE_USE_BEDROCK=1 but NO live child
 * subshell at scan time (root cause of the 7f1abe98 leak the env-scan reported
 * clean — proven by a live `ss` network trace). The old hostname-regex matcher
 * was dead: `ss -tn` prints numeric peers, so /bedrock-runtime/ never matched.
 *
 * Matching is by peer IP against the resolved bedrock-runtime IP set. `ss` can
 * be socket-blind in a sandboxed shell (memory sandboxed-ss-port-checks-blind);
 * on any failure / empty output / unresolvable IPs this returns
 * { available:false, pids:new Set() } so callers treat it as "unknown" — a miss
 * never blocks anything, it just degrades to the env/child path.
 *
 * @param {number[]} [pids] optional filter; when omitted, all matching pids returned
 * @returns {{available:boolean, pids:Set<number>}}
 */
export function scanBedrockNetwork(pids) {
  const want = pids && pids.length ? new Set(pids.map(Number)) : null;
  const bedrockIps = resolveBedrockIps();
  if (!bedrockIps.size) return { available: false, pids: new Set() }; // can't resolve → unknown
  // `ss -tnp` only attributes pids for the caller's OWN sockets, and can be
  // socket-blind under sandboxing. Prefer `sudo -n ss` (passwordless sudo is
  // provisioned for ec2-user) for full pid visibility across every session;
  // fall back to plain `ss` (works unprivileged for the daemon's own user when
  // not sandboxed). Either way, no-pid output → available:false (degrade).
  let raw = '';
  for (const argv of [
    ['sudo', ['-n', 'ss', '-tnp', 'state', 'established']],
    ['ss', ['-tnp', 'state', 'established']],
  ]) {
    try {
      raw = execFileSync(argv[0], argv[1], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (raw && raw.trim()) break;
    } catch {
      raw = '';
    }
  }
  if (!raw || !raw.trim()) return { available: false, pids: new Set() };

  const found = new Set();
  let sawAnyPid = false;
  for (const line of raw.split('\n')) {
    if (!line.includes(':443')) continue;
    // Peer address is the 2nd host:port column. Match the LAST IP:443 on the line
    // (local addr could also be :443 in rare cases; peer is rightmost).
    const peers = [...line.matchAll(/(\d+\.\d+\.\d+\.\d+):443\b/g)];
    if (!peers.length) continue;
    const peerIp = peers[peers.length - 1][1];
    if (!bedrockIps.has(peerIp)) continue;
    const m = line.match(/pid=(\d+)/);
    if (m) {
      sawAnyPid = true;
      const pid = Number(m[1]);
      if (want && !want.has(pid)) continue;
      found.add(pid);
    }
  }
  // If we matched bedrock peers but `ss` showed no pid= (no CAP_NET_ADMIN /
  // socket-blind), we can't attribute them — report unavailable rather than
  // returning an empty positive that looks like "clean".
  if (found.size === 0 && !sawAnyPid) return { available: false, pids: new Set() };
  return { available: found.size > 0, pids: found };
}

/**
 * Walk a PID up its parent chain to the nearest live bg-session PID. Lets a
 * bedrock connection owned by a child `claude`/shell process be attributed to
 * the session that spawned it. Returns the bg-session record or null.
 */
function ancestorBgSession(pid, byPid, ppidMap) {
  let cur = pid;
  for (let hops = 0; cur && cur > 1 && hops < 30; hops++) {
    if (byPid.has(cur)) return byPid.get(cur);
    cur = ppidMap.get(cur) || 0;
  }
  return null;
}

/** Build a child→parent PID map from /proc (one pass). */
function buildPpidMap() {
  const m = new Map();
  let pids = [];
  try {
    pids = readdirSync(PROC).filter((f) => /^\d+$/.test(f));
  } catch {
    return m;
  }
  for (const p of pids) {
    try {
      const stat = readFileSync(`${PROC}/${p}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      if (rp === -1) continue;
      const ppid = Number(stat.slice(rp + 2).split(' ')[1]);
      if (Number.isFinite(ppid)) m.set(Number(p), ppid);
    } catch {}
  }
  return m;
}

// ── Per-session offender flag (drives the PreToolUse bedrock-billing-guard) ────
// The guard hook keys off `session_id.slice(0,8)`, which equals the bg-session
// short id (jobId = first 8 hex of the session UUID). Writing this flag makes a
// session MEASURED on Bedrock get a blocking error in its OWN loop (dismissable
// only by explicit `echo BEDROCK-ACK`). Cleared once the session is swapped off.
const OFFENDER_FLAG = (shortId) => `/tmp/claude-bedrock-offender-${shortId}`;
function offenderShortId(sessionId) {
  const s = String(sessionId || '');
  return s ? s.slice(0, 8) : '';
}
function writeOffenderFlag(sessionId, via) {
  const shortId = offenderShortId(sessionId);
  if (!shortId) return;
  try {
    writeFileSync(OFFENDER_FLAG(shortId), `measured via ${via || 'env'} by rotation watchdog — metered AWS Bedrock`);
  } catch {}
}
function clearOffenderFlag(sessionId) {
  const shortId = offenderShortId(sessionId);
  if (!shortId) return;
  try {
    unlinkSync(OFFENDER_FLAG(shortId));
  } catch {}
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
  // (a) exec-env + runtime-child detection over claude session node procs.
  const envSessions = scanBedrockSessions();

  // Map PID → live bg-session record (id needed for `claude respawn <id>`).
  const live = listLiveBgSessions();
  const byPid = new Map(live.map((s) => [Number(s.pid), s]));

  // (b) NETWORK detection — a valid STANDALONE trigger. An established TCP
  // socket to a bedrock-runtime IP is ground truth that the owning process is
  // billing Bedrock now. Catches busy inference sessions whose runtime env has
  // CLAUDE_CODE_USE_BEDROCK=1 but which have NO live child subshell at scan time
  // (the env/child probe reports them clean — proven by the 7f1abe98 leak the
  // env-scan missed but a live `ss` trace caught). The connection may be owned by
  // a transient child `claude`/shell; attribute it to its ancestor bg-session.
  const netCandidates = [];
  try {
    const net = scanBedrockNetwork();
    if (net.available && net.pids.size) {
      const ppidMap = buildPpidMap();
      const seen = new Set();
      for (const connPid of net.pids) {
        const bg = ancestorBgSession(connPid, byPid, ppidMap);
        if (bg && !seen.has(Number(bg.pid))) {
          seen.add(Number(bg.pid));
          netCandidates.push({ pid: Number(bg.pid), sessionId: null, via: 'network', childPid: connPid });
        }
      }
    }
  } catch {}

  // Union env/child + network candidates, keyed by bg-session node pid.
  const candidatesByPid = new Map();
  for (const s of envSessions) candidatesByPid.set(s.pid, s);
  for (const s of netCandidates) if (!candidatesByPid.has(s.pid)) candidatesByPid.set(s.pid, s);
  const sessions = [...candidatesByPid.values()];
  if (sessions.length === 0) return { swapped: 0, scanned: 0, swappedPids: [] };

  let swapped = 0;
  const swappedPids = [];

  for (const sess of sessions) {
    const bgSession = byPid.get(sess.pid);

    // Flag the MEASURED session so its own PreToolUse bedrock-billing-guard fires
    // (the agent gets a blocking error it must explicitly ack). Written for every
    // measured Bedrock session — including the no-OAuth last-resort case below,
    // where the agent stays on Bedrock and must consciously acknowledge the spend.
    if (bgSession) writeOffenderFlag(bgSession.id, sess.via);

    // Is an OAuth account actually available? pickAccountForSession returns
    // 'bedrock' only when ZERO accounts have a usable token (true last resort).
    const sid = sess.sessionId || (bgSession && bgSession.id) || `pid-${sess.pid}`;
    const target = pickAccountForSession(sid, config, state);
    if (!target || target === 'bedrock') {
      // No OAuth headroom anywhere — Bedrock is the legitimate fallback. Leave it
      // (and leave the offender flag so the agent's guard makes it ack the spend).
      continue;
    }

    if (!bgSession) {
      // Bedrock claude PID with no resolvable bg-session record — can't respawn
      // it by id (could be a foreground/--resume host). Log loudly; skip.
      log(
        `[bedrock-watchdog] pid ${sess.pid} on Bedrock but no bg-session id resolved — cannot force-swap (OAuth target=${target})`,
      );
      continue;
    }

    // Hot-swap hold does NOT protect a METERED Bedrock leak (owner directive
    // 2026-06-15: "it should not be a no-op … actually swap out any bedrock /
    // metered usage directly if OAuth is at all available"). The hold exists to
    // preserve OAuth→OAuth refreshes mid-flight; for a session bleeding AWS spend
    // the math inverts — losing one in-flight tool call is strictly cheaper than
    // unbounded metered billing. Warn, then swap anyway.
    if (hasHotSwapHold(sess.pid)) {
      log(
        `[bedrock-watchdog] ⚠️ session ${bgSession.id} (pid ${sess.pid}) hot-swap HELD but on METERED BEDROCK — OVERRIDING hold and force-swapping (money > in-flight call; OAuth target=${target})`,
      );
    }

    // FORCE swap now. Do NOT defer busy/loop sessions for Bedrock.
    try {
      recordSessionLease(bgSession.id, target, bgSession.pid);
      const viaDetail =
        sess.via === 'network'
          ? `network(bedrock-conn pid ${sess.childPid})`
          : sess.via === 'runtime'
            ? `runtime(child ${sess.childPid})`
            : 'exec-env';
      log(
        `[bedrock-watchdog] FORCE-swapping ${bgSession.id} (pid ${sess.pid}, status ${bgSession.status}, via ${viaDetail}) Bedrock→OAuth ${target} (no defer — metered)`,
      );
      if (doRespawn(bgSession, log)) {
        // Swapped off Bedrock — clear the offender flag so the respawned (clean)
        // session's guard hook stops blocking. (If the swap fails, the flag stays
        // and the agent must ack.)
        clearOffenderFlag(bgSession.id);
        swapped++;
        swappedPids.push(sess.pid);
      }
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
