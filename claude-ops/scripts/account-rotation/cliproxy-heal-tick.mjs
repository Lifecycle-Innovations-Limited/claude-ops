#!/usr/bin/env node
/**
 * Unattended CLIProxy healer tick.
 *
 * Reads auth-dir json + .cds, runs healPool (hard rules + AI advisor),
 * then applies: enable leftover-quota seats, clear stale cooldowns, persist
 * reschedule stamps, request reauth for stale tokens.
 *
 * Hub systemd sets CLIPROXY_HUB_HEAL=1. Without that flag this process
 * refuses to mutate credentials (Mac stays client-only).
 *
 *   node cliproxy-heal-tick.mjs [--dry-run] [--status] [--auth-dir DIR]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { automatedAuthAllowed } from './auto-auth-policy.mjs';
import { healPool } from './cliproxy-heal-policy.mjs';
import { askCliproxyHealer } from './cliproxy-heal-ai.mjs';
import { censusFromSeats, redactSeat, snapshotFromAuthDir } from './cliproxy-pool-snapshot.mjs';
import { applyIsolateCompat } from './cliproxy-isolate-compat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultAuthDir() {
  return process.env.CLIPROXY_AUTH_DIR || '/opt/crsproxy/auths';
}

export function defaultStatePath(authDir) {
  return process.env.CLIPROXY_HEAL_STATE || join(dirname(authDir), '.cliproxy-heal-state.json');
}

function loadState(path) {
  if (!path || !existsSync(path)) return { version: 1, seats: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, seats: {} };
    if (!parsed.seats || typeof parsed.seats !== 'object') parsed.seats = {};
    return parsed;
  } catch {
    return { version: 1, seats: {} };
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function readAuth(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function applyDecision(decision, { dryRun = false, reauth } = {}) {
  const applied = [];
  if (decision.inRotation) {
    if (decision.disabled && decision.authFile) {
      applied.push('enable_auth');
      if (!dryRun) {
        const auth = readAuth(decision.authFile);
        auth.disabled = false;
        delete auth.disabled_reason;
        auth.healer_enabled_at = new Date().toISOString();
        writeJsonAtomic(decision.authFile, auth);
      }
    }
    if (decision.cdsFile && existsSync(decision.cdsFile)) {
      applied.push('clear_cooldown');
      if (!dryRun) {
        unlinkSync(decision.cdsFile);
      }
    }
    if (decision.tokenStale) {
      applied.push('reauth');
      if (!dryRun && typeof reauth === 'function') {
        reauth(decision);
      }
    }
  } else if (decision.rescheduleAt) {
    applied.push('persist_reschedule');
  }
  return applied;
}

function defaultReauth(decision) {
  const cmd = process.env.CLIPROXY_REAUTH_CMD;
  if (!cmd) return;
  spawnSync(cmd, [decision.provider || '', decision.id || ''], {
    timeout: 120_000,
    stdio: 'ignore',
    env: { ...process.env, CLIPROXY_HUB_HEAL: '1' },
  });
}

function readApiKeyFromConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return '';
  try {
    const text = readFileSync(configPath, 'utf8');
    const m = text.match(/api-keys:\s*\n(?:- |\s+- )([^\s#]+)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

export async function runHealTick({
  authDir = defaultAuthDir(),
  statePath = defaultStatePath(authDir),
  now = Date.now(),
  ask,
  dryRun = false,
  log = console.log,
  reauth,
} = {}) {
  if (!automatedAuthAllowed({ cliproxyHubHeal: true })) {
    log('heal denied: CLIPROXY_HUB_HEAL not set (Mac client-only; hub systemd must export it)');
    return { denied: true, decisions: [], census: censusFromSeats([], now) };
  }

  const prev = loadState(statePath);
  const { seats, census } = snapshotFromAuthDir(authDir, { now, previous: prev.seats });
  const askFn =
    ask ||
    ((facts) =>
      askCliproxyHealer(facts, {
        baseUrl: process.env.CLIPROXY_HEAL_BASE_URL || process.env.CLIPROXYAPI_BASE_URL || 'http://127.0.0.1:8317',
        apiKey:
          process.env.CLIPROXY_API_KEY ||
          process.env.CLIPROXYAPI_KEY ||
          readApiKeyFromConfig(process.env.CLIPROXY_CONFIG || '/opt/crsproxy/config.yaml'),
      }));

  const result = await healPool(seats, { now, ask: askFn });
  const actions = [];
  const nextSeats = { ...prev.seats };

  for (const decision of result.decisions) {
    const applied = applyDecision(decision, { dryRun, reauth: reauth === undefined ? defaultReauth : reauth });
    actions.push({
      id: decision.id,
      provider: decision.provider,
      inRotation: decision.inRotation,
      action: decision.action,
      reason: decision.reason,
      rescheduleAt: decision.rescheduleAt,
      ai: decision.ai,
      applied,
    });
    nextSeats[decision.id] = {
      remainingQuota: seats.find((s) => s.id === decision.id)?.remainingQuota ?? null,
      quotaExceeded: seats.find((s) => s.id === decision.id)?.quotaExceeded ?? null,
      certainQuotaExhausted: seats.find((s) => s.id === decision.id)?.certainQuotaExhausted === true,
      rescheduleAt: decision.rescheduleAt,
      inRotation: decision.inRotation,
      updatedAt: new Date(now).toISOString(),
    };
  }

  const state = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    census,
    seats: nextSeats,
    lastTick: actions.map((a) => ({
      id: a.id,
      provider: a.provider,
      inRotation: a.inRotation,
      action: a.action,
      reason: a.reason,
      rescheduleAt: a.rescheduleAt,
      aiInvoked: a.ai?.invoked === true,
      aiApplied: a.ai?.applied === true,
      applied: a.applied,
    })),
  };
  const isolate = applyIsolateCompat({
    configPath: process.env.CLIPROXY_CONFIG || '/opt/crsproxy/config.yaml',
    isolateDir: process.env.CLIPROXY_ISOLATE_DIR || join(dirname(authDir), 'isolated'),
    manifestPath: process.env.CLIPROXY_ISOLATE_MANIFEST || join(dirname(authDir), 'isolated', 'manifest.json'),
    dryRun,
  });
  if (isolate.removed?.length) {
    log(`isolated unservable compat providers: ${isolate.removed.join(',')}`);
  }

  if (!dryRun) saveState(statePath, { ...state, isolate });

  log(
    `heal tick seats=${seats.length} enter=${actions.filter((a) => a.inRotation).length} out=${actions.filter((a) => !a.inRotation).length} dry=${dryRun}`,
  );
  for (const a of actions) {
    log(
      `  ${a.provider || '?'} ${a.action} in=${a.inRotation} reason=${a.reason} ai=${a.ai?.invoked ? (a.ai.applied ? 'applied' : a.ai.reason) : 'skip'} applied=${(a.applied || []).join(',') || 'none'} until=${a.rescheduleAt || '-'}`,
    );
  }

  return {
    denied: false,
    dryRun,
    census,
    seats: seats.map(redactSeat),
    decisions: result.decisions,
    actions,
    state,
  };
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('--status');
  const dirFlag = args.indexOf('--auth-dir');
  const authDir = dirFlag >= 0 ? args[dirFlag + 1] : defaultAuthDir();
  runHealTick({ authDir, dryRun, now: Date.now() })
    .then((out) => {
      if (args.includes('--json')) {
        const json = {
          denied: out.denied,
          census: out.census,
          actions: out.actions,
        };
        process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      }
      process.exit(out.denied ? 2 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
