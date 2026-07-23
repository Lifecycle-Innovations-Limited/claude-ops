import { loadClaudeHarnessEnv } from './claude-harness-env.mjs';
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

import { readFileSync, readdirSync, writeFileSync, appendFileSync, unlinkSync, statSync, existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getTokenForSession, extractAccessToken, readLeases, recordSessionLease } from './session-router.mjs';
import { applyCrsSessionSettings, readRouteState } from './route-state.mjs';

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

// Dashboard marker: present ⇔ at least one session was last respawned to DIRECT
// because CRS was unhealthy. Lets fleet-status explain a "direct" session as
// "relay-down" rather than a silent/unexplained desync. Cleared whenever a
// session successfully routes via a healthy relay.
const CRS_RELAY_DOWN_MARKER = '/tmp/claude-crs-relay-down';
const HEALTH_WATCH_STATE = join(__dirname, 'crs-health-watch.state.json');
const HEALTH_STATE_FRESH_MS = 90_000; // trust the health-watch verdict if <90s old (it ticks every 60s)

// TTY hygiene helper: on abnormal paths or exit, attempt to restore sane mode so
// background errors or claude subprocs do not leave ^C ^[ etc. in a raw-mode TUI.
function resetTty() {
  try {
    execSync('stty sane 2>/dev/null || true', { stdio: 'ignore', timeout: 800 });
  } catch {}
}
process.once('exit', resetTty);

// Cheap CRS health read: prefer the recent crs-health-watch verdict (no network),
// fall back to a 3s /health curl when the state file is missing/stale. Returns
// boolean healthy. Keeps respawn fast and avoids hammering the relay per-session.
function crsHealthyCheap() {
  try {
    const st = JSON.parse(readFileSync(HEALTH_WATCH_STATE, 'utf8'));
    const mtime = statSync(HEALTH_WATCH_STATE).mtimeMs;
    if (Date.now() - mtime < HEALTH_STATE_FRESH_MS) {
      // mode 'crs' with down=0 ⇒ relay solid; mode 'fail-closed' ⇒ relay down.
      if (st.mode === 'fail-closed') return false;
      if (st.mode === 'crs' && (st.down || 0) === 0) return true;
    }
  } catch {}
  // Stale/absent state → authoritative live probe.
  try {
    const hc = execFileSync(
      'curl',
      ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', 'http://127.0.0.1:3005/health'],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return hc === '200';
  } catch {
    return false;
  }
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
  if (route.mode === 'fail-closed') {
    // OPT-IN (2026-06-22, CRS-connection auto-recovery): a connection-wedged
    // session must be respawnable DURING a confirmed CRS outage (fail-closed is
    // exactly that state). In fail-closed, settings.json already has the CRS env
    // stripped, and the FINAL ATOMIC NORMALIZATION below strips any leaked CRS
    // base/token — so the respawn boots cleanly on direct keychain OAuth (the
    // intended "fall back to local OAuth"). Without the opt-in, keep refusing so
    // no existing caller (rotate.mjs post-rotation, daemon deferred sweep) changes
    // behavior. crs-health-watch's rotate-magic keeps the keychain account fresh.
    if (!opts.allowFailClosedDirect) {
      log(
        `[bg-respawn] route=fail-closed; refusing to respawn session ${session.id} without healthy CRS OAuth or confirmed Bedrock`,
      );
      return false;
    }
    log(
      `[bg-respawn] route=fail-closed + allowFailClosedDirect — respawning session ${session.id} onto direct keychain OAuth (CRS-connection recovery)`,
    );
  }

  // (resetTty is defined at module scope with process handler)
  const stateFile = join(homedir(), '.claude', 'jobs', String(session.id), 'state.json');
  let state = null;
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      state = null;
    }
  }
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

    // CRS relay allowlist: override base URL + auth for specific sessions (scoped partial cutover).
    // Rollback: delete crs-allowlist.json + respawn listed sessions (removes CRS env, falls back to keychain).
    //
    // ATOMIC INVARIANT (2026-06-14, root-caused 401 loop): ANTHROPIC_BASE_URL and the cr_
    // relay token MUST be set together or not at all. If base→CRS but the Bearer token is a
    // real OAuth token (non-cr_ prefix), CRS rejects every request with
    //   {"error":"Invalid API key","message":"Invalid API key format"} → HTTP 401
    // which Claude Code surfaces as "API Error: 401 Invalid API key format" and retries
    // forever. The earlier bug: the cr_ key lived in a job tmp dir that got cleaned up, so the
    // readFileSync threw, the catch logged "non-fatal", and the session respawned with CRS base
    // URL + real OAuth token → infinite loop. Defenses below:
    //   1. Default key path is now a STABLE location (not job tmp).
    //   2. On ANY failure to obtain a cr_-prefixed key, we DELETE ANTHROPIC_BASE_URL from
    //      childEnv so the session falls back to direct Anthropic — never CRS-with-wrong-token.
    const CRS_ALLOWLIST_PATH = join(__dirname, 'crs-allowlist.json');
    let crsActive = false; // true ⇔ a VALID base+cr_ pair was applied (the only state in which CRS routing is allowed)
    let crsBaseUrl = 'http://127.0.0.1:3005/api';
    let crsRelayKey = '';
    try {
      if (existsSync(CRS_ALLOWLIST_PATH)) {
        const al = JSON.parse(readFileSync(CRS_ALLOWLIST_PATH, 'utf8'));
        crsBaseUrl = al.baseUrl || crsBaseUrl;
        // CARVE-OUT (2026-06-15): explicit per-session exclusions that MUST stay
        // off CRS even under the global default — orchestrator 0d298397, app-store
        // sonnet build e35cdd60, driver 0b465ce3. The global default lives in
        // settings.json env, so an excluded session would otherwise inherit
        // base=CRS+cr_ at startup; we strip the inherited CRS base here and leave
        // crsActive=false so it falls back to keychain/direct (the final atomic
        // normalization below then drops any leaked cr_ token too). Reversible:
        // remove the id from al.exclude.
        const excluded = Array.isArray(al.exclude) && al.exclude.includes(String(session.id));
        if (excluded) {
          delete childEnv.ANTHROPIC_BASE_URL;
          delete childEnv.ANTHROPIC_API_BASE;
          log(
            `[bg-respawn] CRS-allowlist: session ${session.id} is an explicit carve-out (al.exclude) — forcing OFF CRS, stripping inherited CRS base variables (keychain/direct)`,
          );
        }
        // GLOBAL CRS (2026-06-14, Sam directive "by default all sessions route there, new AND existing"):
        // al.global===true routes EVERY respawned session via CRS, not just the listed cohort.
        // Downstream health-gate + cr_-key validity + atomic invariant still apply, so a global
        // session falls back to direct auth if CRS is unhealthy or the key is bad. Reversible: set global:false.
        if (
          !excluded &&
          (al.global === true || (Array.isArray(al.sessions) && al.sessions.includes(String(session.id))))
        ) {
          const crKeyPath = join(homedir(), '.claude', 'crs-keys', 'claude-cli.env');
          let crKey = '';
          try {
            crKey = loadClaudeHarnessEnv({ path: crKeyPath }).CRS_API_KEY;
          } catch {
            crKey = '';
          }
          // HEALTH GATE (2026-06-14, refined 2026-06-15): never route a session
          // onto a DEAD relay. A valid cr_ key is necessary but not sufficient —
          // if CRS is unhealthy, injecting the CRS base wedges the session on an
          // unreachable upstream. crsHealthyCheap() prefers the recent
          // crs-health-watch verdict (no network) and falls back to a 3s /health
          // curl. When down, fall through to strip-base direct-auth + drop the
          // dashboard relay-down marker so the "direct" session is explained.
          const crsHealthy = crsHealthyCheap();
          if (crKey.startsWith('cr_') && crsHealthy) {
            // Both together + relay alive — the only safe state.
            childEnv.ANTHROPIC_BASE_URL = crsBaseUrl;
            childEnv.ANTHROPIC_API_BASE = crsBaseUrl;
            childEnv.ANTHROPIC_AUTH_TOKEN = crKey;
            childEnv.CLAUDE_CODE_OAUTH_TOKEN = crKey;
            // Keep API_KEY=cr_ so Claude hits CRS (unsetting broke routing).
            childEnv.ANTHROPIC_API_KEY = crKey;
            crsRelayKey = crKey;
            crsActive = true;
            try {
              unlinkSync(CRS_RELAY_DOWN_MARKER);
            } catch {} // relay healthy → clear stale marker
            log(`[bg-respawn] CRS-allowlist: routing session ${session.id} via relay ${childEnv.ANTHROPIC_BASE_URL}`);
          } else if (crKey.startsWith('cr_') && !crsHealthy) {
            // Valid key but relay DOWN → fail safe to direct auth (do not wedge).
            delete childEnv.ANTHROPIC_BASE_URL;
            delete childEnv.ANTHROPIC_API_BASE;
            try {
              writeFileSync(
                CRS_RELAY_DOWN_MARKER,
                JSON.stringify({ ts: Date.now(), reason: 'relay-down', lastSession: String(session.id) }),
              );
            } catch {}
            log(
              `[bg-respawn] CRS-allowlist: session ${session.id} listed but CRS unhealthy — stripping ANTHROPIC_BASE_URL, falling back to direct auth (marker: ${CRS_RELAY_DOWN_MARKER})`,
            );
          } else {
            // Key missing/malformed → MUST NOT leave base URL pointing at CRS with a non-cr_ token.
            delete childEnv.ANTHROPIC_BASE_URL;
            delete childEnv.ANTHROPIC_API_BASE;
            log(
              `[bg-respawn] CRS-allowlist: session ${session.id} listed but cr_ key invalid/missing at ${crKeyPath} — stripping ANTHROPIC_BASE_URL, falling back to direct auth`,
            );
          }
        }
      }
    } catch (err) {
      // Allowlist parse failure must also be fail-safe: never route to CRS half-configured.
      delete childEnv.ANTHROPIC_BASE_URL;
      delete childEnv.ANTHROPIC_API_BASE;
      log(`[bg-respawn] CRS allowlist read failed (fail-safe: stripped ANTHROPIC_BASE_URL): ${err.message}`);
    }

    // ── FINAL ATOMIC NORMALIZATION (2026-06-14, both-directions hardening) ────
    // The earlier guard only covered the allowlist-injection path. Two real
    // regressions slipped past it for spare-worker / --settings respawns:
    //   (a) lone cr_ key (no CRS base) → sent to direct api.anthropic.com →
    //       "401 Invalid API key format" (Anthropic rejects cr_).
    //   (b) base=CRS (leaked via --settings crs-session-settings.json or an
    //       inherited daemon env) + a real keychain OAuth token (which childEnv
    //       injection sets, OVERRIDING the settings-file cr_ token) → the relay
    //       rejects the non-cr_ token: "🔒 Invalid API key format from 172.18.0.1".
    // Invariant enforced here, unconditionally, as the LAST word on env:
    //   base==CRS  XNOR  token==cr_   (both, or neither — never one).
    // crsActive is the ONLY sanctioned "both" path; anything else is forced to
    // direct: strip the CRS base AND replace any cr_ token with the keychain one.
    {
      const crsBasePattern =
        /127\.0\.0\.1:(3000|3002|3005|8091|18091)|100\.87\.53\.96:8091|:(3000|3002|3005|8091|18091)\/api/;
      const baseIsCrs =
        crsBasePattern.test(String(childEnv.ANTHROPIC_BASE_URL || '')) ||
        crsBasePattern.test(String(childEnv.ANTHROPIC_API_BASE || ''));
      const tokIsCr = [
        childEnv.CLAUDE_CODE_OAUTH_TOKEN,
        childEnv.ANTHROPIC_AUTH_TOKEN,
        childEnv.ANTHROPIC_API_KEY,
      ].some((token) => String(token || '').startsWith('cr_'));
      if (crsActive) {
        const crKey = String(childEnv.ANTHROPIC_API_KEY || '').startsWith('cr_')
          ? childEnv.ANTHROPIC_API_KEY
          : String(childEnv.ANTHROPIC_AUTH_TOKEN || '').startsWith('cr_')
            ? childEnv.ANTHROPIC_AUTH_TOKEN
            : childEnv.CLAUDE_CODE_OAUTH_TOKEN;
        if (String(crKey || '').startsWith('cr_')) {
          childEnv.ANTHROPIC_API_KEY = crKey;
          childEnv.ANTHROPIC_AUTH_TOKEN = crKey;
          childEnv.CLAUDE_CODE_OAUTH_TOKEN = crKey;
        }
      }
      if (!crsActive && (baseIsCrs || tokIsCr)) {
        if (baseIsCrs) {
          delete childEnv.ANTHROPIC_BASE_URL; // → falls back to default direct api.anthropic.com
          delete childEnv.ANTHROPIC_API_BASE;
          log(
            `[bg-respawn] ATOMIC: session ${session.id} not CRS-active but base→CRS leaked — stripped CRS base variables (direct)`,
          );
        }
        if (tokIsCr) {
          // Never let a lone cr_ relay key reach the direct API. Prefer the keychain token.
          let kc = null;
          try {
            const config = readConfig();
            const tokenJson = getTokenForSession(session.id, config);
            kc = tokenJson ? extractAccessToken(tokenJson) : null;
          } catch {}
          if (kc) {
            delete childEnv.ANTHROPIC_API_KEY;
            delete childEnv.ANTHROPIC_AUTH_TOKEN;
            childEnv.CLAUDE_CODE_OAUTH_TOKEN = kc;
            log(`[bg-respawn] ATOMIC: session ${session.id} had lone cr_ key — swapped to keychain OAuth (direct)`);
          } else {
            delete childEnv.ANTHROPIC_API_KEY; // fall through to keychain credentials file
            delete childEnv.ANTHROPIC_AUTH_TOKEN;
            delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
            log(
              `[bg-respawn] ATOMIC: session ${session.id} had lone cr_ key, no per-session token — deleted (keychain file fallback)`,
            );
          }
        }
      }
    }

    // ── RESPAWN-FLAG RECONCILIATION (durable: base+token can't separate) ─────
    // `--settings crs-session-settings.json` injects ANTHROPIC_BASE_URL=CRS at
    // process startup, which childEnv stripping cannot undo. Make the allowlist
    // the SOLE authority for CRS routing: add the CRS settings flag iff crsActive,
    // remove it otherwise. Persisted to state.json so `claude respawn` re-reads it.
    try {
      const flags = Array.isArray(state.respawnFlags) ? [...state.respawnFlags] : null;
      if (flags) {
        const isCrsSettingsVal = (v) => typeof v === 'string' && v.endsWith('crs-session-settings.json');
        const hasCrsSettings = flags.some((f, i) => f === '--settings' && isCrsSettingsVal(flags[i + 1]));
        let mutated = false;
        if (!crsActive && hasCrsSettings) {
          for (let i = flags.length - 1; i >= 0; i--) {
            if (flags[i] === '--settings' && isCrsSettingsVal(flags[i + 1])) {
              flags.splice(i, 2);
              mutated = true;
            }
          }
          log(
            `[bg-respawn] RECONCILE: session ${session.id} not CRS-active — removed --settings crs-session-settings.json from respawnFlags`,
          );
        } else if (crsActive && !hasCrsSettings) {
          const settingsPath = join(homedir(), '.claude', 'crs-session-settings.json');
          applyCrsSessionSettings({ baseUrl: crsBaseUrl, key: crsRelayKey });
          flags.push('--settings', settingsPath);
          mutated = true;
          log(
            `[bg-respawn] RECONCILE: session ${session.id} CRS-active — added --settings ${settingsPath} to respawnFlags`,
          );
        } else if (crsActive) {
          applyCrsSessionSettings({ baseUrl: crsBaseUrl, key: crsRelayKey });
        }
        if (mutated) {
          state.respawnFlags = flags;
          writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
      // Capture any output the binary emitted on failure (model errors etc) to our log, not controlling tty.
      try {
        respawnOut = (e.stdout || '') + (e.stderr || '');
      } catch {}
      log(`[bg-respawn] respawn exec note for ${session.id}: ${String(e.message || e).slice(0, 120)}`);
      // Do not re-throw; we still want to mark and continue fleet hygiene.
    }
    if (respawnOut && respawnOut.length > 0) {
      // Persist any chatter from the respawn to dedicated log to avoid TUI pollution.
      try {
        const LOGP = join(__dirname, 'bg-respawn.out.log');
        appendFileSync(LOGP, `[${new Date().toISOString()}] ${session.id}: ${respawnOut.slice(0, 2000)}\n`);
      } catch {}
    }
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
          const found = live.find((ls) => String(ls.id) === String(session.id));
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
        if (!existsSync(DEFERRED_MARKER(s.id))) writeFileSync(DEFERRED_MARKER(s.id), String(Date.now()));
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
