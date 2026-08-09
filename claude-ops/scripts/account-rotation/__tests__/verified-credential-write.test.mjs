#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerifiedCredentialWriter, requireVerifiedCredentialCapability } from '../verified-credential-write.mjs';
import { verifyRefreshedTokenIdentity } from '../token-identity.mjs';

const account = {
  email: 'right@example.test',
  orgUuid: 'org-right',
  orgName: 'Right Org',
};
const otherAccount = {
  email: 'other@example.test',
  orgUuid: 'org-other',
  orgName: 'Other Org',
};
const credential = (accessToken) => JSON.stringify({ claudeAiOauth: { accessToken }, mcpOAuth: {} });
const profile = (overrides = {}) => ({
  account: { email: account.email },
  organization: { uuid: account.orgUuid, name: account.orgName },
  ...overrides,
});

async function runCase(name, { target = account, response, expectedError = null, token = name }) {
  const dir = mkdtempSync(join(tmpdir(), 'verified-token-write-'));
  const vault = join(dir, 'vault.json');
  writeFileSync(vault, JSON.stringify({ untouched: true }));
  let writes = 0;
  const events = [];
  const writerCapability = {};
  let retainedVerifiedCapability;
  const verify = (candidate, accessToken) =>
    verifyRefreshedTokenIdentity(candidate, accessToken, {
      fetchImpl: async () => response,
    });
  const verifiedWrite = createVerifiedCredentialWriter({
    verify,
    withLock: async (callback) => {
      events.push('lock');
      try {
        return await callback(writerCapability);
      } finally {
        events.push('unlock');
      }
    },
    requireCapability: (candidate) => assert.equal(candidate, writerCapability),
    write(_account, value, verifiedCapability, slot) {
      assert.throws(
        () =>
          requireVerifiedCredentialCapability(verifiedCapability, {
            account: target,
            credential: credential('different-token'),
            destination: slot,
          }),
        { message: 'VERIFIED_CREDENTIAL_BINDING_MISMATCH' },
      );
      requireVerifiedCredentialCapability(verifiedCapability, {
        account: target,
        credential: value,
        destination: slot,
      });
      retainedVerifiedCapability = verifiedCapability;
      events.push('write');
      writes += 1;
      const current = JSON.parse(readFileSync(vault, 'utf8'));
      current[slot] = JSON.parse(value);
      writeFileSync(vault, JSON.stringify(current));
    },
  });

  if (expectedError) {
    await assert.rejects(verifiedWrite(target, credential(token), 'protected'), {
      message: expectedError,
    });
    assert.equal(writes, 0, `${name}: writer must not run`);
    assert.deepEqual(JSON.parse(readFileSync(vault, 'utf8')), { untouched: true });
    assert.deepEqual(events, ['lock', 'unlock']);
  } else {
    await verifiedWrite(target, credential(token), 'protected');
    assert.equal(writes, 1);
    assert.equal(JSON.parse(readFileSync(vault, 'utf8')).protected.claudeAiOauth.accessToken, token);
    assert.deepEqual(events, ['lock', 'write', 'unlock']);
    assert.throws(
      () =>
        requireVerifiedCredentialCapability(retainedVerifiedCapability, {
          account: target,
          credential: credential(token),
          destination: 'protected',
        }),
      { message: 'VERIFIED_CREDENTIAL_CAPABILITY_REQUIRED' },
      'verified capability revoked after write callback',
    );
  }
  console.log(`ok - ${name}`);
}

await runCase('wrong email', {
  response: { ok: true, json: async () => profile({ account: { email: 'wrong@example.test' } }) },
  expectedError: 'TOKEN_IDENTITY_MISMATCH',
});
await runCase('wrong organization UUID', {
  response: {
    ok: true,
    json: async () => profile({ organization: { uuid: 'org-wrong', name: account.orgName } }),
  },
  expectedError: 'TOKEN_IDENTITY_MISMATCH',
});
await runCase('wrong organization name', {
  response: {
    ok: true,
    json: async () => profile({ organization: { uuid: account.orgUuid, name: 'Wrong Org' } }),
  },
  expectedError: 'TOKEN_IDENTITY_MISMATCH',
});
await runCase('profile failure', {
  response: { ok: false, status: 503, json: async () => ({}) },
  expectedError: 'TOKEN_IDENTITY_PROFILE_FAILED',
});
await runCase('stale activeAccount targets another vault account', {
  target: otherAccount,
  response: { ok: true, json: async () => profile() },
  expectedError: 'TOKEN_IDENTITY_MISMATCH',
});
await runCase('verified success', {
  response: { ok: true, json: async () => profile() },
});

assert.throws(() => requireVerifiedCredentialCapability({}), { message: 'VERIFIED_CREDENTIAL_CAPABILITY_REQUIRED' });
console.log('ok - internal verified capability cannot be forged');

let noIdentityWrites = 0;
const noIdentityWriter = createVerifiedCredentialWriter({
  verify: verifyRefreshedTokenIdentity,
  withLock: (callback) => callback({}),
  requireCapability: () => {},
  write() {
    noIdentityWrites++;
  },
});
await assert.rejects(noIdentityWriter({}, credential('x')), { message: 'TOKEN_IDENTITY_CONFIG_MISSING_EMAIL' });
assert.equal(noIdentityWrites, 0);
console.log('ok - missing configured identity performs zero writes');

await assert.rejects(noIdentityWriter(account, { claudeAiOauth: { accessToken: 'mutable' } }), {
  message: 'SERIALIZED_CREDENTIAL_REQUIRED',
});
assert.equal(noIdentityWrites, 0);
console.log('ok - mutable object credentials are refused before verification');

const mutableAccount = { ...account, label: 'slot-a' };
let writtenSnapshot;
const snapshotWriter = createVerifiedCredentialWriter({
  withLock: (callback) => callback({}),
  requireCapability: () => {},
  destination: (candidate) => `slot:${candidate.label}`,
  verify: async (candidate) => {
    assert.equal(candidate.email, account.email);
    mutableAccount.email = 'mutated@example.test';
    mutableAccount.label = 'slot-b';
  },
  write(candidate, bytes, capability) {
    requireVerifiedCredentialCapability(capability, {
      account: candidate,
      credential: bytes,
      destination: `slot:${candidate.label}`,
    });
    writtenSnapshot = { candidate, bytes };
  },
});
const exactBytes = '{ "claudeAiOauth": { "accessToken": "exact-byte-token" }, "mcpOAuth": {} }';
await snapshotWriter(mutableAccount, exactBytes);
assert.equal(writtenSnapshot.candidate.email, account.email);
assert.equal(writtenSnapshot.candidate.label, 'slot-a');
assert.equal(writtenSnapshot.bytes, exactBytes);
console.log('ok - account, destination, and exact credential bytes are snapshotted before await');
