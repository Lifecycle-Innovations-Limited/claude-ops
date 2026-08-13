#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeClaudeModelArgs, normalizeClaudeModelValue } from '../model-args.mjs';
import { effectiveRouteMatches, routeCredentialFingerprint } from '../bg-respawn.mjs';

const accountRotationDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = dirname(accountRotationDir);

for (const stale of ['fable', 'FABLE', 'fable[1m]', 'claude-fable-5', 'claude-fable-5[1m]']) {
  assert.equal(normalizeClaudeModelValue(stale), 'gpt-5.4');
}

for (const supported of ['opus', 'opus[1m]', 'gpt-5.4', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
  assert.equal(normalizeClaudeModelValue(supported), supported);
}

assert.deepEqual(normalizeClaudeModelArgs(['-p', 'hello', '--model', 'fable[1m]', '--effort', 'high']), [
  '-p',
  'hello',
  '--model',
  'gpt-5.4',
  '--effort',
  'high',
]);
assert.deepEqual(normalizeClaudeModelArgs(['--model=claude-fable-5', '--model', 'claude-sonnet-4-6']), [
  '--model=gpt-5.4',
  '--model',
  'claude-sonnet-4-6',
]);

const temp = mkdtempSync(join(tmpdir(), 'launch-claude-model-'));
const fakeClaude = join(temp, 'bin', 'claude');
const capturedArgs = join(temp, 'captured-args.json');
mkdirSync(dirname(fakeClaude), { recursive: true });
writeFileSync(
  fakeClaude,
  `#!/bin/sh\nprintf '%s\\n' "$@" | node -e "const fs=require('fs');const lines=fs.readFileSync(0,'utf8').trimEnd().split('\\n');fs.writeFileSync(process.env.CAPTURED_ARGS,JSON.stringify(lines));"\n`,
);
chmodSync(fakeClaude, 0o700);
const launched = spawnSync(process.execPath, [join(scriptsDir, 'launch-claude.mjs'), 'status', '--model=fable[1m]'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: temp,
    CLAUDE_REAL_BIN: fakeClaude,
    CAPTURED_ARGS: capturedArgs,
    ADMISSION_FORCE: '1',
  },
});
assert.equal(launched.status, 0, launched.stderr);
const launchedArgs = JSON.parse(readFileSync(capturedArgs, 'utf8'));
assert.equal(launchedArgs.includes('--model=gpt-5.4'), true);
assert.equal(
  launchedArgs.some((arg) => /fable/i.test(arg)),
  false,
);

const launcherSource = readFileSync(join(scriptsDir, 'launch-claude.mjs'), 'utf8');
assert.match(launcherSource, /const rawArgs = normalizeClaudeModelArgs\(process\.argv\.slice\(2\)\);/);
assert.ok(
  launcherSource.indexOf('normalizeClaudeModelArgs(process.argv.slice(2))') <
    launcherSource.indexOf('spawnSync(CLAUDE_BIN, args'),
  'launcher normalizes raw CLI args before spawning Claude',
);

function runRespawnCase(mode) {
  const exitCode = mode === 'spawn-failure' ? 7 : 0;
  const home = mkdtempSync(join(tmpdir(), `bg-respawn-${mode}-`));
  const id = `respawn-${process.pid}-${mode}`;
  const jobsDir = join(home, '.claude', 'jobs', id);
  const statePath = join(jobsDir, 'state.json');
  const capturePath = join(home, 'respawn-capture.json');
  const fakeRespawn = join(home, 'bin', 'claude');
  const deferred = `/tmp/claude-respawn-deferred-${id}`;
  const respawned = `/tmp/claude-rotation-respawned-${id}`;
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(dirname(fakeRespawn), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({ respawnFlags: ['--model', 'claude-fable-5[1m]', '--effort', 'high'] }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(deferred, 'deferred', { mode: 0o600 });
  rmSync(respawned, { force: true });
  writeFileSync(
    fakeRespawn,
    `#!/bin/sh\nRESPAWN_ARGS="$*" node - <<'NODE'\nconst fs=require('fs');\nconst cp=require('child_process');\nconst path=require('path');\nconst state=JSON.parse(fs.readFileSync(process.env.STATE_PATH,'utf8'));\nfs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.env.RESPAWN_ARGS.split(' '), state }));\nconst mode=process.env.RESPAWN_TEST_MODE;\nif (mode !== 'spawn-failure' && mode !== 'no-session') {\n  let pid=999999;\n  if (mode !== 'stale-pid') {\n    const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore',env:process.env});\n    child.unref();\n    pid=child.pid;\n    fs.writeFileSync(process.env.CHILD_PID_PATH,String(pid));\n  }\n  const expectedRoute=JSON.parse(process.env.CLAUDE_OPS_EXPECTED_ROUTE);\n  const effectiveRoute=mode === 'wrong-route'\n    ? {...expectedRoute,mode:'crs'}\n    : mode === 'wrong-endpoint'\n      ? {...expectedRoute,baseUrl:'https://wrong-relay.example/api'}\n      : mode === 'mismatched-credential'\n        ? {...expectedRoute,credentialFingerprint:'0'.repeat(64)}\n        : expectedRoute;\n  fs.mkdirSync(process.env.SESSIONS_DIR,{recursive:true});\n  fs.writeFileSync(path.join(process.env.SESSIONS_DIR,pid+'.json'),JSON.stringify({kind:'bg',jobId:process.env.SESSION_ID,pid,status:'waiting',effectiveRoute}));\n}\nNODE\nexit ${exitCode}\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { doRespawn } from ${JSON.stringify(new URL('../bg-respawn.mjs', import.meta.url).href)};\n` +
        `const logs=[]; const ok=doRespawn({id:${JSON.stringify(id)},pid:999999,status:'waiting'}, (m)=>logs.push(m));\n` +
        `console.log(JSON.stringify({ok,logs}));`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_BIN: fakeRespawn,
        STATE_PATH: statePath,
        CAPTURE_PATH: capturePath,
        RESPAWN_TEST_MODE: mode,
        SESSION_ID: id,
        SESSIONS_DIR: join(home, '.claude', 'sessions'),
        CHILD_PID_PATH: join(home, 'child.pid'),
        CLAUDE_ROTATION_SESSION_STAGGER_MS: '0',
        CLAUDE_CODE_OAUTH_TOKEN: 'direct-test-token',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
  const childPidPath = join(home, 'child.pid');
  const childPid = existsSync(childPidPath) ? Number(readFileSync(childPidPath, 'utf8')) : null;
  return {
    outcome,
    captured,
    deferred,
    respawned,
    childPid,
  };
}

const failure = runRespawnCase('spawn-failure');
assert.equal(failure.outcome.ok, false);
assert.deepEqual(failure.captured.args, ['respawn', 'respawn-' + process.pid + '-spawn-failure']);
assert.equal(failure.captured.state.respawnFlags.includes('gpt-5.4'), true);
assert.equal(
  failure.captured.state.respawnFlags.some((flag) => /fable/i.test(flag)),
  false,
);
assert.equal(existsSync(failure.deferred), true);
assert.equal(existsSync(failure.respawned), false);
assert.equal(
  failure.outcome.logs.some((line) => line.includes('respawned bg session')),
  false,
);
rmSync(failure.deferred, { force: true });

for (const mode of ['no-session', 'stale-pid', 'wrong-route', 'wrong-endpoint', 'mismatched-credential']) {
  const invalid = runRespawnCase(mode);
  assert.equal(invalid.outcome.ok, false, mode);
  assert.equal(existsSync(invalid.deferred), true, mode);
  assert.equal(existsSync(invalid.respawned), false, mode);
  if (invalid.childPid) {
    try {
      process.kill(invalid.childPid, 'SIGTERM');
    } catch {}
  }
  rmSync(invalid.deferred, { force: true });
}

const directToken = 'direct-test-token';
const directRoute = {
  mode: 'direct',
  baseUrl: null,
  credentialSource: 'session-oauth',
  credentialFingerprint: routeCredentialFingerprint(directToken),
  settings: null,
};
const crsRoute = {
  mode: 'crs',
  baseUrl: 'http://127.0.0.1:3005/api',
  credentialSource: 'crs-relay',
  credentialFingerprint: routeCredentialFingerprint('cr_test-relay'),
  settings: '/tmp/crs-session-settings.json',
};
assert.equal(effectiveRouteMatches({ ...crsRoute, baseUrl: 'http://127.0.0.1:3002/api' }, crsRoute), false);
assert.equal(
  effectiveRouteMatches({ ...crsRoute, credentialFingerprint: routeCredentialFingerprint(directToken) }, crsRoute),
  false,
);
assert.equal(effectiveRouteMatches({ ...directRoute, credentialSource: 'keychain' }, directRoute), false);
assert.equal(effectiveRouteMatches({ ...directRoute, credentialFingerprint: null }, directRoute), false);
assert.equal(effectiveRouteMatches({ ...crsRoute }, crsRoute), true);
assert.equal(effectiveRouteMatches({ ...directRoute }, directRoute), true);

const success = runRespawnCase('success');
assert.equal(success.outcome.ok, true);
assert.equal(success.captured.state.respawnFlags.includes('gpt-5.4'), true);
assert.equal(
  success.captured.state.respawnFlags.some((flag) => /fable/i.test(flag)),
  false,
);
assert.equal(existsSync(success.deferred), false);
assert.equal(existsSync(success.respawned), true);
assert.equal(
  success.outcome.logs.some((line) => line.includes('respawned bg session')),
  true,
);
if (success.childPid) {
  try {
    process.kill(success.childPid, 'SIGTERM');
  } catch {}
}
rmSync(success.respawned, { force: true });

console.log('Claude model argument normalization tests: PASS');
