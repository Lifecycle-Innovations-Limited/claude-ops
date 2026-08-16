#!/usr/bin/env node
/**
 * seat-state.mjs — local multi-provider seat state.
 *
 * File-backed store used by ops-accounts policy when backend=local.
 * Schema is provider-agnostic; other backends can dual-write into it.
 *
 * Usage:
 *   node seat-state.mjs status
 *   node seat-state.mjs list [provider]
 *   node seat-state.mjs set <provider> <email> key=value …
 *   node seat-state.mjs toggle <provider> <email> schedulable=true|false
 *   node seat-state.mjs path
 *
 * Env:
 *   OPS_ACCOUNTS_STATE_PATH  override store path
 *   CLAUDE_PLUGIN_DATA_DIR   default parent for state
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const DATA = process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_PATH = process.env.OPS_ACCOUNTS_STATE_PATH || join(DATA, 'account-rotation', 'seat-state.json');

function empty() {
  return {
    version: 1,
    updatedAt: null,
    providers: {
      // claude: { seats: { [email]: { schedulable, util5h, util7d, lastError, updatedAt } } }
    },
  };
}

function load() {
  if (!existsSync(STATE_PATH)) return empty();
  try {
    return { ...empty(), ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return empty();
  }
}

function save(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

function ensureSeat(state, provider, email) {
  if (!state.providers[provider]) state.providers[provider] = { seats: {} };
  if (!state.providers[provider].seats[email]) {
    state.providers[provider].seats[email] = {
      schedulable: true,
      util5h: null,
      util7d: null,
      exhaustedUntil: null,
      lastError: null,
      updatedAt: null,
    };
  }
  return state.providers[provider].seats[email];
}

function printStatus(state) {
  console.log(`seat-state: ${STATE_PATH}`);
  console.log(`updatedAt: ${state.updatedAt || '(never)'}`);
  const providers = Object.keys(state.providers || {});
  if (!providers.length) {
    console.log('(no seats — import from provider status or set …)');
    return;
  }
  for (const p of providers) {
    const seats = state.providers[p].seats || {};
    const emails = Object.keys(seats);
    const on = emails.filter((e) => seats[e].schedulable !== false);
    console.log(`\n=== ${p} ===  schedulable ${on.length}/${emails.length}`);
    for (const e of emails) {
      const s = seats[e];
      const flag = s.schedulable === false ? 'off' : 'on';
      const u5 = s.util5h == null ? '—' : `${s.util5h}%`;
      const u7 = s.util7d == null ? '—' : `${s.util7d}%`;
      console.log(`  [${flag}] ${e}  5h=${u5} 7d=${u7}`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
const state = load();

switch (cmd) {
  case 'path':
    console.log(STATE_PATH);
    break;
  case 'status':
  case undefined:
  case '':
    printStatus(state);
    break;
  case 'list': {
    const provider = args[0];
    if (provider) {
      console.log(JSON.stringify(state.providers[provider] || { seats: {} }, null, 2));
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    break;
  }
  case 'set': {
    const [provider, email, ...kvs] = args;
    if (!provider || !email || !kvs.length) {
      console.error('usage: seat-state set <provider> <email> key=value …');
      process.exit(2);
    }
    const seat = ensureSeat(state, provider, email);
    for (const kv of kvs) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const k = kv.slice(0, i);
      let v = kv.slice(i + 1);
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v === 'null') v = null;
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      seat[k] = v;
    }
    seat.updatedAt = new Date().toISOString();
    save(state);
    console.log(`ok: ${provider} ${email}`);
    break;
  }
  case 'toggle': {
    const [provider, email, flag] = args;
    if (!provider || !email) {
      console.error('usage: seat-state toggle <provider> <email> [true|false]');
      process.exit(2);
    }
    const seat = ensureSeat(state, provider, email);
    if (flag === 'true' || flag === 'false') seat.schedulable = flag === 'true';
    else seat.schedulable = !seat.schedulable;
    seat.updatedAt = new Date().toISOString();
    save(state);
    console.log(`ok: ${provider} ${email} schedulable=${seat.schedulable}`);
    break;
  }
  case 'import-claude-config': {
    // Best-effort: seed emails from rotation config (no tokens)
    const candidates = [
      join(DATA, 'account-rotation', 'config.json'),
      join(homedir(), '.claude', 'plugins', 'data', 'ops', 'account-rotation', 'config.json'),
    ].filter(Boolean);
    let cfg = null;
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          cfg = JSON.parse(readFileSync(p, 'utf8'));
          break;
        } catch {
          /* next */
        }
      }
    }
    if (!cfg?.accounts?.length) {
      console.error('no accounts in rotation config');
      process.exit(1);
    }
    for (const a of cfg.accounts) {
      const email = a.email || a.label;
      if (!email) continue;
      ensureSeat(state, 'claude', email);
      state.providers.claude.seats[email].updatedAt = new Date().toISOString();
    }
    save(state);
    console.log(`ok: imported ${cfg.accounts.length} claude seats`);
    break;
  }
  default:
    console.error('usage: seat-state status|list|set|toggle|import-claude-config|path');
    process.exit(2);
}
