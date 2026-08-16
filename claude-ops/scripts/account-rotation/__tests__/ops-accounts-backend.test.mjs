/**
 * Unit tests: OPS_ACCOUNTS_BACKEND resolution + seat-state merge.
 */
import { resolveAccountsBackend, dualWriteEnabled, mergeSeatsIntoState } from '../ops-accounts-backend.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(resolveAccountsBackend({ env: {} }) === 'auto', 'default auto');
assert(resolveAccountsBackend({ env: { OPS_ACCOUNTS_BACKEND: 'local' } }) === 'local', 'local');
assert(resolveAccountsBackend({ env: { OPS_ACCOUNTS_BACKEND: 'seat-state' } }) === 'local', 'seat-state');
assert(resolveAccountsBackend({ env: { OPS_ACCOUNTS_BACKEND: 'CLIPROXY' } }) === 'cliproxy', 'cliproxy case');
assert(resolveAccountsBackend({ env: { OPS_ACCOUNTS_BACKEND: 'crs' } }) === 'local', 'retired relay value falls back to local');
assert(resolveAccountsBackend({ env: {}, cfgBackend: 'file' }) === 'local', 'cfg file');
assert(resolveAccountsBackend({ env: { OPS_ACCOUNTS_BACKEND: 'auto' } }) === 'auto', 'explicit auto');

assert(dualWriteEnabled({ env: {} }) === true, 'dual-write default on');
assert(dualWriteEnabled({ env: { OPS_ACCOUNTS_DUAL_WRITE: '0' } }) === false, 'dual-write off');

const merged = mergeSeatsIntoState({ version: 1, providers: {} }, [
  { email: 'a@example.com', schedulable: true, util5h: 10, util7d: 20 },
  { email: 'b@example.com', schedulable: false, util5h: 90 },
]);
assert(merged.providers.claude.seats['a@example.com'].schedulable === true, 'a on');
assert(merged.providers.claude.seats['b@example.com'].schedulable === false, 'b off');
assert(merged.providers.claude.seats['a@example.com'].util5h === 10, 'util');
assert(merged.updatedAt, 'timestamp');

console.log('ops-accounts-backend.test.mjs: ok');
