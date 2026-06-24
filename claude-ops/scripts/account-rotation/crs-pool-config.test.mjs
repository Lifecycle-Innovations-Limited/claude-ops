import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrsNameMaps, crsPolicy } from './crs-pool-config.mjs';

test('buildCrsNameMaps uses crsAccountName and nameByVaultKey', () => {
  const config = {
    accounts: [{ email: 'a@example.com', crsAccountName: 'pool-a' }],
    crs: { nameByVaultKey: { legacy: 'pool-legacy' } },
  };
  const { nameByVaultKey, vaultKeyByCrsName } = buildCrsNameMaps(config);
  assert.equal(nameByVaultKey['a@example.com'], 'pool-a');
  assert.equal(nameByVaultKey.legacy, 'pool-legacy');
  assert.equal(vaultKeyByCrsName['pool-a'], 'a@example.com');
});

test('crsPolicy defaults to conservative', () => {
  assert.equal(crsPolicy({ crs: {} }), 'conservative');
  assert.equal(crsPolicy({ crs: { policy: 'max-out' } }), 'max-out');
});
