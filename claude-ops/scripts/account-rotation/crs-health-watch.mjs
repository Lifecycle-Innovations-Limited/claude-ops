#!/usr/bin/env node
// crs-health-watch.mjs — fleet-level CRS failsafe (single tick; launchd-driven).
//
// PROBLEM: the global CRS default lives in ~/.claude/settings.json `env`
// (ANTHROPIC_BASE_URL=CRS + CLAUDE_CODE_OAUTH_TOKEN=cr_…). settings.json env is
// applied at `claude` startup and OVERRIDES any childEnv a respawn sets — so the
// per-session health-gate in bg-respawn.mjs CANNOT protect new/respawned sessions
// when the relay is down: they'd boot with base=CRS pointing at a dead upstream and
// wedge on connection errors. This watch is the authority over settings.json.
//
// POLICY (hysteresis, no flap):
//   • Probe the health URL from claude-routing-state each tick.
//   • DOWN for DOWN_STRIKES consecutive ticks  → FALLBACK: strip the two CRS env keys
//     from settings.json (new/respawned sessions go direct keychain auth). Drop a
//     marker so we know we're in fallback.
//   • UP for UP_STRIKES consecutive ticks while in fallback → RESTORE: re-add the two
//     CRS env keys. Clear the marker.
//   • Otherwise hold. State (counters + mode) persisted to crs-health-watch.state.json.
//
// It NEVER force-respawns running sessions (avoids thrash). It only flips the global
// default so the fleet self-heals to direct on the next respawn/new session, and back
// to CRS once the relay is solidly up. Manual rollback is independent (see status doc).
//
// CLI: (none)=tick · --status=print mode+counters+current env state · --restore=force
//      restore CRS env now · --fallback=force fail-closed mode now.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { applyRouteToSettings, readRouteState, setRouteMode } from './route-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const STATE = join(__dirname, 'crs-health-watch.state.json');
const MARKER = join(__dirname, 'crs-fallback-active'); // legacy marker present while route is fail-closed
const REBOOT_COOLDOWN_MARKER = join(__dirname, 'crs-reboot-cooldown'); // holds last OS-wedge reboot epoch ms

// dev-us EC2 (us-east-1) serves CRS for the entire fleet. Prefer the canonical
// instance-id sync file; fall back to the known id from project config.
const DEV_US_INSTANCE_ID = (() => {
  const f = join(homedir(), '.claude', 'sync', 'dev-us-instance.id');
  try {
    const v = readFileSync(f, 'utf8').trim();
    if (/^i-[0-9a-f]+$/.test(v)) return v;
  } catch {}
  return 'i-01b4d5132c1b167bf';
})();

function routeCrsConfig() {
  try {
    return readRouteState().crs || {};
  } catch {
    return {};
  }
}

const ROUTE_CRS = routeCrsConfig();
const CRS_BASE = process.env.CRS_BASE_URL || ROUTE_CRS.baseUrl || 'http://127.0.0.1:3000/api';
const HEALTH_URL = process.env.CRS_HEALTH_URL || ROUTE_CRS.healthUrl || CRS_BASE.replace(/\/api\/?$/, '/health');
const CRS_SMOKE_URL = process.env.CRS_SMOKE_URL || `${CRS_BASE}/v1/messages?beta=true`;
const CRS_SMOKE_MODEL = process.env.CRS_SMOKE_MODEL || 'claude-sonnet-4-6';
const DOWN_STRIKES = +(process.env.CRS_DOWN_STRIKES || 3); // ~3 min at 60s tick
const UP_STRIKES = +(process.env.CRS_UP_STRIKES || 1);
// OS-wedge auto-reboot threshold. Must be >= DOWN_STRIKES so we only reboot AFTER
// fail-closed has already protected the fleet (~5 min sustained-down at 60s tick).
const REBOOT_STRIKES = Math.max(DOWN_STRIKES, +(process.env.CRS_REBOOT_STRIKES || 5));
const REBOOT_COOLDOWN_MS = 30 * 60 * 1000; // at most one auto-reboot per 30 min

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} [crs-health-watch] ${m}`);

function readJson(p, d) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}
function loadState() {
  return readJson(STATE, { down: 0, up: 0, mode: 'crs' });
}
function saveState(s) {
  try {
    writeFileSync(STATE, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`state write failed: ${e.message}`);
  }
}

function probe() {
  try {
    const code = execFileSync('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', HEALTH_URL], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return code === '200';
  } catch {
    return false;
  }
}

function probeInference() {
  let key = '';
  try {
    key = readFileSync(join(__dirname, '.crkey'), 'utf8').trim();
  } catch {}
  if (!key.startsWith('cr_')) return false;
  const body = JSON.stringify({
    model: CRS_SMOKE_MODEL,
    max_tokens: 1,
    stream: false,
    messages: [{ role: 'user', content: 'ping' }],
  });
  try {
    const code = execFileSync(
      'curl',
      [
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '25',
        '-H',
        `Authorization: Bearer ${key}`,
        '-H',
        'Content-Type: application/json',
        '-H',
        'anthropic-version: 2023-06-01',
        '-d',
        body,
        CRS_SMOKE_URL,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
    // 529 means CRS selected a valid account and reached Anthropic, but the
    // upstream is temporarily overloaded. That is not a CRS auth/routing fault.
    return /^2\d\d$/.test(code) || code === '529';
  } catch {
    return false;
  }
}

function setEnvMode(mode) {
  try {
    if (mode === 'direct') {
      setRouteMode('fail-closed', { reason: 'crs-health-watch: CRS unavailable', updatedBy: 'crs-health-watch' });
    } else {
      setRouteMode('crs-oauth', { reason: 'crs-health-watch: CRS recovered', updatedBy: 'crs-health-watch' });
    }
    return true;
  } catch (e) {
    log(`route/settings write failed: ${e.message}`);
    return false;
  }
}

function currentEnvMode() {
  const s = readJson(SETTINGS, { env: {} });
  const base = s.env?.ANTHROPIC_BASE_URL || '';
  const tok = s.env?.CLAUDE_CODE_OAUTH_TOKEN || '';
  const bedrock = s.env?.CLAUDE_CODE_USE_BEDROCK || '';
  if (/127\.0\.0\.1:3000|:3000\/api/.test(base) && tok.startsWith('cr_')) return 'crs';
  if (bedrock === '1') return 'bedrock';
  if (!base && !tok) return 'direct';
  return 'mixed';
}

// SSM PingStatus for the dev-us instance. "ConnectionLost" => the SSM agent itself
// is unreachable, i.e. an OS-level wedge (reboot can help). "Online" => OS is fine and
// CRS is merely app-down (reboot is unwarranted). Returns the literal string, or an
// "ERROR:<msg>" sentinel on AWS failure (treated as not-ConnectionLost by callers).
function ssmPingStatus(instanceId) {
  try {
    return execFileSync(
      'aws',
      [
        'ssm',
        'describe-instance-information',
        '--region',
        'us-east-1',
        '--filters',
        `Key=InstanceIds,Values=${instanceId}`,
        '--query',
        'InstanceInformationList[0].PingStatus',
        '--output',
        'text',
      ],
      { encoding: 'utf8', timeout: 30_000 }, // generous: aws CLI cold-starts each tick; this read decides the reboot
    ).trim();
  } catch (e) {
    return `ERROR:${e.message}`;
  }
}

// Milliseconds left on the auto-reboot cooldown (0 = no cooldown / clear to reboot).
function rebootCooldownRemainingMs() {
  try {
    const last = +readFileSync(REBOOT_COOLDOWN_MARKER, 'utf8').trim();
    if (!Number.isFinite(last)) return 0;
    const rem = REBOOT_COOLDOWN_MS - (Date.now() - last);
    return rem > 0 ? rem : 0;
  } catch {
    return 0;
  }
}

// Fire an EC2 reboot ONLY on a double-confirmed OS wedge: CRS sustained-down past
// REBOOT_STRIKES, already fail-closed (fleet protected), SSM says ConnectionLost, and
// no reboot in the last 30 min. Conservative by design — every gate must hold.
function maybeAutoReboot(st, inFallback, healthy) {
  if (healthy || st.down < REBOOT_STRIKES || !inFallback) return;

  const cooldown = rebootCooldownRemainingMs();
  if (cooldown > 0) {
    log(
      `reboot: conditions met (down x${st.down}) but cooldown active (${Math.ceil(cooldown / 60000)}m remaining) → skip`,
    );
    return;
  }
  const ping = ssmPingStatus(DEV_US_INSTANCE_ID);
  if (ping !== 'ConnectionLost') {
    log(
      `reboot: down x${st.down} + fail-closed, but SSM PingStatus=${ping} (not ConnectionLost) → app-level, NOT rebooting`,
    );
    return;
  }
  try {
    execFileSync('aws', ['ec2', 'reboot-instances', '--region', 'us-east-1', '--instance-ids', DEV_US_INSTANCE_ID], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    writeFileSync(REBOOT_COOLDOWN_MARKER, String(Date.now()));
    log(
      `🔁 OS-WEDGE AUTO-REBOOT: CRS down x${st.down} + SSM ConnectionLost → reboot-instances ${DEV_US_INSTANCE_ID} (30m cooldown armed)`,
    );
  } catch (e) {
    log(`WARN: auto-reboot failed: ${e.message}`);
  }
}

function main() {
  if (args.has('--dry-run-reboot')) {
    const st = loadState();
    const healthOk = probe();
    const inferenceOk = healthOk ? probeInference() : false;
    const healthy = healthOk; // mirrors the live tick's health gate
    const inFallback = existsSync(MARKER);
    const ping = ssmPingStatus(DEV_US_INSTANCE_ID);
    const cooldownRemMs = rebootCooldownRemainingMs();
    const wouldReboot =
      !healthy && st.down >= REBOOT_STRIKES && inFallback && ping === 'ConnectionLost' && cooldownRemMs === 0;
    console.log(
      JSON.stringify(
        {
          dryRunReboot: true,
          instanceId: DEV_US_INSTANCE_ID,
          healthy,
          healthOk,
          inferenceOk,
          stDown: st.down,
          rebootStrikes: REBOOT_STRIKES,
          downThresholdMet: st.down >= REBOOT_STRIKES,
          inFallback,
          ssmPingStatus: ping,
          ssmConnectionLost: ping === 'ConnectionLost',
          cooldownRemainingMin: Math.ceil(cooldownRemMs / 60000),
          cooldownActive: cooldownRemMs > 0,
          WOULD_REBOOT: wouldReboot,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.has('--status')) {
    const st = loadState();
    const health = probe();
    const route = readRouteState();
    console.log(
      JSON.stringify(
        {
          state: st,
          routeMode: route.mode,
          fallbackActive: existsSync(MARKER),
          settingsEnvMode: currentEnvMode(),
          healthy: health,
          inferenceHealthy: health ? probeInference() : false,
          smokeModel: CRS_SMOKE_MODEL || null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (args.has('--restore')) {
    if (probe() && probeInference() && setEnvMode('crs')) {
      try {
        execFileSync('rm', ['-f', MARKER]);
      } catch {}
      saveState({ down: 0, up: 0, mode: 'crs' });
      log('FORCED restore → CRS env');
    } else {
      setEnvMode('direct');
      writeFileSync(MARKER, String(Date.now()));
      saveState({ down: 0, up: 0, mode: 'fail-closed' });
      log('FORCED restore refused: CRS health or inference smoke failed → fail-closed env');
      process.exitCode = 1;
    }
    return;
  }
  if (args.has('--fallback')) {
    setEnvMode('direct');
    writeFileSync(MARKER, String(Date.now()));
    saveState({ down: 0, up: 0, mode: 'fail-closed' });
    log('FORCED fallback → fail-closed env');
    return;
  }

  try {
    applyRouteToSettings(readRouteState());
  } catch (e) {
    log(`route apply skipped: ${e.message}`);
  }

  const healthOk = probe();
  const inferenceOk = healthOk ? probeInference() : false;
  const healthy = healthOk && inferenceOk;
  const st = loadState();
  if (healthy) {
    st.up += 1;
    st.down = 0;
  } else {
    st.down += 1;
    st.up = 0;
  }
  const inFallback = existsSync(MARKER);

  if (!healthy && st.down >= DOWN_STRIKES && !inFallback) {
    if (setEnvMode('direct')) {
      writeFileSync(MARKER, String(Date.now()));
      st.mode = 'fail-closed';
      log(
        `CRS DOWN x${st.down} (>=${DOWN_STRIKES}) → FAIL-CLOSED: stripped provider env from settings.json; new/respawned sessions must not silently use direct or Bedrock`,
      );
    }
  } else if (healthy && st.up >= UP_STRIKES && inFallback) {
    if (setEnvMode('crs')) {
      try {
        execFileSync('rm', ['-f', MARKER]);
      } catch {}
      st.mode = 'crs';
      log(
        `CRS UP x${st.up} (>=${UP_STRIKES}) → RESTORE: re-added CRS env to settings.json; new/respawned sessions route via relay again`,
      );
    }
  } else {
    log(
      `tick: health=${healthOk} inference=${inferenceOk} down=${st.down} up=${st.up} fallback=${inFallback} envMode=${currentEnvMode()}`,
    );
  }

  // OS-wedge auto-reboot (double-confirmed via SSM, 30m cooldown). Only fires when CRS
  // is sustained-down past REBOOT_STRIKES, we're already fail-closed, and the SSM agent
  // itself is unreachable (true OS wedge, not an app-level CRS failure).
  maybeAutoReboot(st, inFallback, healthy);
  saveState(st);
}

main();
