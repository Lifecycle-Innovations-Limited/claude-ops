// control.mjs — fleet control actions for agent-dash: attach, steer, revive,
// kill, archive. Resolves an agent by id from a fresh snapshot, then dispatches
// the right command for its type + host. Remote actions use the operator's
// configured SSH host. Read-only on remote except these explicit control calls.

import { spawnSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const ARCHIVE_LOG = join(HOME, '.claude', 'state', 'agent-archive.jsonl');
import { configuredRemoteHosts, shellQuote as shq } from './remote-hosts.mjs';

function resolveOpsBg() {
  if (process.env.OPS_BG_BIN) return process.env.OPS_BG_BIN;
  // Sibling of this file is the authoritative answer: control.mjs ships at
  // <root>/scripts/agent-dash/control.mjs, so ops-bg is <root>/bin/ops-bg.
  const candidates = [
    pathResolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ops-bg'),
    `${HOME}/Developer/repos/claude-ops/claude-ops/bin/ops-bg`,
    `${HOME}/external-skills/claude-ops/bin/ops-bg`,
    `${HOME}/.claude/plugins/marketplaces/ops-marketplace/claude-ops/bin/ops-bg`,
    `${HOME}/Projects/claude-ops/claude-ops/bin/ops-bg`,
  ];
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (st.isFile() && st.mode & 0o111) return c;
    } catch {
      // missing path — keep looking
    }
  }
  return candidates[0];
}
const OPS_BG = resolveOpsBg();

export function findAgent(snapshot, idOrName) {
  if (idOrName == null || String(idOrName).trim() === '') return null;
  const query = String(idOrName);
  const colon = query.indexOf(':');
  const host = colon < 0 ? null : query.slice(0, colon);
  const q = colon < 0 ? query : query.slice(colon + 1);
  if (!q) return null;
  const agents = snapshot.agents.filter((a) => !host || a.host === host);
  const exact = agents.filter((a) => [a.id, a.sessionId, a.pid, a.name].some((v) => v != null && String(v) === q));
  const matches = exact.length
    ? exact
    : agents.filter((a) => [a.id, a.name].some((v) => typeof v === 'string' && v.startsWith(q)));
  if (matches.length > 1) throw new Error(`ambiguous agent "${query}"; use host:id to select one agent`);
  return matches[0] || null;
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
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || e.message || '').toString().trim() };
  }
}

// A remote action must go to the host the agent actually lives on, not to the first
// configured one. Only a host that is configured may be used, and only a plain
// host name is allowed, so nothing can be interpolated into the ssh arguments.
function safeHost(host) {
  const name = String(host || '').trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return configuredRemoteHosts().includes(name) ? name : null;
}

// Build the [cmd, args] for a remote action: ssh [-t] <host> "<shell>"
function remote(shell, tty = false, host) {
  const target = safeHost(host);
  if (!target) {
    throw new Error(`refusing a remote action on an unconfigured host: ${host}`);
  }
  const flags = ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  if (tty) flags.unshift('-t');
  return ['ssh', [...flags, target, shell]];
}

// --- ATTACH ----------------------------------------------------------------
// Hands the terminal to the live session. claude → `claude attach <id>`;
// agy → resume conversation; procs → no attach surface.
export function attach(a) {
  if (a.type === 'claude') {
    if (a.host !== 'mac') {
      const [c, args] = remote(`CLAUDE_NO_TMUX=1 claude attach ${identifier(a.id)}`, true, a.host);
      return runForeground(c, args);
    }
    return runForeground(claudeBin(), ['attach', a.id]);
  }
  if (a.type === 'agy') {
    if (a.host !== 'mac') {
      const [c, args] = remote(`agy --conversation ${identifier(a.sessionId)}`, true, a.host);
      return runForeground(c, args);
    }
    return runForeground('agy', ['--conversation', a.sessionId]);
  }
  process.stderr.write(
    `attach: ${a.type} has no attach surface (pid ${a.pid}). Use tmux attach if it runs in a pane.\n`,
  );
  return 2;
}

// --- STEER -----------------------------------------------------------------
// Inject a message without attaching. claude bg → ops-bg send (control.sock).
// agy → not live-steerable (resume only). Returns {ok, msg}.
export function steer(a, message) {
  if (!message || !message.trim()) return { ok: false, msg: 'empty message' };
  if (a.type === 'claude') {
    if (a.host !== 'mac') {
      const r = runCapture(...remote(`ops-bg send ${identifier(a.id)} ${shq(message)}`, false, a.host));
      return { ok: r.ok, msg: r.ok ? `steered ${a.id} on remote host` : r.err };
    }
    const r = runCapture(OPS_BG, ['send', a.id, message]);
    return { ok: r.ok, msg: r.ok ? `steered ${a.id}` : r.err || r.out };
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
    if (a.host !== 'mac') {
      const [c, args] = remote(
        `CLAUDE_NO_TMUX=1 claude attach ${identifier(a.id)}` +
          (a.sessionId ? ` || CLAUDE_NO_TMUX=1 claude -r ${identifier(a.sessionId)}` : ''),
        true,
        a.host,
      );
      return runForeground(c, args);
    }
    const code = runForeground(claudeBin(), ['attach', a.id]);
    if (code !== 0 && a.sessionId) return runForeground(claudeBin(), ['-r', a.sessionId]);
    return code;
  }
  if (a.type === 'agy') {
    if (a.host !== 'mac') {
      const [c, args] = remote(`agy --conversation ${identifier(a.sessionId)}`, true, a.host);
      return runForeground(c, args);
    }
    return runForeground('agy', ['--conversation', a.sessionId]);
  }
  process.stderr.write(`revive: no resume surface for ${a.type}\n`);
  return 2;
}

// --- KILL ------------------------------------------------------------------
export function kill(a) {
  if (a.type === 'claude') {
    if (a.host !== 'mac') {
      const r = runCapture(...remote(`CLAUDE_NO_TMUX=1 claude stop ${identifier(a.id)}`, false, a.host));
      return { ok: r.ok, msg: r.ok ? `stopped ${a.id} on remote host` : r.err };
    }
    const r = runCapture(claudeBin(), ['stop', a.id]);
    return { ok: r.ok, msg: r.ok ? `stopped ${a.id}` : r.err || r.out };
  }
  // procs / agy: kill by pid
  if (a.pid) {
    if (!/^[1-9][0-9]*$/.test(String(a.pid)) || !Number.isSafeInteger(Number(a.pid))) {
      return { ok: false, msg: 'invalid pid' };
    }
    if (a.host !== 'mac') {
      const r = runCapture(...remote(`kill ${shq(a.pid)}`, false, a.host));
      return { ok: r.ok, msg: r.ok ? `killed pid ${a.pid} on remote host` : r.err };
    }
    try {
      process.kill(a.pid);
      return { ok: true, msg: `killed pid ${a.pid}` };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }
  return { ok: false, msg: `nothing to kill for ${a.type} (no pid/session)` };
}

// --- ARCHIVE ---------------------------------------------------------------
// claude rm <id> (removes session + worktree) + append a record to the archive log.
export function archive(a) {
  let res;
  if (a.type === 'claude') {
    if (a.host !== 'mac') {
      res = (() => {
        const r = runCapture(...remote(`CLAUDE_NO_TMUX=1 claude rm ${identifier(a.id)}`, false, a.host));
        return { ok: r.ok, msg: r.ok ? `removed ${a.id} on remote host` : r.err };
      })();
    } else {
      const r = runCapture(claudeBin(), ['rm', a.id]);
      res = { ok: r.ok, msg: r.ok ? `rm ${a.id}` : r.err || r.out };
    }
  } else {
    res = kill(a);
  }
  if (!res.ok) return res;
  try {
    if (!existsSync(dirname(ARCHIVE_LOG))) mkdirSync(dirname(ARCHIVE_LOG), { recursive: true });
    appendFileSync(
      ARCHIVE_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        id: a.id,
        sessionId: a.sessionId,
        name: a.name,
        type: a.type,
        host: a.host,
        cwd: a.cwd,
        lastStatus: a.status,
      }) + '\n',
    );
  } catch (e) {
    res.msg += ` (archive-log: ${e.message})`;
  }
  return res;
}

// Identifiers cannot be missing or turn into command options, even when quoted.
function identifier(s) {
  if (typeof s !== 'string' || !s || s.startsWith('-') || /[\x00-\x1f\x7f]/.test(s)) {
    throw new Error('invalid remote identifier');
  }
  return shq(s);
}

export const ACTIONS = { attach, steer, revive, kill, archive };
