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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { automatedAuthAllowed, CLIPROXY_HEAL_OPTIN_TOKEN } from './auto-auth-policy.mjs';
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

// Second unattended-healing gate (see auto-auth-policy.mjs). The path is
// deliberately NOT overridable by its own env var — only CLIPROXY_ROOT (the
// same variable that also relocates auth dir, state, config, etc., so
// changing it is a coordinated redeploy, not a one-line escalation) can move
// it, and even then the filename stays fixed. Existence alone is not
// sufficient: the file's content must equal CLIPROXY_HEAL_OPTIN_TOKEN, which
// only install-heal.sh writes, so an Environment=-only change that points
// at some other pre-existing file (e.g. /etc/hosts) cannot satisfy the gate.
// A marker that is group/other-writable is also rejected — a marker
// install-heal.sh actually wrote is mode 0600.
function accountOptedIn(path) {
  if (!existsSync(path)) return false;
  try {
    const stat = statSync(path);
    if ((stat.mode & 0o022) !== 0) return false;
    return readFileSync(path, 'utf8').trim() === CLIPROXY_HEAL_OPTIN_TOKEN;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function readAuth(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`auth file is not an object: ${path}`);
  }
  return parsed;
}

export function normalizeReauthOutcome(ret) {
  if (ret === true) return { ok: true, blocked: false, reason: 'reauth_ok' };
  if (ret && typeof ret === 'object' && 'ok' in ret) {
    const ok = ret.ok === true;
    return {
      ok,
      blocked: ok ? false : ret.blocked !== false,
      reason: String(ret.reason || (ok ? 'reauth_ok' : 'reauth_failed')).slice(0, 160),
    };
  }
  return { ok: false, blocked: true, reason: 'no_reauth_writer' };
}

export function defaultReauth(decision) {
  const cmd = process.env.CLIPROXY_REAUTH_CMD;
  if (!cmd || !existsSync(cmd)) {
    return { ok: false, blocked: true, reason: 'no_reauth_writer' };
  }
  const r = spawnSync(cmd, [decision.provider || '', decision.rawId || decision.id || '', decision.authFile || ''], {
    timeout: 90_000,
    stdio: 'ignore',
    env: { ...process.env, CLIPROXY_HUB_HEAL: '1' },
  });
  if (r.status === 0) return { ok: true, blocked: false, reason: 'reauth_ok' };
  if (r.status === 2) return { ok: false, blocked: true, reason: 'reauth_checkpoint' };
  if (r.status == null && r.signal) return { ok: false, blocked: true, reason: `reauth_signal_${r.signal}` };
  return { ok: false, blocked: true, reason: `reauth_exit_${r.status ?? 'unknown'}` };
}

export function applyDecision(decision, { dryRun = false, reauth } = {}) {
  const applied = [];
  let blocked = null;
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
    // Only clear the CLIProxy quota sidecar when this seat actually carried a
    // cooldown record: it is still cooling per its own signal, or its
    // reschedule stamp just elapsed (reason 'reschedule_elapsed'). decideSeat
    // also returns inRotation:true for healthy seats with a coincidental
    // leftover .cds file ('remaining_or_reset_quota' with cooling:false) and
    // for uncertain-exhaust seats that were never actually cooling — deleting
    // their sidecar destroys the proxy's own quota/reset-at evidence for no
    // reason and is not reversible. Rename instead of unlink so a mistaken
    // clear can still be recovered from disk.
    if (
      (decision.cooling === true || decision.reason === 'reschedule_elapsed') &&
      decision.cdsFile &&
      existsSync(decision.cdsFile)
    ) {
      applied.push('clear_cooldown');
      if (!dryRun) {
        renameSync(decision.cdsFile, `${decision.cdsFile}.healed`);
      }
    }
    if (decision.tokenStale) {
      const runner = reauth === undefined ? defaultReauth : reauth;
      let outcome = { ok: false, blocked: true, reason: 'no_reauth_writer' };
      if (dryRun) {
        const writerReady =
          typeof reauth === 'function' ||
          (Boolean(process.env.CLIPROXY_REAUTH_CMD) && existsSync(process.env.CLIPROXY_REAUTH_CMD));
        outcome = writerReady
          ? { ok: true, blocked: false, reason: 'reauth_ok' }
          : { ok: false, blocked: true, reason: 'no_reauth_writer' };
      } else if (typeof runner === 'function') {
        outcome = normalizeReauthOutcome(runner(decision));
      }
      if (outcome.ok) applied.push('reauth');
      else {
        applied.push('blocked');
        blocked = { reason: outcome.reason || 'no_reauth_writer', tokenStale: true };
      }
    }
  } else if (decision.rescheduleAt) {
    // persist_reschedule alone only wrote the healer's own state file, which
    // has no consumer inside CLIProxy — the seat stayed advertised and the
    // proxy kept routing to it. Actually remove the seat from rotation using
    // the mechanism CLIProxy itself honors: the `disabled` flag on the auth
    // file. Re-entry still happens exactly when this decision flips (rule 2's
    // reschedule check), which flows through the enable_auth branch above.
    applied.push('persist_reschedule');
    if (decision.authFile && !decision.disabled) {
      applied.push('leave_rotation');
      if (!dryRun) {
        const auth = readAuth(decision.authFile);
        auth.disabled = true;
        auth.disabled_reason = `cliproxy-heal: certain_exhaust_until_reschedule (${decision.rescheduleAt})`;
        auth.healer_disabled_at = new Date().toISOString();
        writeJsonAtomic(decision.authFile, auth);
      }
    }
  }
  return { applied, blocked };
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
  // Two gates on different control planes: CLIPROXY_HUB_HEAL says "this
  // process may mutate credentials at all" (a process env var — settable by
  // editing the systemd unit's Environment= lines or exporting it in a
  // shell). accountOptInMarker says "this host was deliberately provisioned
  // for unattended healing" — it is satisfied only by a marker file, at a
  // fixed path, whose content matches the token only install-heal.sh writes
  // (see accountOptedIn() above). Editing the unit's Environment= lines
  // cannot produce that file or its content, so a single environment flip
  // cannot satisfy both gates.
  const accountOptInMarker = join(process.env.CLIPROXY_ROOT || '/opt/crsproxy', '.heal-account-optin');
  if (!automatedAuthAllowed({ cliproxyHubHeal: accountOptedIn(accountOptInMarker) })) {
    log(
      `heal denied: CLIPROXY_HUB_HEAL unset and/or account opt-in marker missing at ${accountOptInMarker} (Mac client-only; hub must run install-heal.sh and export CLIPROXY_HUB_HEAL=1)`,
    );
    return { denied: true, decisions: [], census: censusFromSeats([], now) };
  }

  const prev = loadState(statePath);
  const { seats, census } = snapshotFromAuthDir(authDir, { now, previous: prev.seats });
  // Resolve the CLIProxy API key once, here, at the single point that is
  // allowed to read it off disk. The result is stored into the same env var
  // that a deployment can also set directly (CLIPROXY_API_KEY) rather than
  // threaded straight into askCliproxyHealer's arguments — so the value
  // askCliproxyHealer's fetch call actually uses always comes from a
  // process.env read, identically to the CLIPROXYAPI_KEY branch, and never
  // from a readFileSync() result flowing directly into that call.
  if (!process.env.CLIPROXY_API_KEY && !process.env.CLIPROXYAPI_KEY) {
    const configKey = readApiKeyFromConfig(process.env.CLIPROXY_CONFIG || '/opt/crsproxy/config.yaml');
    if (configKey) process.env.CLIPROXY_API_KEY = configKey;
  }
  const askFn =
    ask ||
    ((facts) =>
      askCliproxyHealer(facts, {
        baseUrl: process.env.CLIPROXY_HEAL_BASE_URL || process.env.CLIPROXYAPI_BASE_URL || 'http://127.0.0.1:8317',
        apiKey: process.env.CLIPROXY_API_KEY || process.env.CLIPROXYAPI_KEY,
      }));

  const result = await healPool(seats, { now, ask: askFn });
  const actions = [];
  const nextSeats = { ...prev.seats };

  let reauthBudget = 1;
  for (const decision of result.decisions) {
    let runner = reauth;
    if (runner === undefined) {
      runner = (d) => {
        if (reauthBudget <= 0) return { ok: false, blocked: true, reason: 'reauth_budget' };
        reauthBudget -= 1;
        return defaultReauth(d);
      };
    }
    // Isolate each seat: a truncated auth file, a permission error, or a
    // concurrent delete by the proxy must not throw out of the loop and skip
    // every seat after it (and skip saveState entirely). Coding guideline:
    // never silently skip a channel/service/integration — so the failure is
    // logged with the seat's identity rather than swallowed.
    let applied = [];
    let blocked = null;
    try {
      ({ applied, blocked } = applyDecision(decision, { dryRun, reauth: runner }));
    } catch (err) {
      applied = [`error:${String(err?.message || err).slice(0, 120)}`];
      blocked = { reason: 'apply_decision_failed', tokenStale: decision.tokenStale === true };
      log(
        `heal seat failed id=${decision.id} provider=${decision.provider || '?'} action=${decision.action} err=${applied[0]}`,
      );
    }
    actions.push({
      id: decision.id,
      provider: decision.provider,
      inRotation: decision.inRotation,
      action: decision.action,
      reason: decision.reason,
      rescheduleAt: decision.rescheduleAt,
      ai: decision.ai,
      applied,
      blocked,
    });
    nextSeats[decision.id] = {
      remainingQuota: seats.find((s) => s.id === decision.id)?.remainingQuota ?? null,
      quotaExceeded: seats.find((s) => s.id === decision.id)?.quotaExceeded ?? null,
      certainQuotaExhausted: seats.find((s) => s.id === decision.id)?.certainQuotaExhausted === true,
      rescheduleAt: decision.rescheduleAt,
      inRotation: decision.inRotation,
      blocked: blocked || undefined,
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
      blocked: a.blocked || undefined,
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
  if (!isolate.ok) {
    // applyIsolateCompat returns ok:false (e.g. missing_config) without
    // throwing. Silently continuing would leave an unservable openai-compat
    // provider advertised with no signal in the log or the returned result.
    // Surface it explicitly: log it, mark the tick failed in the returned
    // result (so --json / exit-code callers see it), and still persist the
    // seat-level state gathered so far rather than losing that work.
    log(`compat isolation FAILED reason=${isolate.reason || 'unknown'} — unservable providers may still be advertised`);
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
    // Compat isolation failing is not a full tick failure (seat healing
    // above still ran and was persisted), but it is a failure the caller
    // must not treat as a clean run. Callers (the --json / exit-code CLI
    // below, or any other consumer of runHealTick) key off this field
    // instead of having to know to inspect isolate.ok themselves.
    failed: !isolate.ok,
    dryRun,
    census,
    seats: seats.map(redactSeat),
    decisions: result.decisions,
    actions,
    state,
    isolate,
  };
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('--status');
  const dirFlag = args.indexOf('--auth-dir');
  const dirValue = dirFlag >= 0 ? args[dirFlag + 1] : undefined;
  if (dirFlag >= 0 && (!dirValue || dirValue.startsWith('--'))) {
    console.error('--auth-dir requires a directory path');
    process.exit(2);
  }
  const authDir = dirFlag >= 0 ? dirValue : defaultAuthDir();
  runHealTick({ authDir, dryRun, now: Date.now() })
    .then((out) => {
      if (args.includes('--json')) {
        const json = {
          denied: out.denied,
          failed: out.failed === true,
          census: out.census,
          actions: out.actions,
        };
        process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      }
      process.exit(out.denied ? 2 : out.failed ? 3 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
