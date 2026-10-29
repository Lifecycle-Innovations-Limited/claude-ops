import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'settings-privacy-'));
try {
  const sentinel = 'synthetic-private-credential-sentinel';
  const caller = join(work, 'caller.json');
  writeFileSync(caller, JSON.stringify({ env: { TEST_CREDENTIAL: sentinel } }));
  const capture = join(work, 'capture.json');
  const stub = join(work, 'claude');
  writeFileSync(
    stub,
    `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2);const value=args[args.indexOf('--settings')+1];const file=!value.startsWith('{');fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,file,mode:file?fs.statSync(value).mode&511:null,settings:JSON.parse(file?fs.readFileSync(value,'utf8'):value)}));process.exit(Number(process.env.TEST_EXIT||0));\n`,
    { mode: 0o700 },
  );
  for (const code of [0, 7]) {
    const result = spawnSync(
      'bash',
      ['-c', '. "$1"; claude_invoke -p --settings "$2"', 'test', join(root, 'scripts/lib/claude-invoke.sh'), caller],
      {
        env: {
          ...process.env,
          PATH: `${work}:${process.env.PATH}`,
          CLAUDE_OPS_USE_CREDIT_POOL: '0',
          CAPTURE: capture,
          TEST_EXIT: String(code),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, code, result.stderr);
    const out = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(
      JSON.stringify(out.args).includes(sentinel),
      false,
      'caller file credential must not enter child argv',
    );
    assert.equal(out.file, true);
    assert.equal(out.mode, 0o600);
    assert.equal(out.settings.env.TEST_CREDENTIAL, sentinel);
    assert.equal(
      existsSync(out.args[out.args.indexOf('--settings') + 1]),
      false,
      'composed foreground file cleaned on all statuses',
    );
    assert.equal(JSON.parse(readFileSync(caller, 'utf8')).env.TEST_CREDENTIAL, sentinel);
  }
  console.log('Headless file-settings argv privacy and cleanup: PASS');
} finally {
  rmSync(work, { recursive: true, force: true });
}
