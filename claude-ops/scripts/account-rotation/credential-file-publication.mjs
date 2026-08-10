import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat) => ({
  dev: stat.dev.toString(),
  ino: stat.ino.toString(),
  birthtimeNs: stat.birthtimeNs.toString(),
});
const sameIdentity = (left, right) =>
  left?.dev === right?.dev && left?.ino === right?.ino && left?.birthtimeNs === right?.birthtimeNs;

function canonicalParent(path) {
  const parent = dirname(path);
  if (realpathSync(parent) !== resolve(parent)) throw new Error('CREDENTIAL_DESTINATION_ALIAS');
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)
    throw new Error('INSECURE_CREDENTIAL_DIRECTORY');
}

function namedExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function snapshotCredentialFile(path, { allowAbsent = true } = {}) {
  if (!isAbsolute(path)) throw new Error('CREDENTIAL_DESTINATION_ABSOLUTE_REQUIRED');
  canonicalParent(path);
  if (!namedExists(path)) {
    if (!allowAbsent) throw new Error('CREDENTIAL_DESTINATION_MISSING');
    return Object.freeze({ path: resolve(path), absent: true });
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.nlink !== 1n
    )
      throw new Error('INSECURE_CREDENTIAL_DESTINATION');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    const descriptor = identity(before);
    if (!sameIdentity(descriptor, identity(after)) || !sameIdentity(descriptor, identity(named)))
      throw new Error('CREDENTIAL_DESTINATION_CHANGED');
    return Object.freeze({
      path: resolve(path),
      absent: false,
      ...descriptor,
      digest: digest(bytes),
      length: bytes.length,
      bytes,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Node has no cross-platform no-replace rename or inode-conditional unlink.
 * A pathname CAS implemented with standard fs calls retains an unavoidable
 * check/use race against nonparticipating writers. Keep all dormant automatic
 * save-back sinks fail closed until a reviewed native exclusive-move binding is
 * available. This function must refuse before creating any temporary file.
 */
export function publishCredentialFileCas(path, bytes, expected, options) {
  void path;
  void bytes;
  void expected;
  void options;
  throw new Error('CREDENTIAL_FILE_PUBLICATION_DISABLED');
}
