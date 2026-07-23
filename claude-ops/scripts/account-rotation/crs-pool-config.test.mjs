import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrsNameMaps, crsPolicy, accountProxyConfig } from './crs-pool-config.mjs';

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

test('accountProxyConfig returns null when proxy is disabled', () => {
  assert.equal(accountProxyConfig({}, {}, { CLAUDE_ROTATION_PROXY_ENABLED: '0' }), null);
  assert.equal(accountProxyConfig({}, {}, { CLAUDE_ROTATION_PROXY_PROVIDER: 'efg' }), null);
  assert.equal(accountProxyConfig({}, {}, {}), null);
});

test('accountProxyConfig returns null when provider URL is missing', () => {
  assert.equal(
    accountProxyConfig({}, {}, { CLAUDE_ROTATION_PROXY_ENABLED: '1', CLAUDE_ROTATION_PROXY_PROVIDER: 'efg' }),
    null,
  );
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        EFG_PROXY_URL: '',
      },
    ),
    null,
  );
});

test('accountProxyConfig parses socks5:// url for efg provider', () => {
  // Exact contract from crs-parity-regression.test.mjs.
  assert.deepEqual(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'socks5://127.0.0.1:1087',
        CLAUDE_ROTATION_ENV_FILE: '/nonexistent',
      },
    ),
    { type: 'socks5', host: '127.0.0.1', port: 1087 },
  );
});

test('accountProxyConfig defaults to brightdata when no provider env set', () => {
  assert.deepEqual(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        BRIGHTDATA_PROXY_URL: 'http://proxy.example.com:3128',
      },
    ),
    { type: 'http', host: 'proxy.example.com', port: 3128 },
  );
});

test('accountProxyConfig accepts bare host:port for brightdata', () => {
  assert.deepEqual(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'brightdata',
        BRIGHTDATA_PROXY_URL: '10.0.0.1:1080',
      },
    ),
    { type: 'http', host: '10.0.0.1', port: 1080 },
  );
});

test('accountProxyConfig returns null on malformed URL', () => {
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'not a url',
      },
    ),
    null,
  );
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'socks5://host',
      },
    ),
    null,
  );
  // Unsupported scheme + path/suffix must also return null.
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'ftp://proxy.example.com:21',
      },
    ),
    null,
  );
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'socks5://127.0.0.1:1087/path',
      },
    ),
    null,
  );
  assert.equal(
    accountProxyConfig(
      {},
      {},
      {
        CLAUDE_ROTATION_PROXY_ENABLED: '1',
        CLAUDE_ROTATION_PROXY_PROVIDER: 'efg',
        EFG_PROXY_URL: 'socks5://127.0.0.1:abc',
      },
    ),
    null,
  );
});
