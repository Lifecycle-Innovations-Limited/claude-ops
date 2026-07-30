/**
 * Smoke: load providers and list without throwing; no secrets.
 */
import { loadProviders, makeCtx } from '../registry.mjs';

const ctx = makeCtx({ dryRun: true });
const providers = await loadProviders();
const ids = providers.map((p) => p.providerId).sort();
const expect = ['claude', 'cursor', 'factory', 'grok', 'openai'];
for (const id of expect) {
  if (!ids.includes(id)) {
    console.error('missing provider', id, 'have', ids);
    process.exit(1);
  }
}
for (const p of providers) {
  const rows = await p.listAccounts(ctx);
  if (!Array.isArray(rows)) {
    console.error(p.providerId, 'listAccounts not array');
    process.exit(1);
  }
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (/sk-|cr_|vk-lw-|eyJ|refresh_token|access_token/i.test(s) && /"[a-zA-Z0-9_-]{20,}"/.test(s)) {
      // soft check — fail only on obvious long secret-looking values under token keys
      if (/"accessToken"\s*:\s*"[^"]{10,}"/i.test(s) || /"refresh_token"\s*:\s*"[^"]{10,}"/i.test(s)) {
        console.error(p.providerId, 'leaked token-like field');
        process.exit(1);
      }
    }
  }
  console.log(p.providerId, 'rows', rows.length);
}
console.log('ops-accounts-smoke: ok');
