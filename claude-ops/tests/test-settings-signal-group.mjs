import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const tmp = mkdtempSync(join(tmpdir(), 'settings-signal-'));
try {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const caller = join(tmp, 'caller');
  writeFileSync(caller, '{"env":{"SYNTHETIC":"private"}}');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(process.env.CAPTURE,args[args.indexOf('--settings')+1]);setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const capture = join(tmp, signal);
    const child = spawn(
      'bash',
      [
        '-c',
        '. "$1"; claude_invoke -p --settings "$2"',
        'test',
        new URL('../scripts/lib/claude-invoke.sh', import.meta.url).pathname,
        caller,
      ],
      {
        detached: true,
        env: { ...process.env, HOME: tmp, CLAUDE_CONFIG_DIR: join(tmp, 'config'), PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, CLAUDE_OPS_USE_CREDIT_POOL: '0' },
        stdio: 'ignore',
      },
    );
    const ended = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, sig })));
    for (let n = 0; n < 100 && !existsSync(capture); n++) await delay(20);
    assert.ok(existsSync(capture), 'synthetic child started');
    const path = readFileSync(capture, 'utf8');
    process.kill(-child.pid, signal);
    await ended;
    assert.ok(existsSync(caller));
    // SIGKILL cannot run EXIT traps. Record the real limitation and remove
    // this synthetic fixture explicitly; do not claim signal-proof cleanup.
    if (signal === 'SIGKILL')
      console.log(
        `OBSERVED SIGKILL process-group composed-file retained=${existsSync(path)} (untrappable; recovery requirement remains open)`,
      );
    else console.log(`OBSERVED SIGTERM process-group composed-file retained=${existsSync(path)}`);
    const { spawnSync } = await import('node:child_process');
    const helper = new URL('../scripts/lib/headless-settings.py', import.meta.url).pathname;
    const retry = spawnSync('python3', ['-I', helper], { input: '{}', encoding: 'utf8', env: { ...process.env, HOME: tmp, CLAUDE_CONFIG_DIR: join(tmp, 'config') } });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(existsSync(path), false, 'next invocation reclaims dead-owner foreground document');
    rmSync(retry.stdout.trim(), {force:true});
    console.log(`PASS ${signal} process-group recovery removes dead-owner document`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
