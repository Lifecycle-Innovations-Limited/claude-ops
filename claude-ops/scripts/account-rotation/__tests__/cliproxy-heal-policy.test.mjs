#!/usr/bin/env node
/**
 * Gating tests for cliproxy heal / re-entry. Drive healPool + runHealTick
 * from representative start states. Do not re-implement the policy here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, healPool } from '../cliproxy-heal-policy.mjs';
import { opaqueSeatId, snapshotFromAuthDir } from '../cliproxy-pool-snapshot.mjs';
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

// Save/restore so this suite's env mutations never leak into a process that
// runs multiple test files back to back.
const savedHubHeal = process.env.CLIPROXY_HUB_HEAL;
const savedAccountOptin = process.env.CLIPROXY_HEAL_ACCOUNT_OPTIN;
delete process.env.CLIPROXY_HUB_HEAL;

assert.equal(directOAuthWriterAllowed('cliproxy'), false);
assert.equal(automatedAuthAllowed({ cliproxyHubHeal: true }), false);
process.env.CLIPROXY_HUB_HEAL = '1';
assert.equal(automatedAuthAllowed({ cliproxyHubHeal: true }), true);
assert.equal(automatedAuthAllowed({}), false);
assert.equal(automatedAuthAllowed({ automatedCredentialMutation: true }), false);
// runHealTick derives the second gate factor from this env var, not from
// account.cliproxyHubHeal directly — see cliproxy-heal-tick.mjs.
process.env.CLIPROXY_HEAL_ACCOUNT_OPTIN = '1';

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
// Seat ids leaving snapshotFromAuthDir must be opaque (sha256-derived), never
// the raw filename/email — the raw value only survives on `rawId`, used
// internally for auth-file mutation and reauth targeting.
for (const seat of snap.seats) {
  assert.equal(seat.id, opaqueSeatId(seat.rawId), 'seat.id must be the opaque hash of rawId');
  assert.notEqual(seat.id, seat.rawId, 'seat.id must not leak the raw account identifier');
}
const emailMatched = snap.seats.find((s) => s.rawId === 'claude-user@example.com');
assert.equal(emailMatched.cooling, true, 'json email maps to underscore cds via auth_id');
assert.equal(emailMatched.certainQuotaExhausted, true);
assert.ok(emailMatched.cdsFile.endsWith('claude-user_example.com.cds'));
const kimi = snap.seats.find((s) => s.rawId === 'openai-compatible-kimi');
assert.equal(kimi.certainQuotaExhausted, true);
assert.equal(kimi.cooling, true);
const snapRawIds = snap.seats.map((s) => s.rawId).sort();
assert.deepEqual(snapRawIds, [
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
// decisions/actions are the externally-visible surface (persisted state,
// --json output) and must carry only the opaque id; rawId is present on
// decisions solely for internal auth-file/reauth targeting.
const tickBy = Object.fromEntries(tick.decisions.map((d) => [d.rawId, d]));
for (const decision of tick.decisions) {
  assert.equal(decision.id, opaqueSeatId(decision.rawId), 'decision.id must be the opaque hash of rawId');
}
for (const action of tick.actions) {
  assert.ok(
    tick.decisions.some((d) => d.id === action.id),
    'action.id must be an opaque id, matching a decision.id',
  );
}
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
assert.equal(state.seats[opaqueSeatId('certain-future')].rescheduleAt, new Date(FUTURE).toISOString());
assert.equal(
  state.lastTick.every((row) => row.aiInvoked === true),
  true,
);
// Persisted state and lastTick must never carry a raw account id.
for (const key of Object.keys(state.seats)) {
  assert.doesNotMatch(key, /example\.com|kimi/, 'persisted seat key must be opaque, not the raw account id');
}

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
assert.deepEqual(enableApplied.applied, ['enable_auth']);

const staleDir = mkdtempSync(join(tmpdir(), 'cliproxy-stale-'));
const staleState = join(staleDir, 'state.json');
writeFileSync(
  join(staleDir, 'xai-stale@example.com.json'),
  JSON.stringify({
    type: 'xai',
    email: 'stale@example.com',
    disabled: false,
    disabled_reason: 'expired credentials (auth_kind=bearer, reason=no auth context)',
    expired: '2026-08-21T00:00:00Z',
  }),
);
process.env.CLIPROXY_HUB_HEAL = '1';
process.env.CLIPROXY_HEAL_ACCOUNT_OPTIN = '1';
delete process.env.CLIPROXY_REAUTH_CMD;
const noWriter = await runHealTick({
  authDir: staleDir,
  statePath: staleState,
  now: NOW,
  ask: spyAsk(),
  dryRun: false,
  log: () => {},
});
const staleOpaque = opaqueSeatId('xai-stale@example.com');
const noWriterRow = noWriter.actions.find((a) => a.id === staleOpaque);
assert.ok(noWriterRow, 'stale seat present');
assert.equal(noWriterRow.inRotation, true);
assert.equal(noWriterRow.applied.includes('reauth'), false, 'must not claim reauth without a writer');
assert.equal(noWriterRow.applied.includes('blocked'), true);
assert.equal(noWriterRow.blocked?.reason, 'no_reauth_writer');
assert.equal(JSON.parse(readFileSync(staleState, 'utf8')).seats[staleOpaque].blocked.reason, 'no_reauth_writer');

const writerDir = mkdtempSync(join(tmpdir(), 'cliproxy-stale-w-'));
const writerState = join(writerDir, 'state.json');
const writerBin = join(writerDir, 'writer.sh');
const writerMarker = join(writerDir, 'ran');
writeFileSync(
  join(writerDir, 'xai-stale@example.com.json'),
  JSON.stringify({
    type: 'xai',
    email: 'stale@example.com',
    disabled: false,
    disabled_reason: 'invalid_grant expired credentials',
    expired: '2026-08-21T00:00:00Z',
  }),
);
writeFileSync(writerBin, `#!/bin/sh\necho "$*" > ${JSON.stringify(writerMarker)}\nexit 0\n`, { mode: 0o700 });
process.env.CLIPROXY_REAUTH_CMD = writerBin;
const withWriter = await runHealTick({
  authDir: writerDir,
  statePath: writerState,
  now: NOW,
  ask: spyAsk(),
  dryRun: false,
  log: () => {},
});
const withWriterRow = withWriter.actions.find((a) => a.id === staleOpaque);
assert.equal(withWriterRow.applied.includes('reauth'), true);
assert.equal(withWriterRow.applied.includes('blocked'), false);
assert.equal(existsSync(writerMarker), true, 'configured writer must be invoked');
assert.match(readFileSync(writerMarker, 'utf8'), /xai/);
delete process.env.CLIPROXY_REAUTH_CMD;

const applyNoWriter = applyDecision({ inRotation: true, tokenStale: true, disabled: false }, { dryRun: false });
assert.equal(applyNoWriter.applied.includes('reauth'), false);
assert.equal(applyNoWriter.applied.includes('blocked'), true);
assert.equal(applyNoWriter.blocked?.reason, 'no_reauth_writer');

// Regression: CRITICAL clear_cooldown data-integrity bug. A healthy,
// non-cooling, in-rotation seat can still carry a leftover .cds file (e.g.
// from a previous unrelated cooldown that already resolved on its own via
// CLIProxy). The old guard was `if (decision.inRotation)` alone, which wiped
// that .cds unconditionally — destroying CLIProxy's own quota/reset-at
// evidence for a seat that was never actually being healed. The correct
// guard only fires when the seat is presently cooling or its reschedule
// stamp just elapsed.
{
  const cdsDir = mkdtempSync(join(tmpdir(), 'cliproxy-clear-cooldown-'));
  const cdsFile = join(cdsDir, 'healthy-seat.cds');
  writeFileSync(cdsFile, JSON.stringify({ version: 1, provider: 'claude', records: [] }));
  const healthyDecision = {
    id: 'healthy-seat',
    inRotation: true,
    disabled: false,
    cooling: false,
    reason: 'remaining_or_reset_quota',
    cdsFile,
  };
  const healthyApplied = applyDecision(healthyDecision, { dryRun: false });
  assert.equal(
    healthyApplied.applied.includes('clear_cooldown'),
    false,
    'must not clear the sidecar for a seat that is not cooling and has no elapsed reschedule',
  );
  assert.equal(existsSync(cdsFile), true, '.cds for a healthy non-cooling seat must survive untouched');
  assert.equal(existsSync(`${cdsFile}.healed`), false);

  // Sanity check the positive case still works: an actually-cooling seat (or
  // one whose reschedule stamp elapsed) does get its sidecar renamed, never
  // destructively deleted.
  const coolingFile = join(cdsDir, 'cooling-seat.cds');
  writeFileSync(coolingFile, JSON.stringify({ version: 1, provider: 'claude', records: [] }));
  const coolingDecision = {
    id: 'cooling-seat',
    inRotation: true,
    disabled: false,
    cooling: true,
    reason: 'reschedule_elapsed',
    cdsFile: coolingFile,
  };
  const coolingApplied = applyDecision(coolingDecision, { dryRun: false });
  assert.equal(coolingApplied.applied.includes('clear_cooldown'), true);
  assert.equal(existsSync(coolingFile), false, 'renamed away, not present under the original name');
  assert.equal(existsSync(`${coolingFile}.healed`), true, 'renamed, not unlinked, so it stays recoverable');
}

// Regression: CRITICAL rule-1/rule-2 cancellation bug. hasRemainingOrResetQuota
// (rule 1) must not short-circuit rule 2 for a seat that is BOTH
// quotaExceeded:false (leftover-quota shaped) AND certainQuotaExhausted:true
// with a parseable future reschedule stamp — that combination means the
// exhaustion is certain and the seat must sit out until the stamp elapses,
// not re-enter rotation on the leftover-quota fast path.
{
  const cancelPool = [
    {
      id: 'certain-exhaust-with-leftover-signal',
      provider: 'claude',
      inRotation: true,
      disabled: false,
      cooling: true,
      quotaExceeded: false,
      hadQuotaSignal: true,
      certainQuotaExhausted: true,
      rescheduleAt: FUTURE,
    },
  ];
  const cancelResult = await healPool(cancelPool, { now: NOW, ask: spyAsk() });
  const cancelDecision = cancelResult.decisions.find((d) => d.id === 'certain-exhaust-with-leftover-signal');
  assert.equal(
    cancelDecision.inRotation,
    false,
    'certain exhaust + future stamp must win over a coincidental quotaExceeded:false/hadQuotaSignal:true reading',
  );
}

console.log('cliproxy-heal-policy.test.mjs: ok');

process.env.CLIPROXY_HUB_HEAL = savedHubHeal;
process.env.CLIPROXY_HEAL_ACCOUNT_OPTIN = savedAccountOptin;
if (savedHubHeal === undefined) delete process.env.CLIPROXY_HUB_HEAL;
if (savedAccountOptin === undefined) delete process.env.CLIPROXY_HEAL_ACCOUNT_OPTIN;
