#!/usr/bin/env node
/**
 * provider-router.mjs — local LLM provider router for hot, mid-session swaps.
 *
 * WHY: a Claude Code session's PROVIDER (CLAUDE_CODE_USE_BEDROCK) is an env var
 * baked in at spawn — frozen for the process. Its ACCOUNT (the
 * "Claude Code-credentials" store) is a file CC re-reads per request, so account
 * swaps are already hot/no-downtime. This router moves the provider+account
 * decision OUT of the env and into a control file the router reads per request,
 * giving provider swaps the same no-downtime property as account swaps.
 *
 * USAGE: start a session with
 *     ANTHROPIC_BASE_URL=http://127.0.0.1:8789  (and NO CLAUDE_CODE_USE_BEDROCK)
 * CC then speaks the Anthropic Messages API to this router, which forwards to
 * the upstream chosen by the control file — swap = one file write, no respawn.
 *
 * CONTROL FILE: ~/.claude/.provider-route.json
 *     { "mode": "oauth", "account": "my-account-label" }   // omit account → active claudeAiOauth
 *     { "mode": "bedrock", "region": "us-east-1" }    // phase 2 (see BEDROCK leg)
 * Re-read on EVERY request — the rotation daemon writes this instead of mutating
 * settings.json + respawning.
 *
 * PHASE 1 (this file): OAuth leg — pure passthrough to api.anthropic.com with the
 * chosen account's token injected per request. Hot account-swap, SSE streamed
 * untouched. Additive + opt-in: nothing routes through here unless a session sets
 * ANTHROPIC_BASE_URL, so it cannot affect existing sessions.
 *
 * PHASE 2 (TODO): Bedrock leg — SigV4-sign to bedrock-runtime + translate the AWS
 * event-stream framing back to SSE. Non-trivial; recommend adopting LiteLLM /
 * claude-code-router for that leg rather than hand-rolling the event-stream parser.
 */

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '';
const PORT = parseInt(process.env.PROVIDER_ROUTER_PORT || '8789', 10);
const CRED_PATH = join(HOME, '.claude', '.credentials.json');
const ROUTE_PATH = join(HOME, '.claude', '.provider-route.json');
const OAUTH_BETA = 'oauth-2025-04-20';
const UPSTREAM_OAUTH = { host: 'api.anthropic.com', port: 443 };

function log(...a) {
  process.stdout.write(`[provider-router] ${new Date().toISOString()} ${a.join(' ')}\n`);
}

/** Read the control file fresh on every request (this is what makes swaps hot). */
function readRoute() {
  try {
    return JSON.parse(readFileSync(ROUTE_PATH, 'utf8'));
  } catch {
    return { mode: 'oauth' }; // default: active OAuth account
  }
}

/** Resolve an OAuth accessToken for the chosen account (or the active one). */
function resolveOAuthToken(account) {
  let store;
  try {
    store = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
  } catch (e) {
    return { error: `cred read failed: ${e.message}` };
  }
  // Explicit account → per-account vault entry "Claude-Rotation-<key>"
  if (account) {
    const entry = store[`Claude-Rotation-${account}`];
    const tok = parseTok(entry);
    if (tok?.accessToken) return { token: tok.accessToken, source: account };
    return { error: `no token for account "${account}"` };
  }
  // Default → the live active OAuth entry
  const active = store.claudeAiOauth;
  if (active?.accessToken) return { token: active.accessToken, source: 'active' };
  return { error: 'no active claudeAiOauth token' };
}

function parseTok(entry) {
  if (!entry) return null;
  try {
    const o = typeof entry === 'string' ? JSON.parse(entry) : entry;
    return o.claudeAiOauth || o; // vault entries wrap in claudeAiOauth
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const route = readRoute();

    if (route.mode === 'bedrock') {
      // PHASE 2 not yet implemented — fail loud rather than silently meter.
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'not_implemented', message: 'router bedrock leg not yet built; set mode=oauth or use env-gated CLAUDE_CODE_USE_BEDROCK fallback' },
      }));
      log(`501 bedrock leg unimplemented (path ${req.url})`);
      return;
    }

    // ── OAuth leg ──────────────────────────────────────────────────────────
    const { token, source, error } = resolveOAuthToken(route.account);
    if (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'auth', message: error } }));
      log(`502 ${error}`);
      return;
    }

    // Clone CC's headers, override auth with the chosen account, ensure oauth beta.
    const headers = { ...req.headers };
    delete headers['x-api-key'];
    delete headers.host;
    delete headers['content-length'];
    headers.authorization = `Bearer ${token}`;
    const betas = new Set(
      String(headers['anthropic-beta'] || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
    );
    betas.add(OAUTH_BETA);
    headers['anthropic-beta'] = [...betas].join(',');

    const upReq = https.request(
      {
        host: UPSTREAM_OAUTH.host,
        port: UPSTREAM_OAUTH.port,
        method: req.method,
        path: req.url,
        headers: { ...headers, host: UPSTREAM_OAUTH.host, 'content-length': body.length },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res); // stream SSE/body straight through
      },
    );
    upReq.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'upstream', message: e.message } }));
      log(`502 upstream ${e.message}`);
    });
    upReq.end(body);
    log(`${req.method} ${req.url} → oauth(${source})`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} (control: ${ROUTE_PATH})`);
});
