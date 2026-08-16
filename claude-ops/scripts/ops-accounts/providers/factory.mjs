/**
 * Factory / Droid adapter — reports key presence + last quota snapshot.
 * Does not invent remaining when vendor returns 402.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const providerId = 'factory';
export const displayName = 'Factory / Droid';

export async function listAccounts(ctx) {
  const snapPath = join(ctx.home, '.claude/crs-keys/quota/factory-droid.json');
  let snap = null;
  if (existsSync(snapPath)) {
    try {
      snap = JSON.parse(readFileSync(snapPath, 'utf8'));
    } catch {
      snap = null;
    }
  }
  const keyPresent = Boolean(
    process.env.FACTORY_API_KEY ||
    (existsSync(join(ctx.home, '.factory/auth.v2.file')) && existsSync(join(ctx.home, '.factory/auth.v2.key'))),
  );
  const blocked = snap?.http?.chat_usage === 402 || snap?.source === 'vendor_402_unpaid';
  return [
    {
      provider: providerId,
      accountId: 'factory-primary',
      email: null,
      label: 'box-primary-key',
      tokenState: keyPresent ? (blocked ? 'expired' : 'valid') : 'missing',
      active: keyPresent && !blocked,
      utilization: snap?.remaining
        ? {
            standard: snap.remaining.standard,
            premium: snap.remaining.premium,
            status: snap.remaining.status,
          }
        : null,
      crs: null,
      lastError: blocked ? snap?.vendor_detail || 'HTTP 402 no active paid subscription' : snap?.error || null,
      billing: snap?.billing_mail_hint || null,
      http: snap?.http || null,
      note: 'Multiple orgs can share one mailbox; the feeder probes a single FACTORY_API_KEY',
      reauth: { status: 'unavailable', note: 'pay invoice / restore Factory billing; no OAuth cascade' },
    },
  ];
}

export async function reauth() {
  return {
    ok: false,
    reason: 'factory-billing-not-reauth',
    handoff: 'Restore paid subscription in Factory org (402 = unpaid). See Gmail invoices GGDXNY / DGPBWS.',
  };
}

export async function utilization(ctx) {
  const snapPath = join(ctx.home, '.claude/crs-keys/quota/factory-droid.json');
  if (!existsSync(snapPath)) {
    return { windows: [], source: 'unavailable' };
  }
  try {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
    return {
      windows: [],
      source: snap.source || 'factory-snapshot',
      http: snap.http,
      remaining: snap.remaining,
    };
  } catch {
    return { windows: [], source: 'unavailable' };
  }
}
