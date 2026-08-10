import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCredentialFileCas, snapshotCredentialFile } from '../credential-file-publication.mjs';

const fixture = () => {
  // macOS exposes tmpdir() through /var -> /private/var. Use the physical
  // path so canonical-destination checks are tested rather than bypassed.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'credential-cas-disabled-')));
  chmodSync(root, 0o700);
  const path = join(root, 'credentials.json');
  writeFileSync(path, 'old', { mode: 0o600 });
  return { root, path };
};

const pathnameState = (path) => {
  // Test-only snapshot intentionally observes adversarial pathname replacement.
  // CodeQL[js/file-system-race]
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    symlinkTarget: stat.isSymbolicLink() ? readlinkSync(path) : null,
    bytes: stat.isFile() ? readFileSync(path) : null,
  };
};

const directoryState = (root) =>
  new Map(
    readdirSync(root)
      .sort()
      .map((name) => [name, pathnameState(join(root, name))]),
  );

for (const replacement of [
  'unchanged',
  'different',
  'same-content',
  'deleted',
  'delete-recreate',
  'symlink',
  'hardlink',
]) {
  const f = fixture();
  const expected = snapshotCredentialFile(f.path);
  if (replacement === 'different' || replacement === 'same-content') {
    const foreign = join(f.root, 'foreign');
    writeFileSync(foreign, replacement === 'different' ? 'foreign' : 'old', { mode: 0o600 });
    renameSync(foreign, f.path);
  } else if (replacement === 'deleted') {
    const moved = join(f.root, 'moved');
    renameSync(f.path, moved);
  } else if (replacement === 'delete-recreate') {
    unlinkSync(f.path);
    writeFileSync(f.path, 'foreign-recreated', { mode: 0o600 });
  } else if (replacement === 'symlink') {
    const moved = join(f.root, 'moved');
    renameSync(f.path, moved);
    symlinkSync(moved, f.path);
  } else if (replacement === 'hardlink') {
    linkSync(f.path, join(f.root, 'alias'));
  }
  const before = directoryState(f.root);
  if (replacement === 'hardlink') {
    assert.equal(before.get('credentials.json').ino, before.get('alias').ino);
    assert.equal(before.get('credentials.json').nlink, 2n);
  }
  assert.throws(
    () => publishCredentialFileCas(f.path, Buffer.from('new'), expected),
    /CREDENTIAL_FILE_PUBLICATION_DISABLED/,
  );
  const after = directoryState(f.root);
  assert.deepEqual(after, before, `${replacement}: pathname descriptors and bytes must be unchanged`);
  if (replacement === 'symlink') {
    assert.equal(lstatSync(f.path).isSymbolicLink(), true);
    assert.equal(readlinkSync(f.path), join(f.root, 'moved'));
  } else if (replacement === 'hardlink') {
    assert.equal(after.get('credentials.json').ino, after.get('alias').ino);
    assert.equal(after.get('credentials.json').nlink, 2n);
  }
}

// Real multiprocess pause after secure snapshot: replacement by another process
// is preserved because publication refuses before creating a temp or touching
// any pathname.
{
  const f = fixture();
  const marker = join(f.root, 'snapshotted');
  const modulePath = fileURLToPath(new URL('../credential-file-publication.mjs', import.meta.url));
  const childSource = `
    import { writeFileSync } from 'node:fs';
    const m = await import(${JSON.stringify(`file://${modulePath}`)});
    const expected = m.snapshotCredentialFile(${JSON.stringify(f.path)});
    writeFileSync(${JSON.stringify(marker)}, 'ready', { mode: 0o600 });
    process.kill(process.pid, 'SIGSTOP');
    try { m.publishCredentialFileCas(${JSON.stringify(f.path)}, Buffer.from('new'), expected); process.exit(7); }
    catch (error) { if (error.message !== 'CREDENTIAL_FILE_PUBLICATION_DISABLED') process.exit(8); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], { stdio: 'ignore' });
  for (let i = 0; i < 500 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(marker), true);
  const foreign = join(f.root, 'foreign');
  writeFileSync(foreign, 'foreign-process', { mode: 0o600 });
  renameSync(foreign, f.path);
  const before = directoryState(f.root);
  process.kill(child.pid, 'SIGCONT');
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0);
  assert.deepEqual(
    directoryState(f.root),
    before,
    'multiprocess replacement pathname descriptor and bytes must be unchanged',
  );
}

console.log('credential file publication tests: PASS');
