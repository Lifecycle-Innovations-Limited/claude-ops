// Settings remain resumable until exact, explicitly confirmed CLI removal.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export function registryRoot(env) {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || '', '.claude'), 'job-settings');
}
function directory(path, create = false) {
  let current = parse(resolve(path)).root;
  for (const part of resolve(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) return false;
    } catch (e) {
      if (!create || e.code !== 'ENOENT') return false;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (e) {
        if (e.code !== 'EEXIST') return false;
      }
    }
  }
  const s = lstatSync(path);
  return s.uid === process.getuid() && (s.mode & 0o077) === 0;
}
function owned(path, parent) {
  if (dirname(resolve(path)) !== resolve(parent) || !directory(parent)) return false;
  try {
    const s = lstatSync(path);
    return s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0;
  } catch {
    return false;
  }
}
function operation(root, op, record, session) {
  const helper = fileURLToPath(new URL('../lib/settings-record.py', import.meta.url));
  const result = spawnSync('python3', ['-I', helper], {
    input: JSON.stringify({ root, op, record, session }),
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}
export function registerSettings(path, env) {
  const root = registryRoot(env);
  if (!directory(root, true) || !owned(path, join(root, 'documents'))) throw Error('invalid settings ownership');
  const record = join(root, `${randomUUID()}.json`);
  writeFileSync(
    record,
    JSON.stringify({ path, sessionId: null, owner: env.POCKET_WORKER_ID || env.POCKET_RECORDING_ID || null }),
    { mode: 0o600, flag: 'wx' },
  );
  return record;
}
export function bindSettings(record, sessionId) {
  return /^[a-f0-9]{8,}$/.test(sessionId) && operation(dirname(record), 'bind', record, sessionId);
}
export function removalCommand(args) {
  return args[0] === 'rm' && /^[a-f0-9]{8,}$/.test(args[1] || '') ? args[1] : null;
}
export function confirmRemoval(env, requested, code, output) {
  if (code !== 0 || !requested) return 0;
  const m = [...output.matchAll(/^removed ([a-f0-9]{8,})$/gm)];
  if (m.length !== 1 || m[0][1] !== requested) return 0;
  const root = registryRoot(env);
  if (!directory(root)) return 0;
  // Persist the proof independently BEFORE touching contended record locks.
  if (!operation(root, 'receipt', null, requested)) throw Error('settings removal confirmation could not be persisted');
  let count = 0;
  for (const n of readdirSync(root).filter((n) => n.endsWith('.json')))
    if (operation(root, 'cleanup', join(root, n))) count++;
  return count;
}
export function reconcileSettings(env) {
  const root = registryRoot(env);
  if (!directory(root)) return;
  for (const n of readdirSync(root).filter((n) => n.endsWith('.json'))) {
    const file = join(root, n);
    if (!owned(file, root)) continue;
    operation(root, 'cleanup', file);
    if (!owned(file, root)) continue;
    try {
      const row = JSON.parse(readFileSync(file));
      if (row.removed || row.sessionId) continue;
      const jobs = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || '', '.claude'), 'jobs');
      for (const id of readdirSync(jobs).filter((id) => /^[a-f0-9]{8,}$/.test(id))) {
        try {
          const state = JSON.parse(readFileSync(join(jobs, id, 'state.json')));
          if (state.respawnFlags?.some((a) => a === row.path || a === `--settings=${row.path}`)) bindSettings(file, id);
        } catch {}
      }
    } catch {}
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) reconcileSettings(process.env);
