// control.mjs — fleet control actions for agent-dash: attach, steer, revive,
// kill, archive. Resolves an agent by id from a fresh snapshot, then dispatches
// the right command for its type + host. Remote actions are prefixed with
// `ssh -t <fra>`. Read-only on remote except these explicit control calls.

import { spawnSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOME = homedir();
const ARCHIVE_LOG = join(HOME, '.claude', 'state', 'agent-archive.jsonl');
const REMOTE_CACHE = join(HOME, '.claude', 'state', 'agent-dash-remote-cache.json');
const FRA_HOSTS = (process.env.AGENT_DASH_FRA_HOSTS || 'fra-direct,dev-sandbox-fra-cf').split(',');

function fraSshHost() {
  try {
    const host = JSON.parse(readFileSync(REMOTE_CACHE, 'utf8'))?.meta?.source?.trim();
    if (host) return host;
  } catch { /* use default */ }
  return FRA_HOSTS[0].trim();
}
const OPS_BG = process.env.OPS_BG_BIN || `${HOME}/Projects/claude-ops/claude-ops/bin/ops-bg`;

export function findAgent(snapshot, idOrName) {
  const q = String(idOrName);
  return (
    snapshot.agents.find((a) => a.id === q) ||
    snapshot.agents.find((a) => a.sessionId === q) ||
    snapshot.agents.find((a) => String(a.pid) === q) ||
    snapshot.agents.find((a) => a.name === q) ||
    snapshot.agents.find((a) => a.id.startsWith(q)) ||
    snapshot.agents.find((a) => a.name.startsWith(q)) ||
    null
  );
}

function claudeBin() {
  for (const c of [`${HOME}/.local/bin/claude`, '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) {
    if (existsSync(c)) return c;
  }
  return 'claude';
}

// Run a foreground, TTY-inheriting command (attach/resume). Returns exit code.
function runForeground(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

// Run a non-interactive command, capture output. { ok, out, err }
function runCapture(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || e.message || '').toString().trim() };
  }
}

// Build the [cmd, args] for a remote action: ssh [-t] <fra> "<shell>"
function remote(shell, tty = false) {
  const flags = ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  if (tty) flags.unshift('-t');
  return ['ssh', [...flags, fraSshHost(), shell]];
}

// --- ATTACH ----------------------------------------------------------------
// Hands the terminal to the live session. claude → `claude attach <id>`;
// agy → resume conversation; procs → no attach surface.
export function attach(a) {
  if (a.type === 'claude') {
    if (a.host === 'fra') {
      const [c, args] = remote(`CLAUDE_NO_TMUX=1 claude attach ${a.id}`, true);
      return runForeground(c, args);
    }
    return runForeground(claudeBin(), ['attach', a.id]);
  }
  if (a.type === 'agy') {
    const sub = `agy --conversation ${a.sessionId}`;
    if (a.host === 'fra') { const [c, args] = remote(sub, true); return runForeground(c, args); }
    return runForeground('agy', ['--conversation', a.sessionId]);
  }
  process.stderr.write(`attach: ${a.type} has no attach surface (pid ${a.pid}). Use tmux attach if it runs in a pane.\n`);
  return 2;
}

// --- STEER -----------------------------------------------------------------
// Inject a message without attaching. claude bg → ops-bg send (control.sock).
// agy → not live-steerable (resume only). Returns {ok, msg}.
export function steer(a, message) {
  if (!message || !message.trim()) return { ok: false, msg: 'empty message' };
  if (a.type === 'claude') {
    if (a.host === 'fra') {
      const r = runCapture(...remote(`ops-bg send ${a.id} ${shq(message)}`));
      return { ok: r.ok, msg: r.ok ? `steered ${a.id} on fra` : r.err };
    }
    const r = runCapture(OPS_BG, ['send', a.id, message]);
    return { ok: r.ok, msg: r.ok ? `steered ${a.id}` : (r.err || r.out) };
  }
  if (a.type === 'agy') {
    return { ok: false, msg: 'agy has no live-steer; use revive (--conversation) to resume interactively' };
  }
  return { ok: false, msg: `${a.type} is not steerable` };
}

// --- REVIVE ----------------------------------------------------------------
// Bring a stopped/zombie session back. claude → attach (conversation kept), or
// `claude -r <sessionId>` if attach fails. agy → resume by conversation UUID.
export function revive(a) {
  if (a.type === 'claude') {
    if (a.host === 'fra') {
      const [c, args] = remote(`CLAUDE_NO_TMUX=1 claude attach ${a.id} || CLAUDE_NO_TMUX=1 claude -r ${a.sessionId}`, true);
      return runForeground(c, args);
    }
    const code = runForeground(claudeBin(), ['attach', a.id]);
    if (code !== 0 && a.sessionId) return runForeground(claudeBin(), ['-r', a.sessionId]);
    return code;
  }
  if (a.type === 'agy') {
    if (a.host === 'fra') { const [c, args] = remote(`agy --conversation ${a.sessionId}`, true); return runForeground(c, args); }
    return runForeground('agy', ['--conversation', a.sessionId]);
  }
  process.stderr.write(`revive: no resume surface for ${a.type}\n`);
  return 2;
}

// --- KILL ------------------------------------------------------------------
export function kill(a) {
  if (a.type === 'claude') {
    if (a.host === 'fra') {
      const r = runCapture(...remote(`CLAUDE_NO_TMUX=1 claude stop ${a.id}`));
      return { ok: r.ok, msg: r.ok ? `stopped ${a.id} on fra` : r.err };
    }
    const r = runCapture(claudeBin(), ['stop', a.id]);
    return { ok: r.ok, msg: r.ok ? `stopped ${a.id}` : (r.err || r.out) };
  }
  // procs / agy: kill by pid
  if (a.pid) {
    if (a.host === 'fra') {
      const r = runCapture(...remote(`kill ${a.pid}`));
      return { ok: r.ok, msg: r.ok ? `killed pid ${a.pid} on fra` : r.err };
    }
    try { process.kill(a.pid); return { ok: true, msg: `killed pid ${a.pid}` }; }
    catch (e) { return { ok: false, msg: e.message }; }
  }
  return { ok: false, msg: `nothing to kill for ${a.type} (no pid/session)` };
}

// --- ARCHIVE ---------------------------------------------------------------
// claude rm <id> (removes session + worktree) + append a record to the archive log.
export function archive(a) {
  let res;
  if (a.type === 'claude') {
    if (a.host === 'fra') {
      res = (() => { const r = runCapture(...remote(`CLAUDE_NO_TMUX=1 claude rm ${a.id}`)); return { ok: r.ok, msg: r.ok ? `rm ${a.id} on fra` : r.err }; })();
    } else {
      const r = runCapture(claudeBin(), ['rm', a.id]);
      res = { ok: r.ok, msg: r.ok ? `rm ${a.id}` : (r.err || r.out) };
    }
  } else {
    res = kill(a);
  }
  if (!res.ok) return res;
  try {
    if (!existsSync(dirname(ARCHIVE_LOG))) mkdirSync(dirname(ARCHIVE_LOG), { recursive: true });
    appendFileSync(ARCHIVE_LOG, JSON.stringify({
      ts: new Date().toISOString(), id: a.id, sessionId: a.sessionId, name: a.name,
      type: a.type, host: a.host, cwd: a.cwd, lastStatus: a.status,
    }) + '\n');
  } catch (e) { res.msg += ` (archive-log: ${e.message})`; }
  return res;
}

// shell-quote a single arg for remote ssh command strings
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export const ACTIONS = { attach, steer, revive, kill, archive };
