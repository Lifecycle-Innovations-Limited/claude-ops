#!/usr/bin/env node
/**
 * ops-accounts-gateway.mjs — thin optional OpenAI-compat gateway.
 *
 * Skeleton (Phase D):
 *   - GET  /health, /v1/health
 *   - GET  /v1/models (stub inventory)
 *   - *    /v1/* Grok paths → optional endpoint from GROK_PROXY_URL
 *   - POST /v1/chat/completions | /v1/messages → Claude seat pick + stub upstream
 *   - API key gate via OPS_ACCOUNTS_GATEWAY_KEY (optional in dev)
 *
 * State: file seat-state only. No Redis. No admin SPA.
 *
 * Env:
 *   OPS_ACCOUNTS_GATEWAY_PORT   default 3005
 *   OPS_ACCOUNTS_GATEWAY_HOST   default 127.0.0.1
 *   OPS_ACCOUNTS_GATEWAY_KEY    if set, require Bearer / x-api-key / api-key
 *   OPS_ACCOUNTS_STATE_PATH     seat-state.json path
 *   GROK_PROXY_URL              optional Grok-compatible upstream base URL
 *   CLAUDE_UPSTREAM_URL         optional Anthropic-compat base (not required for health)
 *
 * Usage:
 *   node ops-accounts-gateway.mjs                 # listen
 *   node ops-accounts-gateway.mjs --self-test     # pure checks, exit
 *   node ops-accounts-gateway.mjs --print-config
 */
import http from 'http';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const HOST = process.env.OPS_ACCOUNTS_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(process.env.OPS_ACCOUNTS_GATEWAY_PORT || '3005');
const GATEWAY_KEY = process.env.OPS_ACCOUNTS_GATEWAY_KEY || '';
const GROK_PROXY_URL = (process.env.GROK_PROXY_URL || '').replace(/\/$/, '');
const CLAUDE_UPSTREAM_URL = (process.env.CLAUDE_UPSTREAM_URL || '').replace(/\/$/, '');
const DATA = process.env.CLAUDE_PLUGIN_DATA_DIR || join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
const STATE_PATH = process.env.OPS_ACCOUNTS_STATE_PATH || join(DATA, 'account-rotation', 'seat-state.json');

export function loadSeatState(path = STATE_PATH) {
  if (!existsSync(path)) {
    return { version: 1, updatedAt: null, providers: {}, path, missing: true };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { version: 1, providers: {}, ...raw, path, missing: false };
  } catch (err) {
    return { version: 1, updatedAt: null, providers: {}, path, missing: true, error: String(err) };
  }
}

/** Pick first schedulable seat for provider (stable email sort for determinism). */
export function pickSchedulableSeat(state, provider = 'claude') {
  const seats = state?.providers?.[provider]?.seats || {};
  const emails = Object.keys(seats).sort();
  for (const email of emails) {
    const s = seats[email];
    if (s && s.schedulable === false) continue;
    if (s?.exhaustedUntil) {
      const until = Date.parse(s.exhaustedUntil);
      if (!Number.isNaN(until) && until > Date.now()) continue;
    }
    return { email, seat: s || {} };
  }
  return null;
}

export function classifyRoute(method, urlPath) {
  const path = (urlPath || '/').split('?')[0] || '/';
  if (path === '/health' || path === '/v1/health') return { kind: 'health', path };
  if (path === '/v1/models' || path === '/models') return { kind: 'models', path };
  if (path === '/accounts' || path === '/v1/accounts') return { kind: 'accounts', path };
  // Grok hop: anything mentioning grok, or xAI-shaped image routes
  if (/\/grok(\/|$)/i.test(path) || path.startsWith('/v1/images') || path.startsWith('/images')) {
    return { kind: 'grok-proxy', path };
  }
  if (
    (method === 'POST' || method === 'OPTIONS') &&
    (path === '/v1/chat/completions' ||
      path === '/chat/completions' ||
      path === '/v1/messages' ||
      path === '/messages' ||
      path === '/v1/responses' ||
      path === '/responses')
  ) {
    return { kind: 'claude', path };
  }
  if (path.startsWith('/v1/') || path === '/v1') return { kind: 'openai-passthrough', path };
  return { kind: 'unknown', path };
}

export function extractApiKey(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const x = h['x-api-key'] || h['api-key'] || h['x-api-key'.toLowerCase()];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return '';
}

export function authorize(req, key = GATEWAY_KEY) {
  if (!key) return { ok: true, reason: 'open' };
  const got = extractApiKey(req);
  if (!got) return { ok: false, reason: 'missing_key' };
  if (got !== key) return { ok: false, reason: 'bad_key' };
  return { ok: true, reason: 'matched' };
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    'cache-control': 'no-store',
  });
  res.end(raw);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyToGrok(req, res, urlPath) {
  if (!GROK_PROXY_URL) {
    sendJson(res, 503, {
      error: {
        message: 'Grok proxy is not configured; set GROK_PROXY_URL',
        type: 'configuration_error',
      },
    });
    return;
  }
  const target = new URL(urlPath, GROK_PROXY_URL);
  // Map /grok/v1/... → proxy /v1/...
  let p = target.pathname;
  p = p.replace(/^\/grok(?=\/|$)/i, '');
  if (!p.startsWith('/v1') && p !== '/health' && p !== '/accounts') {
    if (p === '/' || p === '') p = '/health';
    else if (!p.startsWith('/')) p = '/' + p;
  }
  const dest = `${GROK_PROXY_URL}${p}${target.search || ''}`;
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req);
  }
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  const upstream = await fetch(dest, {
    method: req.method,
    headers,
    body: body && body.length ? body : undefined,
  }).catch((err) => ({ ok: false, status: 502, _err: err }));
  if (upstream._err) {
    sendJson(res, 502, {
      error: {
        message: `grok proxy unreachable at ${GROK_PROXY_URL}: ${upstream._err.message}`,
        type: 'gateway_error',
      },
    });
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const outHeaders = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
  res.writeHead(upstream.status, outHeaders);
  res.end(buf);
}

function handleHealth(res) {
  const state = loadSeatState();
  const claude = pickSchedulableSeat(state, 'claude');
  sendJson(res, 200, {
    ok: true,
    service: 'ops-accounts-gateway',
    version: 1,
    port: PORT,
    seatState: {
      path: state.path,
      missing: !!state.missing,
      updatedAt: state.updatedAt || null,
      claudeSchedulable: claude ? claude.email : null,
    },
    grokProxy: GROK_PROXY_URL || null,
    claudeUpstream: CLAUDE_UPSTREAM_URL || null,
    apiKeyRequired: Boolean(GATEWAY_KEY),
    mode: 'skeleton',
  });
}

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: [
      { id: 'claude-ops-gateway', object: 'model', owned_by: 'ops-accounts' },
      { id: 'grok-via-proxy', object: 'model', owned_by: 'ops-accounts' },
    ],
  });
}

function handleAccounts(res) {
  const state = loadSeatState();
  const out = {};
  for (const [provider, blob] of Object.entries(state.providers || {})) {
    const seats = blob.seats || {};
    out[provider] = Object.fromEntries(
      Object.entries(seats).map(([email, s]) => [
        email,
        {
          schedulable: s.schedulable !== false,
          util5h: s.util5h ?? null,
          util7d: s.util7d ?? null,
          exhaustedUntil: s.exhaustedUntil ?? null,
        },
      ]),
    );
  }
  sendJson(res, 200, {
    backend: 'local-seat-state',
    path: state.path,
    missing: !!state.missing,
    providers: out,
  });
}

async function handleClaude(req, res, route) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, api-key',
      'access-control-allow-methods': 'POST, OPTIONS',
    });
    res.end();
    return;
  }
  const state = loadSeatState();
  const picked = pickSchedulableSeat(state, 'claude');
  if (!picked) {
    sendJson(res, 503, {
      error: {
        message: 'no schedulable Claude seat in seat-state; run ops-accounts seats import-claude-config or seats set',
        type: 'no_capacity',
      },
    });
    return;
  }
  // Skeleton: do not invent OAuth vault reads here. Either forward to CLAUDE_UPSTREAM_URL
  // (operator-supplied Anthropic-compat) or return 501 with the chosen seat so harnesses
  // can prove routing end to end.
  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: { message: String(err.message || err), type: 'payload_error' } });
    return;
  }
  if (CLAUDE_UPSTREAM_URL) {
    const dest = `${CLAUDE_UPSTREAM_URL}${route.path.startsWith('/v1') ? route.path : '/v1' + route.path}`;
    const headers = { ...req.headers, host: undefined };
    delete headers.host;
    const upstream = await fetch(dest, {
      method: 'POST',
      headers,
      body: bodyBuf,
    }).catch((err) => ({ _err: err }));
    if (upstream._err) {
      sendJson(res, 502, {
        error: { message: `claude upstream failed: ${upstream._err.message}`, type: 'gateway_error' },
      });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'x-ops-accounts-seat': picked.email,
    });
    res.end(buf);
    return;
  }
  sendJson(res, 501, {
    error: {
      message:
        'ops-accounts-gateway skeleton: Claude vault OAuth hop not wired yet. Seat selected; set CLAUDE_UPSTREAM_URL for temporary forward, or wait for vault hop PR.',
      type: 'not_implemented',
      seat: picked.email,
      route: route.path,
    },
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      const route = classifyRoute(req.method || 'GET', url.pathname);

      if (route.kind === 'health') {
        handleHealth(res);
        return;
      }

      const auth = authorize(req);
      if (!auth.ok) {
        sendJson(res, 401, {
          error: { message: `unauthorized (${auth.reason})`, type: 'auth_error' },
        });
        return;
      }

      if (route.kind === 'models') {
        handleModels(res);
        return;
      }
      if (route.kind === 'accounts') {
        handleAccounts(res);
        return;
      }
      if (route.kind === 'grok-proxy') {
        await proxyToGrok(req, res, url.pathname + url.search);
        return;
      }
      if (route.kind === 'claude') {
        await handleClaude(req, res, route);
        return;
      }
      if (route.kind === 'openai-passthrough') {
        sendJson(res, 404, {
          error: {
            message: `no handler for ${route.path} in skeleton gateway (use /v1/chat/completions, /v1/messages, /grok/v1/*, /health)`,
            type: 'not_found',
          },
        });
        return;
      }
      sendJson(res, 404, {
        error: { message: `unknown path ${route.path}`, type: 'not_found' },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err?.message || err), type: 'internal_error' },
      });
    }
  });
}

function selfTest() {
  const routeH = classifyRoute('GET', '/health');
  if (routeH.kind !== 'health') throw new Error('health classify');
  const routeG = classifyRoute('POST', '/grok/v1/chat/completions');
  if (routeG.kind !== 'grok-proxy') throw new Error('grok classify');
  const routeC = classifyRoute('POST', '/v1/chat/completions');
  if (routeC.kind !== 'claude') throw new Error('claude classify');
  const state = {
    providers: {
      claude: {
        seats: {
          'b@example.com': { schedulable: false },
          'a@example.com': { schedulable: true },
        },
      },
    },
  };
  const pick = pickSchedulableSeat(state, 'claude');
  if (!pick || pick.email !== 'a@example.com') throw new Error('pick seat');
  const authOpen = authorize({ headers: {} }, '');
  if (!authOpen.ok) throw new Error('open auth');
  const authBad = authorize({ headers: {} }, 'secret');
  if (authBad.ok) throw new Error('should require key');
  const authOk = authorize({ headers: { authorization: 'Bearer secret' } }, 'secret');
  if (!authOk.ok) throw new Error('bearer ok');
  console.log('ops-accounts-gateway self-test: ok');
}

function printConfig() {
  console.log(
    JSON.stringify(
      {
        host: HOST,
        port: PORT,
        statePath: STATE_PATH,
        grokProxy: GROK_PROXY_URL || null,
        claudeUpstream: CLAUDE_UPSTREAM_URL || null,
        apiKeyRequired: Boolean(GATEWAY_KEY),
      },
      null,
      2,
    ),
  );
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (argv.includes('--print-config')) {
    printConfig();
    return;
  }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(
      `ops-accounts-gateway listening on http://${HOST}:${PORT} (seat-state=${STATE_PATH}; grok=${GROK_PROXY_URL ? 'configured' : 'unconfigured'})`,
    );
  });
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main();
}
