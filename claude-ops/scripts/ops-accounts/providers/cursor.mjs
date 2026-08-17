/**
 * Cursor adapter — identity from last quota probe; remaining needs session cookie.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const providerId = 'cursor';
export const displayName = 'Cursor';

export async function listAccounts(ctx) {
  const snapPath = join(ctx.home, '.claude/quota-snapshots/cursor-latest.json');
  let snap = null;
  if (existsSync(snapPath)) {
    try {
      snap = JSON.parse(readFileSync(snapPath, 'utf8'));
    } catch {
      snap = null;
    }
  }
  const id = snap?.identity || {};
  const email = id.userEmail || null;
  const hasKey = Boolean(process.env.CURSOR_API_KEY);
  return [
    {
      provider: providerId,
      accountId: email || 'cursor-primary',
      email,
      label: id.apiKeyName || 'Cursor',
      tokenState: hasKey || snap?.v1_me_http === 200 ? 'valid' : 'missing',
      active: snap?.v1_me_http === 200,
      utilization: {
        pools: snap?.pools || [],
        note: 'Remaining requires WorkosCursorSessionToken (browser) or Enterprise admin',
      },
      lastError: null,
      http: { me: snap?.v1_me_http, usage: snap?.usage_http },
      reauth: {
        status: 'unavailable',
        note: 'Cursor cloud login + optional BYOK via gateway; no magic-link cascade in plugin',
      },
    },
  ];
}

export async function reauth() {
  return {
    ok: false,
    reason: 'cursor-reauth-not-automated',
    handoff: 'Sign in at cursor.com; for remaining, export session cookie or use Enterprise admin key',
  };
}

export async function utilization(ctx) {
  const snapPath = join(ctx.home, '.claude/quota-snapshots/cursor-latest.json');
  if (!existsSync(snapPath)) return { windows: [], source: 'unavailable' };
  try {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
    return {
      windows: [],
      source: snap.source || 'cursor-probe',
      pools: snap.pools || [],
      http: { me: snap.v1_me_http, usage: snap.usage_http },
    };
  } catch {
    return { windows: [], source: 'unavailable' };
  }
}
