#!/usr/bin/env node
/**
 * ops-accounts CLI — multi-provider seat router (phase 0 Node implementation).
 * Never prints tokens.
 */
import { loadProviders, makeCtx } from './registry.mjs';

function usage() {
  console.log(`ops-accounts — multi-provider seat router

  ops-accounts status|list [--provider <id>]
  ops-accounts reauth <provider> <email>
  ops-accounts switch <provider> [email]
  ops-accounts refresh [all|claude|grok|openai]
  ops-accounts providers

Providers: claude, grok, openai, factory, cursor
`);
}

function rowLine(r) {
  const util = r.utilization && typeof r.utilization === 'object' ? JSON.stringify(r.utilization).slice(0, 80) : '-';
  return [
    (r.provider || '').padEnd(10),
    (r.email || r.accountId || '').padEnd(36),
    (r.tokenState || '-').padEnd(10),
    (r.active ? 'active' : '-').padEnd(8),
    (r.lastError || r.billing?.status || '').toString().slice(0, 50),
    util,
  ].join(' ');
}

async function cmdStatus(ctx, providerFilter) {
  const providers = await loadProviders();
  const header = 'PROVIDER'.padEnd(10) + 'EMAIL/ID'.padEnd(36) + 'TOKEN'.padEnd(10) + 'ACTIVE'.padEnd(8) + 'NOTE';
  console.log(header);
  console.log('-'.repeat(100));
  for (const p of providers) {
    if (providerFilter && p.providerId !== providerFilter) continue;
    let rows = [];
    try {
      rows = await p.listAccounts(ctx);
    } catch (e) {
      console.log(`${p.providerId.padEnd(10)} (list failed: ${e.message})`);
      continue;
    }
    if (!rows.length) {
      console.log(`${p.providerId.padEnd(10)} (no seats found)`);
      continue;
    }
    for (const r of rows) console.log(rowLine(r));
  }
}

async function cmdReauth(ctx, providerId, email) {
  const providers = await loadProviders();
  const p = providers.find((x) => x.providerId === providerId);
  if (!p) {
    console.error(`unknown provider: ${providerId}`);
    process.exit(2);
  }
  if (typeof p.reauth !== 'function') {
    console.error(`${providerId}: reauth not implemented`);
    process.exit(2);
  }
  const r = await p.reauth(ctx, { accountId: email, mode: 'default' });
  console.log(JSON.stringify({ provider: providerId, email, ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

async function cmdSwitch(ctx, providerId, email) {
  const providers = await loadProviders();
  const p = providers.find((x) => x.providerId === providerId);
  if (!p || typeof p.switchTo !== 'function') {
    console.error(`switch not supported for ${providerId}`);
    process.exit(2);
  }
  const r = await p.switchTo(ctx, { accountId: email });
  console.log(JSON.stringify({ provider: providerId, ...r }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

async function cmdRefresh(ctx, providerId) {
  const providers = await loadProviders();
  const list = !providerId || providerId === 'all' ? providers : providers.filter((p) => p.providerId === providerId);
  for (const p of list) {
    if (typeof p.refresh !== 'function') {
      console.log(`${p.providerId}: no refresh`);
      continue;
    }
    const r = await p.refresh(ctx, {});
    console.log(`${p.providerId}:`, r.ok ? 'ok' : r.reason || 'fail');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const ctx = makeCtx({ dryRun: process.env.OPS_ACCOUNTS_DRY_RUN === '1' });

  if (['-h', '--help', 'help'].includes(cmd)) {
    usage();
    return;
  }
  if (cmd === 'providers') {
    const providers = await loadProviders();
    for (const p of providers) {
      console.log(`${p.providerId}\t${p.displayName || ''}`);
    }
    return;
  }
  if (cmd === 'status' || cmd === 'list' || cmd === '') {
    let filter = null;
    const i = argv.indexOf('--provider');
    if (i >= 0) filter = argv[i + 1];
    await cmdStatus(ctx, filter);
    return;
  }
  if (cmd === 'reauth') {
    await cmdReauth(ctx, argv[1], argv[2]);
    return;
  }
  if (cmd === 'switch') {
    await cmdSwitch(ctx, argv[1], argv[2]);
    return;
  }
  if (cmd === 'refresh') {
    await cmdRefresh(ctx, argv[1] || 'all');
    return;
  }
  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
