// ── Fleet stuck-agent auto-recovery ──────────────────────────────────────────
// Daemon-hosted `claude --bg` agents can wedge in two distinct rate-limit
// states. Both surface in `claude agents --json` as state:"blocked" with NO
// reason carried in the JSON — the reason lives only in the transcript tail as
// a synthetic assistant message (isApiErrorMessage:true). Left alone, these
// agents sit blocked for hours and never auto-resume (observed 2026-06-13).
//
//   1. USAGE LIMIT  — text "You've hit your session limit · resets <time>".
//      The agent's leased Max account is exhausted. Recovery: park that
//      account, re-lease the session to the COOLEST available account, NEUTRALIZE
//      the stale limit message (so the resumed agent doesn't re-read "resets at
//      X" and conclude it has no quota → self-stop), then `claude respawn`.
//
//   2. SERVER THROTTLE — text "Server is temporarily limiting requests (not your
//      usage limit)", apiErrorStatus 429/529. Anthropic-side transient overload;
//      EVERY account hits it, so rotating does NOT help. Recovery: just respawn
//      to retry, with exponential backoff so we don't hammer during a real
//      outage. No rotation, no transcript edit.
//
// Genuine human-gates (blocked with no apiError in the tail, e.g. "run kill
// 48688") are left untouched — respawning them would discard the gate.
//
// Called once per daemon tick from mainLoop, BEFORE shouldRotate.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  readdirSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { pickAccountForSession, recordSessionLease, readLeases, accountKey } from './session-router.mjs';
import { doRespawn } from './bg-respawn.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, 'state.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Per-session recovery cooldown markers — bound respawn frequency so a still-
// throttled agent (or a respawn that itself re-throttles) can't loop.
const MARKER = (id) => `/tmp/cc-fleet-recover-${id}.json`;
const RESPAWN_SETTLE_MS = 90_000; // ignore agents touched < this ago (boot window)
const THROTTLE_BASE_MS = 30_000; // server-throttle backoff base
const THROTTLE_MAX_MS = 10 * 60_000; // server-throttle backoff cap
const USAGE_MIN_INTERVAL_MS = 120_000; // usage-limit recovery min interval
const MAX_ACTIONS_PER_TICK = 2; // stagger — at most N recoveries per 30s tick
const LIMIT_NEUTRALIZED =
  '[account rotated — fresh quota available; prior session-limit notice cleared, continue working]';

function claudeBin() {
  const app = join(homedir(), '.local', 'share', 'claude', 'ClaudeCode.app', 'Contents', 'MacOS', 'claude');
  return existsSync(app) ? app : 'claude';
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { accounts: {} };
  }
}

function listAgents() {
  try {
    const out = execFileSync(claudeBin(), ['agents', '--json'], {
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Locate <sessionId>.jsonl under any ~/.claude/projects/<enc-cwd>/ dir.
function findTranscript(sessionId) {
  if (!sessionId) return null;
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  let best = null;
  let bestM = 0;
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    try {
      const m = statSync(p).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = p;
      }
    } catch {}
  }
  return best;
}

function messageText(d) {
  const c = d?.message?.content;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' ? b.text || '' : '')).join(' ');
  if (typeof c === 'string') return c;
  return '';
}

// Classify why a state:"blocked" agent is stuck, from the most-recent apiError
// in the transcript tail. Returns 'usage-limit' | 'server-throttle' | 'fatal-model' | 'none'.
// 'fatal-model': requested model (e.g. haiku-4-5 snapshot) not supported by any leased account's catalog.
export function classifyStuck(transcriptPath) {
  if (!transcriptPath) return 'none';
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 'none';
  }
  for (const ln of lines.slice(-30).reverse()) {
    let d;
    try {
      d = JSON.parse(ln);
    } catch {
      continue;
    }
    const isErr = d.isApiErrorMessage === true || d.apiErrorStatus != null;
    if (!isErr) continue;
    const t = messageText(d).toLowerCase();
    if (t.includes('hit your session limit') || (t.includes('usage limit') && !t.includes('not your usage'))) {
      return 'usage-limit';
    }
    if (
      t.includes('temporarily limiting') ||
      t.includes('server is temporarily') ||
      t.includes('overloaded') ||
      d.apiErrorStatus === 429 ||
      d.apiErrorStatus === 529
    ) {
      return 'server-throttle';
    }
    if (t.includes('no available claude accounts support') || t.includes('requested model')) {
      return 'fatal-model'; // haiku-4-5 or similar not on leased accounts; rotate lease + respawn
    }
    // CRS-ENDPOINT CONNECTION FAILURE (2026-06-22): bg sessions route through the
    // CRS relay at 127.0.0.1:3005 via the launchd SSH tunnel. When that tunnel/relay
    // is unreachable (tunnel wedged, relay restarting, FRA box blip), in-flight turns
    // fail with raw socket errors — NOT a 429/5xx apiErrorStatus, so server-throttle
    // never matches and the session sits 'blocked' forever (observed: a tunnel outage
    // cascaded ECONNRESET failures that killed 6+ sessions, hand-cleaned by the
    // orchestrator). Recovery = respawn: doRespawn's own health-gate strips the CRS
    // base URL → direct keychain OAuth when the relay is down, so the session resumes
    // on local OAuth instead of the dead tunnel. crs-health-watch (rotate-magic) +
    // the tunnel's launchd KeepAlive run in parallel to restore CRS for the next tick.
    if (
      t.includes('econnreset') ||
      t.includes('econnrefused') ||
      t.includes('connection refused') ||
      t.includes('connectionrefused') ||
      t.includes('etimedout') ||
      t.includes('connection timeout') ||
      t.includes('unable to connect') ||
      t.includes('connection error') ||
      t.includes('failedtoopensocket') ||
      t.includes('socket hang up') ||
      t.includes('fetch failed') ||
      t.includes('network error') ||
      t.includes('econnaborted') ||
      t.includes('enetunreach') ||
      t.includes('ehostunreach')
    ) {
      return 'crs-connection'; // relay/tunnel unreachable — respawn (falls back to direct OAuth)
    }
    return 'none'; // some other apiError — leave it
  }
  return 'none';
}

// Rewrite every synthetic "hit your session limit" line into a benign note so a
// resumed agent doesn't re-read the reset time and self-stop. Atomic write.
export function neutralizeLimitMessages(transcriptPath, log) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return 0;
  }
  let changed = 0;
  const out = lines.map((ln) => {
    if (!ln.trim()) return ln;
    let d;
    try {
      d = JSON.parse(ln);
    } catch {
      return ln;
    }
    if (d.isApiErrorMessage === true && /hit your session limit/i.test(messageText(d))) {
      const c = d?.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b && typeof b === 'object' && typeof b.text === 'string') b.text = LIMIT_NEUTRALIZED;
      } else if (d.message) {
        d.message.content = LIMIT_NEUTRALIZED;
      }
      d.isApiErrorMessage = false;
      delete d.apiErrorStatus;
      if (d.message) d.message.stop_reason = null;
      changed += 1;
      return JSON.stringify(d);
    }
    return ln;
  });
  if (changed > 0) {
    try {
      const tmp = `${transcriptPath}.tmp-neutralize`;
      writeFileSync(tmp, out.join('\n'));
      renameSync(tmp, transcriptPath);
      log?.(`neutralized ${changed} stale session-limit message(s) in ${transcriptPath.split('/').pop()}`);
    } catch (e) {
      log?.(`neutralize write failed: ${e.message?.slice(0, 80)}`);
      return 0;
    }
  }
  return changed;
}

// Truncate trailing SYNTHETIC assistant entries so a resumed session ends on a
// real `msg_…` assistant turn. This is the CORRECT remedy for the daemon-injected
// session-limit popup — the prior `neutralizeLimitMessages` rewrote the synthetic
// line in place but KEPT its UUID `message.id`; on resume Claude Code picks that
// UUID as `previous_message_id` → permanent `400 diagnostics.previous_message_id`
// loop (upstream bug #58427/#59520). Stripping the synthetic tail entirely avoids
// that: the transcript ends on the last valid `msg_…` turn. Atomic write.
//
// A "synthetic" tail entry is any trailing entry that is:
//   - isApiErrorMessage:true, OR
//   - message.model === '<synthetic>' (or top-level model), OR
//   - an assistant turn whose message.id is present but NOT a real `msg_…` id.
// Conservative: stops at the first non-synthetic line; never touches user turns
// or real assistant turns.
function isSyntheticEntry(d) {
  const isAssistant = d?.type === 'assistant' || d?.message?.role === 'assistant';
  const mid = d?.message?.id;
  return (
    d?.isApiErrorMessage === true ||
    d?.message?.model === '<synthetic>' ||
    d?.model === '<synthetic>' ||
    (isAssistant && typeof mid === 'string' && mid.length > 0 && !mid.startsWith('msg_'))
  );
}

function isRealAssistant(d) {
  const isAssistant = d?.type === 'assistant' || d?.message?.role === 'assistant';
  const mid = d?.message?.id;
  return isAssistant && typeof mid === 'string' && mid.startsWith('msg_') && d?.isApiErrorMessage !== true;
}

export function stripSyntheticTail(transcriptPath, log) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return 0;
  }
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--; // drop trailing blank lines
  const origEnd = end;

  // The #58427 400-loop accumulates synthetic error turns INTERLEAVED with system/
  // user/attachment noise across many respawn attempts — they are NOT a contiguous
  // tail. The only clean recovery is to truncate everything after the last REAL
  // `msg_…` assistant turn, but ONLY when synthetic/error entries exist after it
  // (so a healthy transcript mid-turn is never touched).
  let lastReal = -1;
  for (let i = end - 1; i >= 0; i--) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isRealAssistant(d)) {
      lastReal = i;
      break;
    }
  }

  if (lastReal >= 0) {
    let corruptAfter = false;
    for (let i = lastReal + 1; i < end; i++) {
      let d;
      try {
        d = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (isSyntheticEntry(d)) {
        corruptAfter = true;
        break;
      }
    }
    if (corruptAfter) end = lastReal + 1; // keep through the last real assistant turn
  } else {
    // No real `msg_…` assistant turn exists anywhere — there is nothing valid to
    // resume from as previous_message_id, and a contiguous-synthetic-strip can
    // still leave a UUID-id assistant tail (observed on `hypest`, which kept
    // 400-looping). The #58427-safe state is a tail with NO assistant id at all:
    // truncate to the last USER turn so resume re-sends it with no
    // previous_message_id. If there's no user turn either, leave as-is and let the
    // caller relaunch the session fresh.
    let lastUser = -1;
    for (let i = end - 1; i >= 0; i--) {
      let d;
      try {
        d = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (d?.type === 'user' || d?.message?.role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser >= 0) {
      // Only truncate if an assistant/synthetic entry sits after the last user turn.
      let needTrunc = false;
      for (let i = lastUser + 1; i < end; i++) {
        let d;
        try {
          d = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (isSyntheticEntry(d) || d?.type === 'assistant' || d?.message?.role === 'assistant') {
          needTrunc = true;
          break;
        }
      }
      if (needTrunc) end = lastUser + 1;
    }
  }

  const removed = origEnd - end;
  if (removed > 0) {
    try {
      const tmp = `${transcriptPath}.tmp-strip`;
      writeFileSync(tmp, lines.slice(0, end).join('\n') + '\n');
      renameSync(tmp, transcriptPath);
      log?.(
        `stripped ${removed} synthetic tail entr${removed === 1 ? 'y' : 'ies'} from ${transcriptPath.split('/').pop()}`,
      );
    } catch (e) {
      log?.(`strip write failed: ${e.message?.slice(0, 80)}`);
      return 0;
    }
  }
  return removed;
}

function readMarker(id) {
  try {
    return JSON.parse(readFileSync(MARKER(id), 'utf8'));
  } catch {
    return null;
  }
}
// O_NOFOLLOW: these markers live at predictable /tmp paths (keyed by agent
// id); refuse to write through a pre-planted symlink rather than following
// it. O_CREAT|O_TRUNC preserves normal create-or-overwrite behavior.
function writeMarker(id, obj) {
  try {
    const fd = openSync(
      MARKER(id),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, JSON.stringify(obj));
    } finally {
      closeSync(fd);
    }
  } catch {}
}

// Main entry — called each daemon tick. Detect + recover stuck bg agents.
export function checkFleetStuckAgents(config, state, log = () => {}) {
  const agents = listAgents().filter((a) => a && a.kind === 'background' && a.state === 'blocked' && a.id);
  if (agents.length === 0) return { acted: 0 };

  let acted = 0;
  for (const a of agents) {
    if (acted >= MAX_ACTIONS_PER_TICK) break;
    const id = a.id;
    const sid = a.sessionId || '';
    const name = a.name || id;
    const transcript = findTranscript(sid);
    const cls = classifyStuck(transcript);
    if (cls === 'none') continue; // genuine human-gate or unrelated error — leave it

    const now = Date.now();
    const mk = readMarker(id) || { attempts: 0, ts: 0 };

    if (cls === 'server-throttle') {
      // Exponential backoff per session — don't hammer during a real outage.
      const wait = Math.min(THROTTLE_BASE_MS * 2 ** mk.attempts, THROTTLE_MAX_MS);
      if (now - mk.ts < Math.max(wait, RESPAWN_SETTLE_MS)) continue;
      log(`[${name}] server-throttle (attempt ${mk.attempts + 1}) — respawn to retry`);
      const ok = doRespawn({ id, pid: a.pid, status: a.status || 'idle' }, (m) => log(m));
      writeMarker(id, { attempts: ok ? mk.attempts + 1 : mk.attempts, ts: now, kind: 'server-throttle' });
      if (ok) acted += 1;
      continue;
    }

    // crs-connection: the CRS endpoint (127.0.0.1:3005 via the launchd tunnel) was
    // unreachable mid-turn. Same exponential-backoff respawn as server-throttle, but
    // pass allowFailClosedDirect so the respawn still proceeds once crs-health-watch
    // has flipped the global route to fail-closed (sustained outage) — in that state
    // doRespawn would otherwise refuse, leaving the session wedged for the whole
    // outage. The respawn boots on direct keychain OAuth (CRS env already stripped
    // from settings.json in fail-closed, or stripped by doRespawn's own health-gate
    // when route is still crs-oauth but the relay is down). Honors MAX_ACTIONS_PER_TICK.
    if (cls === 'crs-connection') {
      const wait = Math.min(THROTTLE_BASE_MS * 2 ** mk.attempts, THROTTLE_MAX_MS);
      if (now - mk.ts < Math.max(wait, RESPAWN_SETTLE_MS)) continue;
      log(`[${name}] crs-connection (attempt ${mk.attempts + 1}) — respawn (falls back to direct OAuth if relay down)`);
      const ok = doRespawn({ id, pid: a.pid, status: a.status || 'idle' }, (m) => log(m), {
        allowFailClosedDirect: true,
      });
      writeMarker(id, { attempts: ok ? mk.attempts + 1 : mk.attempts, ts: now, kind: 'crs-connection' });
      if (ok) acted += 1;
      continue;
    }

    // fatal-model (e.g. haiku-4-5 not on any Max account): re-lease to any account and respawn.
    // No transcript neutralization needed; the error is a hard request rejection.
    if (cls === 'fatal-model') {
      if (now - mk.ts < USAGE_MIN_INTERVAL_MS) continue;
      const leases = readLeases();
      const oldKey = leases[id]?.accountKey;
      let newKey = null;
      try {
        newKey = pickAccountForSession(id, { exclude: oldKey ? [oldKey] : [] });
      } catch {}
      if (newKey && newKey !== oldKey) {
        recordSessionLease(id, newKey, a.pid);
        log(`[${name}] fatal-model — re-leased ${oldKey || '?'} → ${newKey} (model not supported on prior)`);
      } else {
        log(`[${name}] fatal-model — no alternate account; respawn on current to retry after alias fix`);
      }
      const ok = doRespawn({ id, pid: a.pid, status: a.status || 'idle' }, (m) => log(m));
      writeMarker(id, { attempts: 0, ts: now, kind: 'fatal-model', newKey: newKey || null });
      if (ok) acted += 1;
      continue;
    }

    // usage-limit: park the exhausted account, re-lease to coolest, neutralize, respawn.
    if (now - mk.ts < USAGE_MIN_INTERVAL_MS) continue;
    const leases = readLeases();
    const oldKey = leases[id]?.accountKey;
    const fresh = readState(); // re-read so we persist on top of latest
    fresh.accounts = fresh.accounts || {};
    if (oldKey && oldKey !== 'bedrock') {
      fresh.accounts[oldKey] = fresh.accounts[oldKey] || {};
      fresh.accounts[oldKey].lastUtilization = { pct: 100, reset: null, ts: now };
      try {
        writeFileSync(STATE_PATH, JSON.stringify(fresh, null, 2));
      } catch {}
      // mirror into the in-memory state the daemon passed us so this tick's
      // later logic sees the parked account too.
      state.accounts = state.accounts || {};
      state.accounts[oldKey] = state.accounts[oldKey] || {};
      state.accounts[oldKey].lastUtilization = { pct: 100, reset: null, ts: now };
    }
    const newKey = pickAccountForSession(id, config, fresh);
    if (newKey && newKey !== oldKey) {
      recordSessionLease(id, newKey, a.pid);
      log(`[${name}] usage-limit — re-leased ${oldKey || '?'} → ${newKey} (coolest)`);
    } else {
      log(`[${name}] usage-limit — no cooler account than ${oldKey || '?'} (picker returned ${newKey || 'none'})`);
    }
    if (transcript) stripSyntheticTail(transcript, (m) => log(`[${name}] ${m}`));
    const ok = doRespawn({ id, pid: a.pid, status: a.status || 'idle' }, (m) => log(m));
    writeMarker(id, { attempts: 0, ts: now, kind: 'usage-limit', newKey: newKey || null });
    if (ok) acted += 1;
  }

  if (acted > 0) log(`recovered ${acted} stuck agent(s) this tick`);
  return { acted };
}
