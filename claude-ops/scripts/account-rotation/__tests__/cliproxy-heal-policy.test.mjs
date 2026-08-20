#!/usr/bin/env node
/**
 * Gating tests for cliproxy heal / re-entry. Drive healPool + runHealTick
 * from representative start states. Do not re-implement the policy here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, healPool } from '../cliproxy-heal-policy.mjs';
import { snapshotFromAuthDir } from '../cliproxy-pool-snapshot.mjs';
import { applyDecision, runHealTick } from '../cliproxy-heal-tick.mjs';
import { parseAdviceText, buildHealerPrompt } from '../cliproxy-heal-ai.mjs';
import { automatedAuthAllowed, directOAuthWriterAllowed } from '../auto-auth-policy.mjs';

const NOW = Date.parse('2026-08-20T12:00:00Z');
const FUTURE = '2026-08-20T18:00:00Z';
const PAST = '2026-08-20T06:00:00Z';

function spyAsk(adviceById = {}) {
  const calls = [];
  async function ask(facts) {
    calls.push(facts);
    if (typeof adviceById === 'function') return adviceById(facts);
    if (Object.prototype.hasOwnProperty.call(adviceById, facts.id)) return adviceById[facts.id];
    return { inRotation: facts.hard.inRotation, action: facts.hard.action, reason: 'echo-hard' };
  }
  ask.calls = calls;
  return ask;
}

const pool = [
  {
    id: 'cooled-new-quota',
    provider: 'claude',
    inRotation: false,
    disabled: false,
    cooling: true,
    remainingQuota: 12,
    newQuotaObserved: true,
    quotaExceeded: false,
    hadQuotaSignal: true,
    certainQuotaExhausted: false,
    rescheduleAt: FUTURE,
  },
  {
    id: 'remaining-quota',
    provider: 'claude',
    inRotation: true,
    disabled: false,
    cooling: false,
    remainingQuota: 40,
    paidSeat: true,
    quotaExceeded: false,
  },
  {
    id: 'uncertain-exhaust',
    provider: 'xai',
    inRotation: false,
    disabled: true,
    cooling: true,
    lastExhaustReason: 'stream disconnected',
    lastExhaustBody: 'xai stream error: stream disconnected before response.completed',
    certainQuotaExhausted: false,
    rescheduleAt: null,
    tokenStale: false,
  },
  {
    id: 'certain-future',
    provider: 'claude',
    inRotation: true,
    disabled: false,
    cooling: true,
    quotaExceeded: true,
    quotaReason: 'credential_quota',
    lastExhaustReason: 'credential_quota',
    lastExhaustBody: 'quota exhausted',
    certainQuotaExhausted: true,
    rescheduleAt: FUTURE,
  },
  {
    id: 'expired-stamp',
    provider: 'codex',
    inRotation: false,
    disabled: false,
    cooling: true,
    quotaExceeded: true,
    quotaReason: 'quota',
    lastExhaustBody: 'The usage limit has been reached',
    certainQuotaExhausted: true,
    rescheduleAt: PAST,
  },
  {
    id: 'codex-quota-flag',
    provider: 'codex',
    inRotation: false,
    cooling: true,
    quotaExceeded: true,
    quotaReason: 'quota',
    lastExhaustBody: 'The usage limit has been reached',
    rescheduleAt: FUTURE,
  },
  {
    id: 'stream-cool',
    provider: 'xai',
    inRotation: false,
    cooling: true,
    quotaExceeded: false,
    hadQuotaSignal: false,
    lastExhaustBody: 'stream disconnected',
    rescheduleAt: FUTURE,
  },
];

assert.equal(directOAuthWriterAllowed('cliproxy'), false);
assert.equal(automatedAuthAllowed({ cliproxyHubHeal: true }), false);
process.env.CLIPROXY_HUB_HEAL = '1';
assert.equal(automatedAuthAllowed({ cliproxyHubHeal: true }), true);
assert.equal(automatedAuthAllowed({}), false);
assert.equal(automatedAuthAllowed({ automatedCredentialMutation: true }), false);

const ask = spyAsk({
  'cooled-new-quota': { inRotation: false, action: ACTIONS.LEAVE, reason: 'model wants out' },
  'remaining-quota': { inRotation: true, action: ACTIONS.KEEP_IN, reason: 'agree leftover' },
  'uncertain-exhaust': { inRotation: false, action: ACTIONS.LEAVE, reason: 'model parks uncertain' },
  'certain-future': { inRotation: false, action: ACTIONS.KEEP_OUT, reason: 'agree stamp' },
  'expired-stamp': { inRotation: true, action: ACTIONS.ENTER, reason: 'agree elapsed' },
});

const result = await healPool(pool, { now: NOW, ask });
assert.equal(ask.calls.length, pool.length, 'AI advisor invoked once per seat');

const byId = Object.fromEntries(result.decisions.map((d) => [d.id, d]));

assert.equal(byId['cooled-new-quota'].inRotation, true, 'new quota re-enters even while cooling');
assert.equal(byId['cooled-new-quota'].ai.applied, false, 'advisor cannot park leftover quota');
assert.equal(byId['cooled-new-quota'].ai.invoked, true);

assert.equal(byId['remaining-quota'].inRotation, true, 'leftover paid quota stays serving');
assert.equal(byId['remaining-quota'].ai.applied, true);

assert.equal(byId['uncertain-exhaust'].inRotation, true, 'uncertain exhaust is healed, not parked');
assert.equal(byId['uncertain-exhaust'].ai.applied, false, 'advisor cannot park without certain exhaust+stamp');

assert.equal(byId['certain-future'].inRotation, false, 'certain exhaust + future stamp sits out');
assert.equal(byId['certain-future'].rescheduleAt, new Date(FUTURE).toISOString());
assert.equal(byId['certain-future'].ai.applied, true);

assert.equal(byId['expired-stamp'].inRotation, true, 'elapsed stamp re-enters');
assert.equal(byId['expired-stamp'].ai.applied, true);

assert.equal(byId['codex-quota-flag'].inRotation, false, 'quota.exceeded with future stamp sits out');
assert.equal(byId['stream-cool'].inRotation, true, 'stream-error cooling is healed, not treated as leftover quota');

assert.ok(Object.values(ACTIONS).includes(byId['cooled-new-quota'].action));
assert.ok(Object.values(ACTIONS).includes(byId['certain-future'].action));

const prompt = buildHealerPrompt({ remainingQuota: 3, hard: { inRotation: true } });
assert.match(prompt, /No hysteresis/);
assert.equal(parseAdviceText('```json\n{"inRotation":true,"action":"enter_rotation"}\n```').inRotation, true);

const authDir = mkdtempSync(join(tmpdir(), 'cliproxy-heal-'));
const statePath = join(authDir, '..', `heal-state-${Date.now()}.json`);

function writeSeat(stem, auth, cds) {
  writeFileSync(join(authDir, `${stem}.json`), JSON.stringify(auth, null, 2));
  if (cds) writeFileSync(join(authDir, `${stem}.cds`), JSON.stringify(cds, null, 2));
}

writeSeat(
  'cooled-new-quota',
  { type: 'claude', disabled: false, expired: '2026-08-21T00:00:00Z' },
  {
    version: 1,
    provider: 'claude',
    auth_id: 'cooled-new-quota',
    records: [
      {
        status: 'cooling',
        reason: 'credential_quota',
        next_retry_after: FUTURE,
        quota: { exceeded: false, remaining: 12, reason: 'credential_quota', next_recover_at: FUTURE },
        last_error: { message: 'quota window reset; remaining tokens available' },
      },
    ],
  },
);
writeSeat('remaining-quota', { type: 'claude', disabled: false, expired: '2026-08-21T00:00:00Z' }, null);
writeSeat(
  'uncertain-exhaust',
  { type: 'xai', disabled: true, disabled_reason: 'stream error', expired: '2026-08-21T00:00:00Z' },
  {
    version: 1,
    provider: 'xai',
    records: [
      {
        status: 'cooling',
        reason: 'stream disconnected',
        next_retry_after: FUTURE,
        quota: { exceeded: false, next_recover_at: '0001-01-01T00:00:00Z' },
        last_error: { message: 'xai stream error: stream disconnected before response.completed', http_status: 408 },
      },
    ],
  },
);
writeSeat(
  'certain-future',
  { type: 'claude', disabled: false, expired: '2026-08-21T00:00:00Z' },
  {
    version: 1,
    provider: 'claude',
    records: [
      {
        status: 'cooling',
        reason: 'credential_quota',
        next_retry_after: FUTURE,
        quota: {
          exceeded: true,
          reason: 'credential_quota',
          next_recover_at: FUTURE,
        },
        last_error: { message: '{"error":{"type":"rate_limit_error","message":"quota exhausted"}}' },
      },
    ],
  },
);
writeSeat(
  'expired-stamp',
  { type: 'codex', disabled: false, expired: '2026-08-21T00:00:00Z' },
  {
    version: 1,
    provider: 'codex',
    records: [
      {
        status: 'cooling',
        reason: 'quota',
        next_retry_after: PAST,
        quota: { exceeded: true, reason: 'quota', next_recover_at: PAST },
        last_error: {
          message:
            '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":1787190000}}',
        },
      },
    ],
  },
);

writeSeat(
  'claude-user@example.com',
  { type: 'claude', email: 'user@example.com', disabled: false, expired: '2026-08-21T00:00:00Z' },
  null,
);
writeFileSync(
  join(authDir, 'claude-user_example.com.cds'),
  JSON.stringify({
    version: 1,
    provider: 'claude',
    auth_id: 'user@example.com',
    records: [
      {
        status: 'cooling',
        reason: 'credential_quota',
        auth_id: 'user@example.com',
        next_retry_after: FUTURE,
        quota: { exceeded: true, reason: 'credential_quota', next_recover_at: FUTURE },
        last_error: { message: 'quota exhausted' },
      },
    ],
  }),
);
writeFileSync(
  join(authDir, 'openai-compatible-kimi.cds'),
  JSON.stringify({
    version: 1,
    provider: 'openai-compatible-kimi',
    auth_id: 'kimi-key',
    records: [
      {
        status: 'cooling',
        reason: 'quota',
        next_retry_after: FUTURE,
        quota: { exceeded: true, reason: 'quota', next_recover_at: FUTURE },
        last_error: { message: 'quota exhausted' },
      },
    ],
  }),
);

const snap = snapshotFromAuthDir(authDir, { now: NOW });
assert.equal(snap.seats.length, 7);
const emailMatched = snap.seats.find((s) => s.id === 'claude-user@example.com');
assert.equal(emailMatched.cooling, true, 'json email maps to underscore cds via auth_id');
assert.equal(emailMatched.certainQuotaExhausted, true);
assert.ok(emailMatched.cdsFile.endsWith('claude-user_example.com.cds'));
const kimi = snap.seats.find((s) => s.id === 'openai-compatible-kimi');
assert.equal(kimi.certainQuotaExhausted, true);
assert.equal(kimi.cooling, true);
const snapIds = snap.seats.map((s) => s.id).sort();
assert.deepEqual(snapIds, [
  'certain-future',
  'claude-user@example.com',
  'cooled-new-quota',
  'expired-stamp',
  'openai-compatible-kimi',
  'remaining-quota',
  'uncertain-exhaust',
]);

const reauthCalls = [];
const tickAsk = spyAsk((facts) => ({
  inRotation: facts.hard.inRotation,
  action: facts.hard.action,
  reason: 'tick-echo',
}));

const tick = await runHealTick({
  authDir,
  statePath,
  now: NOW,
  ask: tickAsk,
  dryRun: false,
  log: () => {},
  reauth: (d) => reauthCalls.push(d.id),
});

assert.equal(tick.denied, false);
assert.equal(tickAsk.calls.length, 7, 'tick invokes AI on every seat');
const tickBy = Object.fromEntries(tick.decisions.map((d) => [d.id, d]));
assert.equal(tickBy['cooled-new-quota'].inRotation, true);
assert.equal(tickBy['remaining-quota'].inRotation, true);
assert.equal(tickBy['uncertain-exhaust'].inRotation, true);
assert.equal(tickBy['certain-future'].inRotation, false);
assert.equal(tickBy['expired-stamp'].inRotation, true);
assert.equal(tickBy['claude-user@example.com'].inRotation, false);
assert.equal(tickBy['openai-compatible-kimi'].inRotation, false);

assert.equal(JSON.parse(readFileSync(join(authDir, 'uncertain-exhaust.json'), 'utf8')).disabled, false);
assert.equal(existsSync(join(authDir, 'cooled-new-quota.cds')), false);
assert.equal(existsSync(join(authDir, 'uncertain-exhaust.cds')), false);
assert.equal(existsSync(join(authDir, 'certain-future.cds')), true);
assert.equal(existsSync(join(authDir, 'expired-stamp.cds')), false);
assert.equal(existsSync(join(authDir, 'claude-user_example.com.cds')), true);
assert.equal(existsSync(join(authDir, 'openai-compatible-kimi.cds')), true);

const state = JSON.parse(readFileSync(statePath, 'utf8'));
assert.equal(state.seats['certain-future'].rescheduleAt, new Date(FUTURE).toISOString());
assert.equal(
  state.lastTick.every((row) => row.aiInvoked === true),
  true,
);

delete process.env.CLIPROXY_HUB_HEAL;
const denied = await runHealTick({
  authDir,
  statePath,
  now: NOW,
  ask: spyAsk(),
  dryRun: false,
  log: () => {},
});
assert.equal(denied.denied, true);

const enableApplied = applyDecision(
  {
    inRotation: true,
    disabled: true,
    cooling: false,
    authFile: join(authDir, 'remaining-quota.json'),
  },
  { dryRun: true },
);
assert.deepEqual(enableApplied, ['enable_auth']);

console.log('cliproxy-heal-policy.test.mjs: ok');
