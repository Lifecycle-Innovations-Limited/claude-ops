#!/usr/bin/env node
/**
 * seat-policy-tick.mjs — conservative schedulable policy against local seat-state.
 * Reads optional live util from rotate.mjs --utilization JSON if present.
 *
 * Usage:
 *   node seat-policy-tick.mjs [--dry-run] [--status]
 *
 * Env:
 *   OPS_ACCOUNTS_OFF_5H (default 85)  OPS_ACCOUNTS_ON_5H (default 60)
 *   OPS_ACCOUNTS_OFF_7D (default 90)  OPS_ACCOUNTS_ON_7D (default 70)
 *   OPS_ACCOUNTS_FLOOR (default 2)    minimum seats kept schedulable
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_PATH = process.env.OPS_ACCOUNTS_STATE_PATH || join(DATA, 'account-rotation', 'seat-state.json');

const DRY = process.argv.includes('--dry-run');
const STATUS = process.argv.includes('--status');
const OFF5 = num(process.env.OPS_ACCOUNTS_OFF_5H, 85);
const ON5 = num(process.env.OPS_ACCOUNTS_ON_5H, 60);
const OFF7 = num(process.env.OPS_ACCOUNTS_OFF_7D, 90);
const ON7 = num(process.env.OPS_ACCOUNTS_ON_7D, 70);
const FLOOR = num(process.env.OPS_ACCOUNTS_FLOOR, 2);

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function load() {
  if (!existsSync(STATE_PATH)) {
    return { version: 1, updatedAt: null, providers: { claude: { seats: {} } } };
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function save(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

function tryLiveUtil() {
  const rot = join(__dirname, 'rotate.mjs');
  if (!existsSync(rot)) return {};
  const r = spawnSync(process.execPath, [rot, '--utilization', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0 || !r.stdout) return {};
  try {
    const data = JSON.parse(r.stdout);
    const map = {};
    const rows = Array.isArray(data) ? data : data.accounts || data.utilization || [];
    for (const row of rows) {
      const email = row.email || row.name || row.id;
      if (!email) continue;
      map[email] = {
        util5h: row.fiveHour ?? row.util5h ?? row['5h'] ?? null,
        util7d: row.sevenDay ?? row.util7d ?? row['7d'] ?? null,
      };
    }
    return map;
  } catch {
    return {};
  }
}

const state = load();
if (!state.providers?.claude) state.providers = { ...state.providers, claude: { seats: {} } };
const seats = state.providers.claude.seats || {};
const live = tryLiveUtil();

// merge live util
for (const [email, u] of Object.entries(live)) {
  if (!seats[email]) {
    seats[email] = {
      schedulable: true,
      util5h: null,
      util7d: null,
      exhaustedUntil: null,
      lastError: null,
      updatedAt: null,
    };
  }
  if (u.util5h != null) seats[email].util5h = u.util5h;
  if (u.util7d != null) seats[email].util7d = u.util7d;
  seats[email].updatedAt = new Date().toISOString();
}
state.providers.claude.seats = seats;

const emails = Object.keys(seats);
const decisions = [];
for (const email of emails) {
  const s = seats[email];
  const u5 = s.util5h;
  const u7 = s.util7d;
  let desired = s.schedulable !== false;
  let reason = 'hold';
  if (u5 != null && u5 >= OFF5) {
    desired = false;
    reason = `5h=${u5}>=${OFF5}`;
  } else if (u7 != null && u7 >= OFF7) {
    desired = false;
    reason = `7d=${u7}>=${OFF7}`;
  } else if (s.schedulable === false) {
    if ((u5 == null || u5 <= ON5) && (u7 == null || u7 <= ON7)) {
      desired = true;
      reason = `recover 5h=${u5} 7d=${u7}`;
    }
  } else {
    desired = true;
    reason = 'ok';
  }
  decisions.push({ email, cur: s.schedulable !== false, desired, reason, u5, u7 });
}

// floor: keep minimum on
let onCount = decisions.filter((d) => d.desired).length;
if (onCount < FLOOR) {
  const softOff = decisions
    .filter((d) => !d.desired && !String(d.reason).startsWith('7d='))
    .sort((a, b) => (a.u5 ?? 0) - (b.u5 ?? 0));
  for (const d of softOff) {
    if (onCount >= FLOOR) break;
    d.desired = true;
    d.reason = `FLOOR(${FLOOR}): ${d.reason}`;
    onCount++;
  }
}

if (STATUS || DRY) {
  console.log(`seat-policy @ ${STATE_PATH} dry=${DRY}`);
  for (const d of decisions) {
    const mark = d.cur === d.desired ? ' ' : d.desired ? '+' : '-';
    console.log(
      `  ${mark} ${d.email}  sched ${d.cur}→${d.desired}  5h=${d.u5 ?? '—'} 7d=${d.u7 ?? '—'}  (${d.reason})`,
    );
  }
  if (STATUS && !DRY) process.exit(0);
}

let changed = 0;
if (!DRY) {
  for (const d of decisions) {
    if (d.cur === d.desired) continue;
    seats[d.email].schedulable = d.desired;
    seats[d.email].updatedAt = new Date().toISOString();
    changed++;
    console.log(`${d.email}: schedulable ${d.cur}→${d.desired} (${d.reason})`);
  }
  state.providers.claude.seats = seats;
  save(state);
}
console.log(`tick: ${changed} change(s), schedulable=${decisions.filter((d) => d.desired).length}/${decisions.length}`);
