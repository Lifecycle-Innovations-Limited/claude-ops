import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBrowserPinTransaction, restoreBrowserPinBackup } from '../browser-pin-recovery.mjs';

const root = mkdtempSync(join(tmpdir(), 'browser-pin-disabled-'));
const destinationPath = join(root, '.claude.json');
const sentinelPath = join(root, 'recovery.json');
const original = Buffer.from('{"oauthAccount":{"emailAddress":"before@example.com"}}\n');
writeFileSync(destinationPath, original, { mode: 0o600 });
let applied = false;

assert.throws(
  () =>
    applyBrowserPinTransaction({
      sourcePath: destinationPath,
      destinationPath,
      sentinelPath,
      backupDirectory: join(root, 'backups'),
      coordinationKey: Buffer.alloc(32, 7),
      apply() {
        applied = true;
        writeFileSync(destinationPath, '{"pinned":true}\n', { mode: 0o600 });
      },
    }),
  /BROWSER_PIN_MUTATION_DISABLED/,
);
assert.equal(applied, false);
assert.deepEqual(readFileSync(destinationPath), original);
assert.equal(existsSync(sentinelPath), false);
assert.equal(existsSync(join(root, 'backups')), false);

// Existing evidence is retained, but the disabled legacy restore path never
// overwrites a concurrent or foreign destination.
writeFileSync(sentinelPath, '{"opaque":"evidence"}\n', { mode: 0o600 });
// Test-only adversarial replacement immediately before the fail-closed restore probe.
// CodeQL[js/file-system-race]
writeFileSync(destinationPath, '{"foreign":true}\n', { mode: 0o600 });
const foreign = readFileSync(destinationPath);
const result = restoreBrowserPinBackup({ destinationPath, sentinelPath, coordinationKey: Buffer.alloc(32, 7) });
assert.deepEqual(result, { restored: false, reason: 'browser-pin-mutation-disabled', retained: true });
assert.deepEqual(readFileSync(destinationPath), foreign);
assert.equal(existsSync(sentinelPath), true);

console.log('browser pin recovery tests: PASS');
