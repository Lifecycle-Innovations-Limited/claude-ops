#!/usr/bin/env node
// Retired. This file contains no network, credential, or account mutation code.
// Use refresh-tokens.mjs and crs-token-feed.mjs for identity-verified recovery.

const status = process.argv.includes('--status');
if (status) {
  console.log('CRS 401 refresher: retired; use identity-verified token refresh and feed');
  process.exit(0);
}
console.error('CRS_401_REFRESHER_RETIRED_USE_VERIFIED_TOKEN_FEED');
process.exit(1);
