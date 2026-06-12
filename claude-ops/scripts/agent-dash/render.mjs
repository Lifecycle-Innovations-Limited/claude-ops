// render.mjs — pure formatting for agent-dash. No I/O; takes a fleet snapshot
// and returns ANSI strings. Raw escape codes (no deps), statusline-style.

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
  brightYellow: '\x1b[93m', brightRed: '\x1b[91m', brightGreen: '\x1b[92m',
  invert: '\x1b[7m',
};

// status → { dot, color, label }
const STATUS = {
  working:    { dot: '●', color: C.green,        label: 'working'  },
  idle:       { dot: '○', color: C.gray,         label: 'idle'     },
  'needs-sam':{ dot: '◆', color: C.brightYellow, label: 'NEEDS YOU'},
  blocked:    { dot: '■', color: C.magenta,      label: 'blocked'  },
  stuck:      { dot: '▲', color: C.yellow,       label: 'stuck'    },
  dead:       { dot: '✕', color: C.brightRed,    label: 'dead'     },
  zombie:     { dot: '☠', color: C.red + C.dim,  label: 'zombie'   },
};

const TYPE_GLYPH = {
  claude: 'cc', agy: 'agy', codex: 'cdx', cursor: 'cur', openclaw: 'ocl', other: '·',
};

export const STATUS_ORDER = ['needs-sam', 'blocked', 'stuck', 'working', 'idle', 'zombie', 'dead'];

function pad(s, n) {
  s = String(s ?? '');
  if (s.length > n) return s.slice(0, n - 1) + '…';
  return s + ' '.repeat(n - s.length);
}

function ageStr(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Sort: needs-you first, then by status order, then most-recent activity.
export function sortAgents(agents) {
  return [...agents].sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a.status);
    const bi = STATUS_ORDER.indexOf(b.status);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}

// Render a single agent row. `width` drives responsive column dropping.
function row(a, width, selected) {
  const st = STATUS[a.status] || STATUS.idle;
  const sel = selected ? C.invert : '';
  const ty = TYPE_GLYPH[a.type] || a.type.slice(0, 3);

  const dot = `${st.color}${st.dot}${C.reset}${sel}`;
  const statusLbl = `${st.color}${pad(st.label, 9)}${C.reset}${sel}`;
  const name = pad(a.name || a.id, 18);
  const doing = a.needs_user && a.decision ? `${C.brightYellow}? ${a.decision}${C.reset}${sel}` : (a.doing || `${C.gray}—${C.reset}${sel}`);
  const age = pad(ageStr(a.lastActivity), 4);

  let line;
  if (width < 80) {
    // narrow: dot + type + name + status
    line = ` ${dot} ${C.dim}${pad(ty, 3)}${C.reset}${sel} ${name} ${statusLbl}`;
  } else if (width < 110) {
    line = ` ${dot} ${C.dim}${pad(ty, 3)}${C.reset}${sel} ${name} ${statusLbl} ${pad(stripWidth(doing), Math.max(10, width - 48))}`;
  } else {
    const doingW = width - 56;
    line = ` ${dot} ${C.dim}${pad(ty, 3)}${C.reset}${sel} ${name} ${statusLbl} ${age}  ${truncAnsi(doing, doingW)}`;
  }
  return selected ? `${C.invert}${line}${C.reset}` : line;
}

// width of a string ignoring ANSI codes
function stripWidth(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
function truncAnsi(s, n) {
  // crude: if visible length exceeds n, slice the visible text
  const vis = stripWidth(s);
  if (vis.length <= n) return s;
  return vis.slice(0, n - 1) + '…' + C.reset;
}

export function renderDashboard(snapshot, { width = 100, selectedIdx = 0, statusLine = '' } = {}) {
  const lines = [];
  const agents = sortAgents(snapshot.agents);
  const total = agents.length;
  const needs = agents.filter((a) => a.status === 'needs-sam').length;
  const fra = snapshot.hosts?.fra || {};
  const fraTag = fra.stale ? `${C.red}stale${C.reset}` : fra.cached ? `${C.gray}cached${C.reset}` : `${C.green}live${C.reset}`;

  // header
  lines.push(
    `${C.bold}${C.cyan}AGENT-DASH${C.reset}  ${C.bold}${total}${C.reset} agents` +
    `  ${C.dim}·${C.reset} mac ${snapshot.hosts?.mac?.count ?? 0}` +
    `  ${C.dim}·${C.reset} fra ${fra.count ?? 0} (${fraTag})` +
    (needs ? `  ${C.brightYellow}${C.bold}◆ ${needs} need you${C.reset}` : '') +
    `  ${C.gray}${new Date(snapshot.ts).toLocaleTimeString()}${C.reset}`,
  );
  lines.push(`${C.gray}${'─'.repeat(Math.min(width, 120))}${C.reset}`);

  // group by host
  const byHost = {};
  agents.forEach((a, i) => { (byHost[a.host] ||= []).push({ a, i }); });
  const hostOrder = ['mac', 'fra', ...Object.keys(byHost).filter((h) => h !== 'mac' && h !== 'fra')];

  let flat = 0;
  const indexMap = []; // flat selectable index -> agent
  for (const host of hostOrder) {
    const group = byHost[host];
    if (!group || !group.length) continue;
    lines.push(`${C.bold}${C.blue}▾ ${host.toUpperCase()}${C.reset} ${C.gray}(${group.length})${C.reset}`);
    for (const { a } of group) {
      indexMap.push(a);
      lines.push(row(a, width, flat === selectedIdx));
      flat++;
    }
  }
  if (!flat) lines.push(`  ${C.gray}(no agents found)${C.reset}`);

  // footer
  lines.push(`${C.gray}${'─'.repeat(Math.min(width, 120))}${C.reset}`);
  lines.push(hotkeyBar());
  if (statusLine) lines.push(statusLine);

  return { text: lines.join('\n'), indexMap };
}

export function hotkeyBar() {
  const k = (key, lbl) => `${C.bold}${C.cyan}${key}${C.reset}${C.gray}${lbl}${C.reset}`;
  return [
    k('↑↓/jk', ' move'),
    k(' a', 'ttach'),
    k(' s', 'teer'),
    k(' r', 'evive'),
    k(' k', 'ill'),
    k(' x', ' archive'),
    k(' ↵', ' details'),
    k(' R', 'efresh'),
    k(' q', 'uit'),
  ].join(`${C.gray} ·${C.reset}`);
}

// Plain (no-ANSI-cursor) one-shot table for non-TTY / --watch logs.
export function renderPlain(snapshot, width = 100) {
  return renderDashboard(snapshot, { width, selectedIdx: -1 }).text;
}

export { C };
