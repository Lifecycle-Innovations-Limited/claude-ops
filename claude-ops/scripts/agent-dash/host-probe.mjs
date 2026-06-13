#!/usr/bin/env node
// host-probe.mjs — single-host fleet probe for agent-dash.
//
// Emits one JSON array of agent records for THIS host. Runs identically on the
// local Mac and (piped over ssh) on the FRA EC2 box, so derivation logic lives
// in exactly one place. No external deps — fs + child_process only.
//
// Env:
//   AGENT_DASH_HOST   host label baked into every record (default: "local")
//
// Every probe has a hard timeout; a wedged surface degrades to empty, never hangs.

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const HOST = process.env.AGENT_DASH_HOST || 'local';
const HOME = homedir();
const NOW = Date.now();
const STUCK_MS = 10 * 60 * 1000; // pending tool-use + no activity > 10min => stuck
const WORKING_MS = 120 * 1000; // transcript activity within 2min => actively working

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// --- helpers ---------------------------------------------------------------

function sh(cmd, timeoutMs = 9000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function firstLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// --- claude bg/interactive sessions ---------------------------------------

function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function transcriptPath(cwd, sessionId) {
  const dir = join(HOME, '.claude', 'projects', encodeCwd(cwd));
  const p = join(dir, `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}

// Read only the last `maxBytes` of a (possibly 50MB+) jsonl transcript via a
// positioned read — never loads the whole file. Drops the first (partial) line.
function tailLines(path, maxBytes = 96 * 1024) {
  let fd;
  try {
    const st = statSync(path);
    const len = Math.min(maxBytes, st.size);
    const start = st.size - len;
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0 && lines.length) lines.shift(); // first line is likely partial
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Derive "what it's doing now" + needs-user/decision from a transcript tail.
function deriveFromTranscript(path) {
  const out = { doing: null, needsUser: false, decision: null, lastActivity: 0, pendingToolUse: false };
  const lines = tailLines(path);
  if (!lines.length) return out;

  // last event timestamp
  for (let i = lines.length - 1; i >= 0 && !out.lastActivity; i--) {
    try {
      const ts = JSON.parse(lines[i]).timestamp;
      if (ts) out.lastActivity = new Date(ts).getTime();
    } catch {
      /* skip */
    }
  }

  // Walk backward for the most recent meaningful action; detect an
  // AskUserQuestion tool_use with no following tool_result (in-flight => needs-sam).
  const pendingToolUseIds = new Set();
  const satisfiedToolUseIds = new Set();
  let askText = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = ev.message || ev;
    const role = msg.role || ev.type;
    const content = msg.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          satisfiedToolUseIds.add(block.tool_use_id);
        }
        if (block.type === 'tool_use') {
          const name = block.name || '';
          if (/AskUserQuestion|ExitPlanMode/i.test(name) && !satisfiedToolUseIds.has(block.id)) {
            pendingToolUseIds.add(block.id);
            // pull a human-readable question
            try {
              const q = block.input?.questions?.[0]?.question || block.input?.plan;
              if (q && !askText) askText = firstLine(q);
            } catch {
              /* skip */
            }
          }
          if (!out.doing) out.doing = `→ ${name}`;
        }
        if (block.type === 'text' && !out.doing) {
          const t = firstLine(block.text);
          if (t) out.doing = t;
        }
      }
    } else if (typeof content === 'string' && !out.doing) {
      out.doing = firstLine(content);
    }
    if (out.doing && out.lastActivity) break;
  }

  if (pendingToolUseIds.size > 0) {
    out.needsUser = true;
    out.decision = askText || 'awaiting user decision';
  }
  // any tool_use without a tool_result = work in flight (used for stuck detection)
  out.pendingToolUse =
    [...satisfiedToolUseIds].length < lines.length && hasUnsatisfiedToolUse(lines, satisfiedToolUseIds);
  return out;
}

// True if the LAST assistant turn issued a tool_use that has no matching tool_result.
function hasUnsatisfiedToolUse(lines, satisfied) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = ev.message || ev;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const role = msg.role || ev.type;
    if (role === 'assistant') {
      for (const b of content) {
        if (b.type === 'tool_use' && !satisfied.has(b.id)) return true;
      }
      return false; // most recent assistant turn fully satisfied
    }
  }
  return false;
}

// Pull the friendly --name / -n value out of a worker's recorded launch args.
function nameFromFlagArgs(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--name') && args[i + 1]) return args[i + 1];
    if (typeof args[i] === 'string' && args[i].startsWith('--name=')) return args[i].slice(7);
  }
  return null;
}

// Inventory claude bg sessions from the daemon roster (instant) — the CLI's
// `claude agents --json` is authoritative but ~25-30s cold, far too slow for a
// live dashboard. Roster + transcript + pid-liveness yields the same picture
// in milliseconds and is actually MORE real-time than the CLI's cached state.
function probeClaude() {
  const rosterPath = join(HOME, '.claude', 'daemon', 'roster.json');
  if (!existsSync(rosterPath)) return [];
  let roster;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch {
    return [];
  }
  const workers = roster.workers || {};

  return Object.entries(workers).map(([short, w]) => {
    const sessionId = w.sessionId || w.dispatch?.sessionId || null;
    const name = nameFromFlagArgs(w.dispatch?.launch?.flagArgs) || short;
    const alive = pidAlive(w.pid);
    const rec = {
      type: 'claude',
      host: HOST,
      id: short,
      sessionId,
      pid: w.pid ?? null,
      name,
      cwd: w.cwd || w.dispatch?.cwd || '',
      kind: 'background',
      isolation: w.dispatch?.isolation?.mode || null,
      doing: null,
      status: 'idle',
      needs_user: false,
      decision: null,
      lastActivity: w.startedAt || 0,
    };

    let pending = false;
    if (sessionId && rec.cwd) {
      const tp = transcriptPath(rec.cwd, sessionId);
      if (tp) {
        const d = deriveFromTranscript(tp);
        if (d.doing) rec.doing = d.doing;
        if (d.lastActivity) rec.lastActivity = d.lastActivity;
        rec.needs_user = d.needsUser;
        rec.decision = d.decision;
        pending = d.pendingToolUse;
      }
    }

    const idleFor = rec.lastActivity ? NOW - rec.lastActivity : Infinity;
    if (!alive)
      rec.status = 'zombie'; // roster entry, dead pid
    else if (rec.needs_user) rec.status = 'needs-sam';
    else if (pending && idleFor > STUCK_MS) rec.status = 'stuck';
    else if (idleFor < WORKING_MS) rec.status = 'working';
    else rec.status = 'idle';
    return rec;
  });
}

// --- agy (Antigravity) conversations --------------------------------------

function probeAgy(psLines) {
  const convDir = join(HOME, '.gemini', 'antigravity-cli', 'conversations');
  if (!existsSync(convDir)) return [];
  // alive agy process? — used to mark the freshest conversation live vs dormant
  const agyAlive = psLines.some((l) => /\bagy\b/.test(l) && !/grep/.test(l));
  const logDir = join(HOME, '.gemini', 'antigravity-cli', 'log');

  let dbs = [];
  try {
    dbs = readdirSync(convDir).filter((f) => f.endsWith('.db'));
  } catch {
    return [];
  }

  // surface only the few most-recently-touched conversations to avoid noise
  const ranked = dbs
    .map((f) => {
      const p = join(convDir, f);
      let mt = 0;
      try {
        mt = statSync(p).mtimeMs;
      } catch {
        /* skip */
      }
      return { uuid: f.replace(/\.db$/, ''), mtime: mt };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5)
    .filter((c) => NOW - c.mtime < 24 * 60 * 60 * 1000); // touched in last 24h

  return ranked.map((c, i) => {
    const fresh = NOW - c.mtime < STUCK_MS;
    return {
      type: 'agy',
      host: HOST,
      id: c.uuid.slice(0, 8),
      sessionId: c.uuid,
      pid: null,
      name: `agy:${c.uuid.slice(0, 8)}`,
      cwd: logDir,
      kind: 'background',
      doing: agyAlive && i === 0 && fresh ? 'agy session active' : 'conversation (resume w/ --conversation)',
      status: agyAlive && i === 0 && fresh ? 'working' : 'idle',
      needs_user: false,
      decision: null,
      lastActivity: c.mtime,
    };
  });
}

// --- other CLI agents via process table -----------------------------------

function probeProcs(psLines) {
  // openclaw, codex (cli app-server), cursor-agent
  const out = [];
  const lines = psLines;
  const seen = new Set();
  const matchers = [
    { type: 'openclaw', re: /\bopenclaw\b/, skip: /grep/ },
    { type: 'codex', re: /codex app-server|Codex\.app.*codex/, skip: /Helper|crashpad|Renderer|grep/ },
    { type: 'cursor', re: /cursor-agent/, skip: /grep/ },
  ];
  for (const line of lines) {
    for (const m of matchers) {
      if (m.re.test(line) && !m.skip.test(line)) {
        const pid = (line.trim().split(/\s+/)[0] || '').trim();
        const key = `${m.type}:${pid}`;
        if (!pid || seen.has(key) || seen.has(m.type)) continue;
        // collapse to one record per type per host (these spawn many helpers)
        seen.add(m.type);
        out.push({
          type: m.type,
          host: HOST,
          id: pid,
          sessionId: null,
          pid: Number(pid) || null,
          name: m.type,
          cwd: '',
          kind: 'background',
          doing: `${m.type} process running`,
          status: 'working',
          needs_user: false,
          decision: null,
          lastActivity: NOW,
        });
      }
    }
  }
  return out;
}

// --- assemble --------------------------------------------------------------

function main() {
  const all = [];
  // one shared process snapshot for agy-liveness + other-agent detection
  const psLines = sh('ps -eo pid,command 2>/dev/null || ps awwxo pid,command', 5000).split('\n').filter(Boolean);
  try {
    all.push(...probeClaude());
  } catch {
    /* degrade */
  }
  try {
    all.push(...probeAgy(psLines));
  } catch {
    /* degrade */
  }
  try {
    all.push(...probeProcs(psLines));
  } catch {
    /* degrade */
  }
  process.stdout.write(JSON.stringify(all));
}

main();
