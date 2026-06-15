#!/usr/bin/env node
/**
 * crs-bedrock-guard.mjs — WARN when the CRS relay actually serves via the
 * bedrock-fallback account (i.e. the OAuth Max pool got exhausted and CRS fell
 * back to paid AWS Bedrock). App-level signal: polls the bedrock-fallback
 * account's usage.total.requests and alerts when it climbs.
 *
 * Pairs with the network-level bedrock-net-monitor (catches Bedrock from ANY
 * source). Runs via crs-bedrock-guard.timer (every 5 min).
 */
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';

const HOME = process.env.HOME;
const CRS = 'http://127.0.0.1:3005';
const STATE = join(HOME, '.claude', '.crs-bedrock-guard-state.json');
const ALERT = join(HOME, '.claude', '.bedrock-alert.json');
const LOGDIR = join(HOME, '.claude', 'logs');
const LOG = join(LOGDIR, 'bedrock-alerts.log');

function log(m) {
  try {
    mkdirSync(LOGDIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] [crs-guard] ${m}\n`);
  } catch {}
  console.log(m);
}
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  const t = `${STATE}.tmp.${process.pid}`;
  writeFileSync(t, JSON.stringify(s, null, 2));
  renameSync(t, STATE);
}

function alert(payload) {
  try {
    const t = `${ALERT}.tmp.${process.pid}`;
    writeFileSync(t, JSON.stringify(payload, null, 2));
    renameSync(t, ALERT);
  } catch {}
  log(`🚨 ALERT: ${payload.message}`);
  try {
    spawnSync('notify-send', ['-u', 'critical', '🚨 CRS→Bedrock fallback', payload.message], { timeout: 3000 });
  } catch {}
}

async function main() {
  let pw = '';
  try {
    pw = execSync(
      `docker inspect crs-claude-relay-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ADMIN_PASSWORD=//p'`,
      { timeout: 8000 },
    )
      .toString()
      .trim();
  } catch {}
  if (!pw) {
    log('CRS not reachable (no admin pw) — skip');
    return;
  }
  const login = await fetch(`${CRS}/web/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cradmin', password: pw }),
  })
    .then((r) => r.json())
    .catch(() => ({}));
  const tok = login.token || login.data?.token;
  if (!tok) {
    log('CRS login failed — skip');
    return;
  }
  const resp = await fetch(`${CRS}/admin/bedrock-accounts`, { headers: { Authorization: `Bearer ${tok}` } })
    .then((r) => r.json())
    .catch(() => ({}));
  const accts = resp.data || resp.accounts || resp || [];
  const be = (Array.isArray(accts) ? accts : []).find((a) => a.platform === 'bedrock' || a.type === 'bedrock');
  if (!be) {
    log('no bedrock account registered — skip');
    return;
  }

  const totalReq = be.usage?.total?.requests ?? 0;
  const dailyReq = be.usage?.daily?.requests ?? 0;
  const dailyCost = be.usage?.daily?.cost ?? 0;
  const st = loadState();
  const prev = st.totalRequests ?? 0;

  if (totalReq > prev) {
    const delta = totalReq - prev;
    alert({
      ts: new Date().toISOString(),
      source: 'crs-pool-fallback',
      account: be.name,
      message: `CRS served ${delta} request(s) via AWS Bedrock fallback (OAuth pool was exhausted). total=${totalReq}, today=${dailyReq} req / $${dailyCost}. Check why the 10-account Max pool ran dry.`,
      deltaRequests: delta,
      totalRequests: totalReq,
      dailyRequests: dailyReq,
      dailyCost,
    });
  } else {
    log(`ok — bedrock total=${totalReq} (no new fallback traffic)`);
  }
  saveState({ totalRequests: totalReq, lastCheck: new Date().toISOString() });
}
main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
