#!/usr/bin/env node
// ops-stripe-conversion-bridge — Stripe webhook → GA4 + Meta CAPI fanout
//
// Listens for Stripe webhook events, validates the signature, and fans out
// purchase conversion signals to GA4 Measurement Protocol and Meta CAPI by
// shelling out to bin/ops-conversion-send and bin/ops-meta-capi-send.
//
// Supported events:
//   charge.succeeded
//   checkout.session.completed
//
// Metadata keys read from Stripe checkout.session.metadata / charge.metadata:
//   utm_source, utm_medium, utm_campaign, utm_term, utm_content
//   client_id          — GA4 client_id (anonymous device identifier)
//   fbp                — Meta _fbp browser cookie value
//   fbc                — Meta _fbc browser cookie value
//   event_source_url   — canonical page URL for CAPI
//
// For checkout.session, client_reference_id is also read as a fallback client_id.
//
// Environment:
//   OPS_STRIPE_BRIDGE_PORT     — HTTP port (default: 8787)
//   STRIPE_WEBHOOK_SECRET      — Stripe webhook signing secret (whsec_...)
//   OPS_CONVERSION_PROJECT     — ops-conversion-send --project key
//   OPS_DATA_DIR               — log directory root
//   OPS_DRY_RUN=1              — forwarded to child senders (no network calls)
//
// Rule 0: no hardcoded accounts, secrets, or personal data.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');

const PORT = parseInt(process.env.OPS_STRIPE_BRIDGE_PORT ?? '8787', 10);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const PROJECT = process.env.OPS_CONVERSION_PROJECT ?? '';
const DATA_DIR = process.env.OPS_DATA_DIR ?? `${process.env.HOME}/.claude/plugins/data/ops-ops-marketplace`;
const LOG_DIR = resolve(DATA_DIR, 'logs');
const LOG_FILE = resolve(LOG_DIR, 'stripe-bridge.log');

/** ISO 4217 codes Stripe treats as zero-decimal (amount is already in major units). */
const STRIPE_ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'isk',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'uyi',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

/** @param {string} msg */
function log(msg) {
  const line = `${new Date().toISOString()} [stripe-bridge] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    /* non-fatal */
  }
}

if (!WEBHOOK_SECRET) {
  log('ERROR: STRIPE_WEBHOOK_SECRET is not set — refusing to start');
  process.exit(1);
}
if (!PROJECT) {
  log('ERROR: OPS_CONVERSION_PROJECT is not set — refusing to start');
  process.exit(1);
}

// ── Stripe webhook signature verification ────────────────────────────────────
// Implements the Stripe v1 HMAC-SHA256 scheme without the stripe npm package
// so the bridge has zero npm dependencies beyond Node builtins.
/**
 * @param {string} payload  raw request body string
 * @param {string} sigHeader  value of Stripe-Signature header
 * @param {string} secret  webhook signing secret (whsec_... or raw)
 * @returns {{ valid: boolean, event: object | null }}
 */
function constructEvent(payload, sigHeader, secret) {
  if (!sigHeader) return { valid: false, event: null };

  // Stripe may send multiple v1= signatures during webhook secret rotation; collect all.
  let ts = '';
  const v1Signatures = [];
  for (const pair of sigHeader.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1);
    if (k === 't') ts = v;
    else if (k === 'v1') v1Signatures.push(v);
  }
  if (!ts || v1Signatures.length === 0) return { valid: false, event: null };

  // Stripe uses the full signing secret (including whsec_ prefix) as the UTF-8 HMAC key.
  const signedPayload = `${ts}.${payload}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  let valid = false;
  for (const v1 of v1Signatures) {
    const v1Buf = Buffer.from(v1, 'hex');
    if (expectedBuf.length === v1Buf.length && timingSafeEqual(expectedBuf, v1Buf)) {
      valid = true;
      break;
    }
  }

  if (!valid) return { valid: false, event: null };

  // Replay-attack window: reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > 300) return { valid: false, event: null };

  try {
    return { valid: true, event: JSON.parse(payload) };
  } catch {
    return { valid: false, event: null };
  }
}

// ── Shell out to conversion senders ─────────────────────────────────────────
const GA4_BIN = resolve(PLUGIN_ROOT, 'bin', 'ops-conversion-send');
const CAPI_BIN = resolve(PLUGIN_ROOT, 'bin', 'ops-meta-capi-send');

/**
 * @param {string} bin
 * @param {string[]} args
 * @returns {boolean}
 */
function runSender(bin, args) {
  if (!existsSync(bin)) {
    log(`WARN: sender binary not found: ${bin}`);
    return false;
  }
  const env = { ...process.env };
  const result = spawnSync(bin, args, { encoding: 'utf8', env });
  if (result.error) {
    log(`ERROR: failed to spawn ${bin}: ${result.error.message}`);
    return false;
  }
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    log(`ERROR: ${bin} exited ${result.status} — ${combined}`);
    return false;
  }
  log(`OK: ${bin} — ${combined.split('\n')[0] ?? 'success'}`);
  return true;
}

/**
 * @param {number} amount Stripe amount (minor units, or major for zero-decimal currencies)
 * @param {string} currencyLower ISO 4217 lowercased
 */
function formatStripeAmount(amount, currencyLower) {
  if (STRIPE_ZERO_DECIMAL.has(currencyLower)) {
    return String(amount);
  }
  return (amount / 100).toFixed(2);
}

/**
 * Extract metadata from a Stripe event object.
 * Handles both charge.succeeded and checkout.session.completed shapes.
 * @param {object} stripeObject  event.data.object
 * @returns {{ meta: object, amountDecimal: string | null, currency: string | null }}
 */
function extractMetadata(stripeObject) {
  const meta = stripeObject.metadata ?? {};
  let amountDecimal = null;
  let currency = null;
  const currencyLower = (stripeObject.currency ?? 'usd').toLowerCase();
  const currencyUpper = currencyLower.toUpperCase();

  // charge.succeeded / checkout.session: amount uses Stripe minor units except zero-decimal ISO codes
  if (typeof stripeObject.amount === 'number') {
    amountDecimal = formatStripeAmount(stripeObject.amount, currencyLower);
    currency = currencyUpper;
  }
  if (typeof stripeObject.amount_total === 'number') {
    amountDecimal = formatStripeAmount(stripeObject.amount_total, currencyLower);
    currency = currencyUpper;
  }

  // client_reference_id as fallback client_id
  if (!meta.client_id && stripeObject.client_reference_id) {
    meta.client_id = stripeObject.client_reference_id;
  }

  return { meta, amountDecimal, currency };
}

/**
 * Fan out a purchase event to GA4 + Meta CAPI.
 * @param {object} stripeObject
 * @param {string} stripeEventId
 */
function fanoutPurchase(stripeObject, stripeEventId) {
  const { meta, amountDecimal, currency } = extractMetadata(stripeObject);
  const eventTime = Math.floor(Date.now() / 1000).toString();
  const eventSourceUrl = meta.event_source_url ?? 'https://<your-domain.com>';

  log(`Fanning out purchase: event_id=${stripeEventId} value=${amountDecimal} ${currency}`);

  // ── GA4 ──────────────────────────────────────────────────────────────────
  if (meta.client_id) {
    const ga4Args = [
      'ga4',
      '--project',
      PROJECT,
      '--event',
      'purchase',
      '--client-id',
      meta.client_id,
      '--transaction-id',
      stripeEventId,
    ];
    if (amountDecimal) ga4Args.push('--value', amountDecimal);
    if (currency) ga4Args.push('--currency', currency);
    runSender(GA4_BIN, ga4Args);
  } else {
    log('WARN: no client_id in metadata — skipping GA4 fanout');
  }

  // ── Meta CAPI ─────────────────────────────────────────────────────────────
  const capiArgs = [
    'event',
    '--project',
    PROJECT,
    '--event-name',
    'Purchase',
    '--event-time',
    eventTime,
    '--action-source',
    'website',
    '--event-source-url',
    eventSourceUrl,
  ];
  if (meta.fbp) capiArgs.push('--fbp', meta.fbp);
  if (meta.fbc) capiArgs.push('--fbc', meta.fbc);
  if (amountDecimal) capiArgs.push('--value', amountDecimal);
  if (currency) capiArgs.push('--currency', currency);
  runSender(CAPI_BIN, capiArgs);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', project: PROJECT }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers['stripe-signature'] ?? '';

    const { valid, event } = constructEvent(body, sigHeader, WEBHOOK_SECRET);
    if (!valid) {
      log('WARN: invalid Stripe signature or replay — rejecting');
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const eventType = event?.type ?? '';
    const obj = event?.data?.object ?? {};
    const eventId = event?.id ?? `evt_${Date.now()}`;

    log(`Received Stripe event: type=${eventType} id=${eventId}`);

    switch (eventType) {
      case 'charge.succeeded':
      case 'checkout.session.completed':
        fanoutPurchase(obj, eventId);
        break;
      default:
        log(`Ignoring unhandled event type: ${eventType}`);
    }

    res.writeHead(200);
    res.end('OK');
  });

  req.on('error', (err) => {
    log(`ERROR: request read error: ${err.message}`);
    res.writeHead(500);
    res.end('Internal Server Error');
  });
});

server.listen(PORT, () => {
  log(`Stripe conversion bridge listening on port ${PORT}`);
  log(`Project: ${PROJECT} | Log: ${LOG_FILE}`);
  log(`Dry-run: ${process.env.OPS_DRY_RUN === '1' ? 'YES' : 'no'}`);
});

server.on('error', (err) => {
  log(`FATAL: server error: ${err.message}`);
  process.exit(1);
});
