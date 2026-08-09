import { verifyRefreshedTokenIdentity } from './token-identity.mjs';
import { requireWriterCapability, withAuthWriterLock } from './auth-writer-coordination.mjs';
import { createHash } from 'node:crypto';

const verifiedCapabilities = new WeakMap();

function credentialDigest(credential) {
  if (typeof credential !== 'string') throw new Error('SERIALIZED_CREDENTIAL_REQUIRED');
  return createHash('sha256').update(credential).digest('hex');
}

function binding(account, credential, destination) {
  return {
    email: String(account?.email || '')
      .trim()
      .toLowerCase(),
    organizationUuid: String(account?.orgUuid || '').trim(),
    organizationName: String(account?.orgName || '').trim(),
    credentialDigest: credentialDigest(credential),
    destination: String(destination || ''),
  };
}
function snapshotAccount(account) {
  return Object.freeze({
    email: String(account?.email || '')
      .trim()
      .toLowerCase(),
    orgUuid: String(account?.orgUuid || '').trim(),
    orgName: String(account?.orgName || '').trim(),
    ...(account?.label == null ? {} : { label: String(account.label) }),
  });
}

export function requireVerifiedCredentialCapability(capability, expected) {
  const actual = verifiedCapabilities.get(capability);
  if (!actual) throw new Error('VERIFIED_CREDENTIAL_CAPABILITY_REQUIRED');
  const wanted = binding(expected.account, expected.credential, expected.destination);
  for (const key of Object.keys(wanted))
    if (actual[key] !== wanted[key]) throw new Error('VERIFIED_CREDENTIAL_BINDING_MISMATCH');
  actual.requireCapability(actual.writerCapability);
  verifiedCapabilities.delete(capability);
  return actual.writerCapability;
}

export function extractCredentialAccessToken(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('TOKEN_IDENTITY_ACCESS_TOKEN_MISSING');
  }
  const token = parsed?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || !token.trim()) throw new Error('TOKEN_IDENTITY_ACCESS_TOKEN_MISSING');
  return token.trim();
}

/**
 * Construct the sole boundary allowed to invoke a protected credential writer.
 * The raw writer remains closed over and cannot be called by consumers.
 */
export function createVerifiedCredentialWriter({
  write,
  verify = verifyRefreshedTokenIdentity,
  withLock = withAuthWriterLock,
  requireCapability = requireWriterCapability,
  destination = (_account, _credential, ...writeArgs) => writeArgs[0],
} = {}) {
  if (typeof write !== 'function') throw new TypeError('VERIFIED_CREDENTIAL_WRITER_REQUIRED');
  if (typeof verify !== 'function') throw new TypeError('TOKEN_IDENTITY_VERIFIER_REQUIRED');

  const coordinated = async (account, credential, writerCapability, ...writeArgs) => {
    requireCapability(writerCapability);
    if (typeof credential !== 'string') throw new Error('SERIALIZED_CREDENTIAL_REQUIRED');
    const accountSnapshot = snapshotAccount(account);
    const serializedCredential = credential;
    const destinationSnapshot = String(destination(accountSnapshot, serializedCredential, ...writeArgs));
    const accessToken = extractCredentialAccessToken(serializedCredential);
    await verify(accountSnapshot, accessToken);
    const verifiedCapability = Object.freeze({});
    verifiedCapabilities.set(verifiedCapability, {
      writerCapability,
      requireCapability,
      ...binding(accountSnapshot, serializedCredential, destinationSnapshot),
    });
    try {
      return await write(accountSnapshot, serializedCredential, verifiedCapability, ...writeArgs);
    } finally {
      verifiedCapabilities.delete(verifiedCapability);
    }
  };
  const verifiedCredentialWrite = (account, credential, ...writeArgs) =>
    withLock((writerCapability) => coordinated(account, credential, writerCapability, ...writeArgs));
  verifiedCredentialWrite.coordinated = coordinated;
  return verifiedCredentialWrite;
}
