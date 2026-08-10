/** Authoritative identity check required before refreshed Claude token writes. */
const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`TOKEN_IDENTITY_CONFIG_MISSING_${field}`);
  return value.trim();
}

export function configuredTokenIdentity(account) {
  return {
    email: required(account?.email, 'EMAIL').toLowerCase(),
    organizationUuid: required(account?.organizationUuid || account?.orgUuid, 'ORGANIZATION_UUID'),
    organizationName: required(
      account?.organizationName || account?.orgName || account?.organization,
      'ORGANIZATION_NAME',
    ),
  };
}

export async function verifyRefreshedTokenIdentity(account, accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const expected = configuredTokenIdentity(account);
  required(accessToken, 'ACCESS_TOKEN');
  let profile;
  try {
    // The OAuth token is intentionally sent only to Anthropic's fixed profile
    // endpoint to verify the credential's configured account identity.
    // CodeQL[js/file-access-to-http]
    const response = await fetchImpl(PROFILE_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response?.ok) throw new Error('profile response failed');
    profile = await response.json();
  } catch {
    throw new Error('TOKEN_IDENTITY_PROFILE_FAILED');
  }
  let actual;
  try {
    actual = {
      email: required(profile?.account?.email, 'PROFILE_EMAIL').toLowerCase(),
      organizationUuid: required(profile?.organization?.uuid, 'PROFILE_ORGANIZATION_UUID'),
      organizationName: required(profile?.organization?.name, 'PROFILE_ORGANIZATION_NAME'),
    };
  } catch {
    throw new Error('TOKEN_IDENTITY_PROFILE_FAILED');
  }
  if (
    actual.email !== expected.email ||
    actual.organizationUuid !== expected.organizationUuid ||
    actual.organizationName !== expected.organizationName
  )
    throw new Error('TOKEN_IDENTITY_MISMATCH');
  return actual;
}
