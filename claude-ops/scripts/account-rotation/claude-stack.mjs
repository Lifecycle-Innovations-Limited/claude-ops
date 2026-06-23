#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { applyRouteToSettings, routeStatus, setRouteMode } from './route-state.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'status';

function has(flag) {
  return args.includes(flag);
}

function valueOf(flag, fallback = '') {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function curlOk(url, timeoutSeconds = 3) {
  try {
    const code = execFileSync(
      'curl',
      ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(timeoutSeconds), url],
      {
        encoding: 'utf8',
        timeout: (timeoutSeconds + 2) * 1000,
      },
    ).trim();
    return code === '200';
  } catch {
    return false;
  }
}

function launchctlStatus(label) {
  if (process.platform !== 'darwin') return { loaded: false, skipped: 'launchd unavailable on this platform' };
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      maxBuffer: 512 * 1024,
    });
    const pid = out.match(/pid = (\d+)/)?.[1] || null;
    const lastExitStatus = out.match(/last exit code = (-?\d+)/)?.[1] || null;
    return { loaded: true, pid, lastExitStatus };
  } catch (e) {
    return { loaded: false, error: (e.message || String(e)).slice(0, 160) };
  }
}

function systemdUserStatus(unit) {
  if (process.platform === 'darwin') return { loaded: false, skipped: 'systemd unavailable on this platform' };
  try {
    const active = execFileSync('systemctl', ['--user', 'is-active', unit], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim();
    const enabled = execFileSync('systemctl', ['--user', 'is-enabled', unit], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim();
    return { loaded: true, active, enabled };
  } catch (e) {
    return { loaded: false, error: (e.message || String(e)).slice(0, 160) };
  }
}

function dockerStatus() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 160) };
  }
}

function accountRotationStatus() {
  const statePath = join(homedir(), '.claude', 'scripts', 'account-rotation', 'state.json');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      statePath,
      activeAccount: state.activeAccount || null,
      accountCount: state.accounts && typeof state.accounts === 'object' ? Object.keys(state.accounts).length : 0,
      totalRotations: state.totalRotations || 0,
    };
  } catch (e) {
    return { statePath, error: (e.message || String(e)).slice(0, 160) };
  }
}

function status() {
  const route = routeStatus();
  const crsHealthUrl = route.state.crs?.healthUrl || 'http://127.0.0.1:3000/health';
  return {
    ok: !route.settings.mixedProvider,
    route,
    crs: {
      healthUrl: crsHealthUrl,
      healthy: curlOk(crsHealthUrl),
    },
    docker: dockerStatus(),
    launchd: {
      accountRotation: launchctlStatus('com.claude-ops.account-rotation'),
      crsHealthWatch: launchctlStatus('com.claude-ops.crs-health-watch'),
      crsPriority: launchctlStatus('com.claude-ops.crs-priority'),
      crsFraTunnel: launchctlStatus('com.claude-ops.crs-fra-tunnel'),
      opsDaemon: launchctlStatus('com.claude-ops.daemon'),
    },
    systemd: {
      crsCompose: systemdUserStatus('crs-compose.service'),
      crsTokenFeed: systemdUserStatus('crs-token-feed.service'),
      crsBedrockGuard: systemdUserStatus('crs-bedrock-guard.service'),
      crsTokenFeedTimer: systemdUserStatus('crs-token-feed.timer'),
      crsBedrockGuardTimer: systemdUserStatus('crs-bedrock-guard.timer'),
      claudeAccountRotation: systemdUserStatus('claude-account-rotation.service'),
    },
    accounts: accountRotationStatus(),
  };
}

function doctor() {
  const s = status();
  const findings = [];
  const fraPrimary = s.route.state.crs?.authority === 'fra-primary';
  if (s.route.settings.mixedProvider)
    findings.push({
      severity: 'error',
      code: 'mixed_provider_env',
      detail: 'settings.json has both Bedrock and CRS/OAuth env',
    });
  if (s.route.state.mode === 'crs-oauth' && !s.crs.healthy)
    findings.push({ severity: 'error', code: 'crs_unhealthy', detail: `${s.crs.healthUrl} is not healthy` });
  if (s.route.state.mode === 'bedrock-confirmed' && !s.route.bedrockConfirmationActive)
    findings.push({
      severity: 'error',
      code: 'bedrock_confirmation_expired',
      detail: 'Bedrock route lacks active TTL confirmation',
    });
  if (!s.docker.ok) findings.push({ severity: 'warn', code: 'docker_unavailable', detail: s.docker.error });
  if (process.platform === 'darwin') {
    if (!fraPrimary && !s.launchd.accountRotation.loaded)
      findings.push({ severity: 'warn', code: 'account_rotation_not_loaded', detail: s.launchd.accountRotation.error });
    if (!s.launchd.crsHealthWatch.loaded)
      findings.push({ severity: 'warn', code: 'crs_health_watch_not_loaded', detail: s.launchd.crsHealthWatch.error });
    if (fraPrimary && !s.launchd.crsFraTunnel.loaded)
      findings.push({ severity: 'error', code: 'crs_fra_tunnel_not_loaded', detail: s.launchd.crsFraTunnel.error });
  } else {
    if (s.systemd.crsCompose.active !== 'active')
      findings.push({
        severity: 'error',
        code: 'crs_compose_not_active',
        detail: s.systemd.crsCompose.error || s.systemd.crsCompose.active,
      });
    if (s.systemd.crsTokenFeedTimer.active !== 'active')
      findings.push({
        severity: 'warn',
        code: 'crs_token_feed_timer_not_active',
        detail: s.systemd.crsTokenFeedTimer.error || s.systemd.crsTokenFeedTimer.active,
      });
    if (s.systemd.crsBedrockGuardTimer.active !== 'active')
      findings.push({
        severity: 'warn',
        code: 'crs_bedrock_guard_timer_not_active',
        detail: s.systemd.crsBedrockGuardTimer.error || s.systemd.crsBedrockGuardTimer.active,
      });
    if (s.systemd.claudeAccountRotation.active !== 'active')
      findings.push({
        severity: 'warn',
        code: 'claude_account_rotation_not_active',
        detail: s.systemd.claudeAccountRotation.error || s.systemd.claudeAccountRotation.active,
      });
  }
  return { ...s, ok: findings.every((f) => f.severity !== 'error'), findings };
}

function opsUpdate() {
  const candidates = [
    join(homedir(), '.claude', 'plugins', 'cache', 'ops-marketplace', 'ops', 'latest', 'scripts', 'ops-update.sh'),
    join(homedir(), '.claude', 'plugins', 'cache', 'ops-marketplace', 'ops-update.sh'),
    join(homedir(), '.claude', 'scripts', 'ops-merge-tick.sh'),
  ];
  const script = candidates.find((p) => existsSync(p));
  if (!script) {
    printJson({ ok: false, error: 'no ops-update runner found', candidates });
    process.exitCode = 1;
    return;
  }
  try {
    const out = execFileSync(script, [], { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    printJson({ ok: true, script, output: out.slice(-8000) });
  } catch (e) {
    printJson({
      ok: false,
      script,
      error: (e.message || String(e)).slice(0, 1000),
      output: e.stdout?.toString?.().slice(-8000) || '',
    });
    process.exitCode = 1;
  }
}

try {
  if (command === 'status') {
    printJson(status());
  } else if (command === 'doctor') {
    const result = doctor();
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'route') {
    const mode = valueOf('--mode');
    const reason = valueOf('--reason', 'manual');
    const ttlMinutes = Number.parseInt(valueOf('--ttl-minutes', '60'), 10);
    const baseUrl = valueOf('--base-url');
    const healthUrl = valueOf('--health-url');
    const crs =
      baseUrl || healthUrl
        ? {
            ...routeStatus().state.crs,
            ...(baseUrl ? { baseUrl } : {}),
            ...(healthUrl ? { healthUrl } : {}),
          }
        : undefined;
    const state = setRouteMode(mode, {
      reason,
      ttlMinutes: Number.isFinite(ttlMinutes) ? ttlMinutes : 60,
      confirmMetered: has('--confirm-metered-bedrock'),
      region: valueOf('--region', process.env.AWS_BEDROCK_REGION || 'us-east-1'),
      updatedBy: 'claude-stack',
      ...(crs ? { crs } : {}),
    });
    printJson({ ok: true, state, settings: routeStatus().settings });
  } else if (command === 'apply') {
    applyRouteToSettings();
    printJson({ ok: true, route: routeStatus() });
  } else if (command === 'ops-update') {
    opsUpdate();
  } else {
    printJson({ ok: false, error: `unknown command: ${command}` });
    process.exitCode = 2;
  }
} catch (e) {
  printJson({ ok: false, error: e.message || String(e) });
  process.exitCode = 1;
}
