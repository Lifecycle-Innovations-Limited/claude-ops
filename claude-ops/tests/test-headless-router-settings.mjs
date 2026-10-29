#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'headless-router-'));
try {
  const fixture = join(temp, 'plugin');
  // All router lease/settings writes and imported dependencies stay in this copy.
  cpSync(join(root, 'scripts'), join(fixture, 'scripts'), { recursive: true });
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'security'),
    '#!/bin/sh\nprintf \'password: "{\\"claudeAiOauth\\":{\\"accessToken\\":\\"synthetic-oauth\\"}}"\\n\'\n',
    { mode: 0o700 },
  );
  const real = join(bin, 'capture.mjs');
  writeFileSync(
    real,
    `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2);const value=args[args.indexOf('--settings')+1];fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,settings:JSON.parse(value.startsWith('{')?value:fs.readFileSync(value,'utf8')),settingsMode:value.startsWith('{')?null:fs.statSync(value).mode&511,token:process.env.CLAUDE_CODE_OAUTH_TOKEN}));\n`,
    { mode: 0o700 },
  );
  const router = join(fixture, 'scripts/account-rotation/session-router.mjs');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node\nimport {pathToFileURL} from 'node:url';\nconst {spawnWithAccount}=await import(pathToFileURL(${JSON.stringify(router)}));\nconst selected=process.env.MODE==='selected';\nconst config={accounts:selected?[{label:'fixture'}]:[],rateLimits:{destinationMaxUtilPercent:100}};\nconst result=spawnWithAccount(process.argv.slice(2),config,{}, {env:process.env,stdio:'inherit'});\nresult.proc.on('close',code=>process.exit(code??1));\n`,
    { mode: 0o700 },
  );
  const caller = {
    env: {
      ANTHROPIC_BASE_URL: 'https://explicit.example',
      ANTHROPIC_API_BASE: 'https://api.example',
      ANTHROPIC_API_KEY: 'synthetic-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-auth',
      KEEP: 'yes',
    },
    hooks: { PreToolUse: [{ matcher: 'Bash' }] },
    enabledPlugins: { 'other@test': true },
  };
  const file = join(temp, 'caller settings.json');
  const original = JSON.stringify(caller);
  writeFileSync(file, original);
  // Linux router reads this synthetic credential store instead of macOS security.
  mkdirSync(join(temp, '.claude'));
  writeFileSync(
    join(temp, '.claude/.credentials.json'),
    JSON.stringify({ 'Claude-Rotation-fixture': { claudeAiOauth: { accessToken: 'synthetic-oauth' } } }),
  );
  let cases = 0;
  for (const mode of ['selected', 'none', 'relay']) {
    for (const form of ['inline', 'file', 'equals', 'equals-file', 'absent']) {
      const flags =
        form === 'inline'
          ? ['--settings', original]
          : form === 'file'
            ? ['--settings', file]
            : form === 'equals'
              ? [`--settings=${original}`]
              : form === 'equals-file'
                ? [`--settings=${file}`]
                : [];
      const capture = join(temp, 'capture.json');
      const env = {
        ...process.env,
        HOME: temp,
        PATH: `${bin}:${process.env.PATH}`,
        MODE: mode,
        CAPTURE: capture,
        CLAUDE_REAL_BIN: real,
        CLAUDE_OPS_ROOT: fixture,
        CLAUDE_OPS_USE_CREDIT_POOL: '0',
      };
      for (const key of [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_BASE',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ])
        delete env[key];
      if (mode === 'relay') env.ANTHROPIC_BASE_URL = 'https://explicit.example';
      const run = spawnSync(
        'bash',
        [
          '-c',
          '. "$1"; shift; claude_invoke "$@"',
          'fixture',
          join(fixture, 'scripts/lib/claude-invoke.sh'),
          '-p',
          ...flags,
        ],
        { env, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(result.args.filter((a) => a === '--settings' || a.startsWith('--settings=')).length, 1);
      const settings = result.settings;
      assert.equal(settings.enabledPlugins['telegram@claude-plugins-official'], false, `${mode}/${form} Telegram`);
      if (form !== 'absent') {
        assert.deepEqual(settings.hooks, caller.hooks);
        assert.equal(settings.enabledPlugins['other@test'], true);
        assert.equal(settings.env.KEEP, 'yes');
      }
      if (mode === 'selected') {
        assert.equal(result.token, 'synthetic-oauth');
        assert.equal(result.settingsMode, 0o600);
        assert.equal(
          existsSync(result.args[result.args.indexOf('--settings') + 1]),
          false,
          'override cleaned on close',
        );
        for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
          assert.equal(settings.env[key], '', `${mode}/${form}/${key}`);
      } else if (form !== 'absent') assert.deepEqual(settings.env, caller.env, `${mode}/${form} route preserved`);
      assert.equal(readFileSync(file, 'utf8'), original);
      cases++;
    }
  }
  const launcher = join(fixture, 'scripts/account-rotation/launch-claude.mjs');
  const rotation = join(fixture, 'scripts/account-rotation');
  writeFileSync(
    join(rotation, 'config.json'),
    JSON.stringify({ accounts: [{ label: 'fixture' }], rateLimits: { destinationMaxUtilPercent: 100 } }),
  );
  writeFileSync(join(rotation, 'state.json'), '{}');
  for (const selected of [true, false]) {
    writeFileSync(
      join(rotation, 'config.json'),
      JSON.stringify({
        accounts: selected ? [{ label: 'fixture' }] : [],
        rateLimits: { destinationMaxUtilPercent: 100 },
      }),
    );
    const capture = join(temp, 'launcher-normal.json');
    const env = {
      ...process.env,
      HOME: temp,
      PATH: `${bin}:${process.env.PATH}`,
      ADMISSION_FORCE: '1',
      CLAUDE_REAL_BIN: real,
      CAPTURE: capture,
    };
    const doc = { ...caller, enabledPlugins: { ...caller.enabledPlugins, 'telegram@claude-plugins-official': false } };
    const run = spawnSync(process.execPath, [launcher, '-p', '--settings', JSON.stringify(doc), '--', 'literal'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(result.args.indexOf('--settings') < result.args.indexOf('--'));
    assert.equal(result.args[result.args.indexOf('--') + 1], 'literal');
    assert.equal(result.settings.env.ANTHROPIC_BASE_URL, selected ? '' : caller.env.ANTHROPIC_BASE_URL);
    if (selected)
      assert.equal(
        existsSync(result.args[result.args.indexOf('--settings') + 1]),
        false,
        'actual launcher removes override before exit',
      );
    cases++;
  }
  writeFileSync(
    join(rotation, 'config.json'),
    JSON.stringify({ accounts: [{ label: 'fixture' }], rateLimits: { destinationMaxUtilPercent: 100 } }),
  );
  const dispatch = join(bin, 'dispatch');
  writeFileSync(dispatch, '#!/bin/sh\nprintf dispatched > "$CAPTURE"\n', { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: temp,
    PATH: `${bin}:${process.env.PATH}`,
    ADMISSION_FORCE: '1',
    CLAUDE_REAL_BIN: dispatch,
    CAPTURE: join(temp, 'failure-dispatch'),
  };
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_BASE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ])
    delete env[key];
  const overrides = join(temp, '.claude', 'foreground-settings');
  rmSync(overrides, { recursive: true, force: true });
  for (const mode of ['malformed', 'read', 'write']) {
    const flags =
      mode === 'malformed'
        ? ['--settings', '{private-sentinel-invalid}']
        : mode === 'read'
          ? ['--settings', join(temp, 'missing.json')]
          : ['--settings', original];
    if (mode === 'write') writeFileSync(overrides, 'not a directory');
    rmSync(env.CAPTURE, { force: true });
    const run = spawnSync(process.execPath, [launcher, '-p', ...flags], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `${mode} must fail closed`);
    assert.equal(existsSync(env.CAPTURE), false, `${mode} must not dispatch fallback`);
    assert.equal(run.stderr.includes('private-sentinel'), false, 'no parser input disclosure');
    assert.match(run.stderr, /direct OAuth settings composition failed/);
    if (mode === 'write') rmSync(overrides);
    cases++;
  }
  const concurrent = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {spawnWithAccount} from ${JSON.stringify(new URL(`file://${router}`).href)};
    const config={accounts:[],rateLimits:{destinationMaxUtilPercent:100}};
    const jobs=[1,2].map(n=>{
      const capture=${JSON.stringify(temp)}+'/concurrent-'+n;
      const result=spawnWithAccount(['-p','--settings',JSON.stringify({env:{MARKER:n}})],config,{}, {env:{...process.env,CLAUDE_CODE_OAUTH_TOKEN:'synthetic-oauth',CLAUDE_REAL_BIN:${JSON.stringify(real)},CAPTURE:capture},stdio:'ignore'});
      return {capture,proc:result.proc};
    });
    await Promise.all(jobs.map(({proc})=>new Promise((resolve,reject)=>{proc.on('close',code=>code===0?resolve():reject(Error('child failure')));})));
    const results=jobs.map(j=>JSON.parse(fs.readFileSync(j.capture,'utf8')));
    assert.notEqual(results[0].args[1],results[1].args[1]);
    results.forEach((r,i)=>{assert.equal(r.settings.env.MARKER,i+1);assert.equal(r.settingsMode,384);assert.equal(fs.existsSync(r.args[1]),false);});
  `,
    ],
    { env: { ...env, ANTHROPIC_BASE_URL: '' }, encoding: 'utf8' },
  );
  assert.equal(concurrent.status, 0, concurrent.stderr);
  cases++;
  console.log(`Headless router settings integration: ${cases} passed`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
