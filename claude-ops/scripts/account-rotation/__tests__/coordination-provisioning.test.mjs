#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../provision-coordination.mjs', import.meta.url).pathname;
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}
function replaceFixtureContents(path, bytes) {
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'coordination-provision-'));
  chmodSync(root, 0o700);
  const inventory = join(root, 'inventory.json');
  const consumerInventorySource = join(root, 'reviewed-consumers.json');
  writeFileSync(
    inventory,
    JSON.stringify({
      accounts: Array.from({ length: 9 }, (_, index) => ({
        email: `owner-${index}@example.com`,
        ...(legacy && index === 0 ? {} : { orgUuid: `org-${index}`, orgName: `Owner Org ${index}` }),
      })),
    }),
    { mode: 0o600 },
  );
  const trustRoot = join(root, 'trust');
  const mutable = join(root, 'mutable');
  const installHome = join(root, 'install-home');
  mkdirSync(trustRoot, { mode: 0o700 });
  mkdirSync(installHome, { mode: 0o700 });
  const paths = {
    manifest: join(trustRoot, 'manifest.json'),
    trust: join(trustRoot, 'approval.key'),
    config: join(trustRoot, 'coordination.json'),
    active: join(mutable, 'active'),
    staging: join(mutable, 'staging'),
    usage: join(mutable, 'usage'),
    rollback: join(mutable, 'rollback'),
    quarantine: join(mutable, 'quarantine'),
    lock: join(root, 'locks', 'operation.lock'),
    'provision-lock': join(root, 'locks', 'provision.lock'),
    'linux-env': join(root, 'generated', 'linux.env'),
    'macos-env': join(root, 'generated', 'macos.env'),
    'linux-unit': join(installHome, '.config', 'systemd', 'user', 'claude-account-rotator.service'),
    'macos-plist': join(root, 'generated', 'rotator.plist'),
    'runtime-inventory': join(trustRoot, 'account-inventory.json'),
    'authoritative-consumer-inventory': join(trustRoot, 'consumer-inventory.json'),
    'linux-token-feed-unit': join(root, 'generated', 'crs-token-feed.service'),
    'linux-refresh-unit': join(root, 'generated', 'claude-token-refresh.service'),
  };
  const manifestSource = join(trustRoot, 'reviewed-manifest.json');
  const entries = [
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `claude-${index}`,
      authFilename: `claude-${index}.json`,
      provider: 'claude',
      email: `owner-${index}@example.com`,
      organizationUuid: `org-${index}`,
      organizationName: `Owner Org ${index}`,
      accountOwner: `owner-${index}`,
    })),
    { id: 'antigravity-0', authFilename: 'antigravity-0.json', provider: 'antigravity' },
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `codex-${index}`,
      authFilename: `codex-${index}.json`,
      provider: 'codex',
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `xai-${index}`,
      authFilename: `xai-${index}.json`,
      provider: 'xai',
    })),
  ];
  writeFileSync(manifestSource, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    consumerInventorySource,
    `${JSON.stringify({
      version: 1,
      consumers: Array.from({ length: 9 }, (_, index) => ({
        id: `consumer-${index}`,
        type: 'cliproxyapi',
        path: join(root, 'consumers', `consumer-${index}`),
        credentialId: `claude-${index}`,
        destination: `claude-${index}.json`,
      })),
    })}\n`,
    { mode: 0o600 },
  );
  const args = [
    'plan',
    '--inventory',
    inventory,
    '--manifest-source',
    manifestSource,
    '--consumer-inventory-source',
    consumerInventorySource,
    '--operator',
    'release-operator',
    '--environment',
    'test',
    '--runtime-home',
    root,
    ...Object.entries(paths).flatMap(([k, v]) => [`--${k}`, v]),
  ];
  return { root, inventory, consumerInventorySource, manifestSource, paths, args, installHome };
}

const legacy = fixture(true);
const refused = run(legacy.args);
assert.notEqual(refused.status, 0);
assert.match(refused.stderr, /ACCOUNT_IDENTITY_REQUIRED/);
assert.equal(existsSync(legacy.paths.config), false, 'legacy refusal happens before writes');

for (const mutate of [
  (x) => (x.args[x.args.indexOf('--trust') + 1] = x.paths.config),
  (x) => (x.args[x.args.indexOf('--trust') + 1] = join(x.paths.active, 'approval.key')),
  (x) => (x.args[x.args.indexOf('--linux-env') + 1] = x.paths['macos-env']),
]) {
  const unsafe = fixture();
  mutate(unsafe);
  const result = run(unsafe.args);
  assert.notEqual(result.status, 0, 'aliased/overlapping topology refused');
  assert.equal(existsSync(unsafe.paths.config), false);
}

const dangerous = fixture();
writeFileSync(
  dangerous.inventory,
  '{"accounts":[{"email":"owner@example.com","orgUuid":"org-1","orgName":"Org","__proto__":{}}]}',
);
assert.notEqual(run(dangerous.args).status, 0, 'dangerous source JSON key refused');

const f = fixture();
const planned = run(f.args);
assert.equal(planned.status, 0, planned.stderr);
let plan = JSON.parse(planned.stdout);
assert.doesNotMatch(
  planned.stdout,
  /approvalKey|access[_-]?token|refresh[_-]?token/i,
  'plan contains no key/token material',
);
let planPath = join(f.root, 'plan.json');
writeFileSync(planPath, planned.stdout, { mode: 0o600 });
let applied = run(['apply', '--plan', planPath, '--expected-digest', plan.digest]);
assert.equal(applied.status, 0, applied.stderr);
assert.match(
  run(['apply', '--plan', planPath, '--expected-digest', plan.digest]).stderr,
  /BOOTSTRAP_TRUST_REVIEW_REQUIRED/,
  'an absent-trust plan is one-shot',
);
const presentPlanResult = run(f.args);
assert.equal(presentPlanResult.status, 0, presentPlanResult.stderr);
plan = JSON.parse(presentPlanResult.stdout);
planPath = join(f.root, 'present-plan.json');
writeFileSync(planPath, presentPlanResult.stdout, { mode: 0o600 });
const presentApply = run(['apply', '--plan', planPath, '--expected-digest', plan.digest]);
assert.equal(presentApply.status, 0, `reviewed present-trust rerun: ${presentApply.stderr}`);
assert.notEqual(run(['apply', '--plan', planPath, '--expected-digest', '0'.repeat(64)]).status, 0, 'digest mismatch');
assert.equal(
  run(['preflight', '--plan', planPath, '--expected-digest', plan.digest]).status,
  0,
  'precise artifact preflight',
);
const linuxEnv = readFileSync(f.paths['linux-env'], 'utf8');
const macEnv = readFileSync(f.paths['macos-env'], 'utf8');
assert.equal(linuxEnv, macEnv);
assert.match(linuxEnv, new RegExp(f.paths.config));
for (const file of [f.paths['linux-unit'], f.paths['macos-plist']])
  assert.doesNotMatch(readFileSync(file, 'utf8'), /\$\{HOME\}|__HOME__/);
assert.equal(f.paths.trust.startsWith(join(f.root, 'mutable')), false, 'trust outside mutable roots');
assert.deepEqual(readFileSync(f.paths['runtime-inventory']), readFileSync(f.inventory));

const selfStart =
  platform() === 'darwin'
    ? String(
        Date.parse(
          spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' },
          })
            .stdout.trim()
            .replace(/\s+/g, ' '),
        ),
      )
    : (() => {
        const selfStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
        return selfStat.slice(selfStat.lastIndexOf(') ') + 2).split(' ')[19];
      })();
const malformedLiveLock = fixture();
mkdirSync(join(malformedLiveLock.root, 'locks'), { mode: 0o700 });
writeFileSync(
  malformedLiveLock.paths['provision-lock'],
  `${JSON.stringify({ version: 1, planDigest: 'a'.repeat(64), pid: process.pid, start: '', nonce: 'a'.repeat(32) })}\n`,
  { mode: 0o600 },
);
assert.match(run(malformedLiveLock.args).stderr, /INVALID_PROVISION_LOCK/);
replaceFixtureContents(
  malformedLiveLock.paths['provision-lock'],
  `${JSON.stringify({
    version: 1,
    planDigest: 'a'.repeat(64),
    pid: process.pid,
    start: Number(selfStart),
    nonce: 'a'.repeat(32),
  })}\n`,
);
assert.match(run(malformedLiveLock.args).stderr, /INVALID_PROVISION_LOCK/);
replaceFixtureContents(
  malformedLiveLock.paths['provision-lock'],
  `${JSON.stringify({
    version: 1,
    planDigest: 'a'.repeat(64),
    pid: process.pid,
    start: `0${selfStart}`,
    nonce: 'a'.repeat(32),
  })}\n`,
);
assert.match(run(malformedLiveLock.args).stderr, /INVALID_PROVISION_LOCK/);
writeFileSync(
  f.paths['provision-lock'],
  `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: process.pid, start: selfStart, nonce: 'a'.repeat(32) })}\n`,
  { mode: 0o600 },
);
assert.match(
  run(['apply', '--plan', planPath, '--expected-digest', plan.digest]).stderr,
  /PROVISION_LOCK_REVIEW_REQUIRED/,
  'concurrent provisioning writer refused',
);
writeFileSync(
  f.paths['provision-lock'],
  `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: 99999999, start: '1', nonce: 'b'.repeat(32) })}\n`,
  { mode: 0o600 },
);
const staleLockPlanResult = run(f.args);
assert.equal(staleLockPlanResult.status, 0, staleLockPlanResult.stderr);
const staleLockPlan = JSON.parse(staleLockPlanResult.stdout);
const staleLockPlanPath = join(f.root, 'stale-lock-plan.json');
writeFileSync(staleLockPlanPath, staleLockPlanResult.stdout, { mode: 0o600 });
const staleLockRecovery = run(['apply', '--plan', staleLockPlanPath, '--expected-digest', staleLockPlan.digest]);
assert.equal(
  staleLockRecovery.status,
  0,
  `authenticated plan-bound stale provisioning lock recovered: ${staleLockRecovery.stderr}`,
);

// The installer consumes only paths emitted by the authenticated preflight and
// installs the exact reviewed artifact; it never reparses mutable plan fields.
const fakeBin = join(f.root, 'fake-bin');
mkdirSync(fakeBin, { mode: 0o700 });
const fakeSystemctl = join(fakeBin, 'systemctl');
writeFileSync(fakeSystemctl, '#!/usr/bin/env bash\n[[ " $* " == *" is-active "* ]] && echo active\nexit 0\n', {
  mode: 0o700,
});
const installer = new URL('../../install-account-rotator-linux.sh', import.meta.url).pathname;
const installed = spawnSync('bash', [installer], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: f.installHome,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CLAUDE_AUTH_COORDINATION_PLAN: planPath,
    CLAUDE_AUTH_COORDINATION_PLAN_DIGEST: plan.digest,
  },
});
assert.equal(installed.status, 0, installed.stderr);
assert.deepEqual(
  readFileSync(join(f.installHome, '.config/systemd/user/claude-account-rotator.service')),
  readFileSync(f.paths['linux-unit']),
  'installer publishes exact preflight-reviewed unit',
);

const inventorySwap = run(['preflight', '--plan', planPath, '--expected-digest', plan.digest]);
assert.equal(inventorySwap.status, 0);
writeFileSync(f.paths['runtime-inventory'], '{}', { mode: 0o600 });
assert.match(
  run(['preflight', '--plan', planPath, '--expected-digest', plan.digest]).stderr,
  /RUNTIME_INVENTORY_MISMATCH/,
);
writeFileSync(f.paths['runtime-inventory'], readFileSync(f.inventory), { mode: 0o600 });

const rollback = fixture();
const rp = run(rollback.args);
const rplan = JSON.parse(rp.stdout);
const rpath = join(rollback.root, 'plan.json');
writeFileSync(rpath, rp.stdout);
const failed = run(['apply', '--plan', rpath, '--expected-digest', rplan.digest], {
  CLAUDE_COORDINATION_TESTING: '1',
  CLAUDE_COORDINATION_TEST_FAIL_AFTER: '3',
});
assert.notEqual(failed.status, 0);
assert.match(
  run(['apply', '--plan', rpath, '--expected-digest', rplan.digest]).stderr,
  /BOOTSTRAP_ATTEMPT_REVIEW_REQUIRED/,
  'any failed bootstrap attempt permanently consumes the reviewed absence',
);
for (const file of [rollback.paths.trust, rollback.paths.config, rollback.paths['linux-env']])
  assert.equal(existsSync(file), false);
assert.equal(existsSync(rollback.paths.manifest), false);

// An interrupted absent-trust bootstrap is one-shot. Recovery requires a newly
// generated and reviewed present-trust plan that pins both trust and progress.
const crashResume = fixture();
const crashPlanResult = run(crashResume.args);
const crashPlan = JSON.parse(crashPlanResult.stdout);
const crashPlanPath = join(crashResume.root, 'plan.json');
writeFileSync(crashPlanPath, crashPlanResult.stdout, { mode: 0o600 });
const killed = run(['apply', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest], {
  CLAUDE_COORDINATION_TESTING: '1',
  CLAUDE_COORDINATION_TEST_SIGKILL_AFTER: '3',
});
assert.equal(killed.signal, 'SIGKILL');
assert.equal(existsSync(`${crashResume.paths.config}.provision-journal`), true);
assert.match(run(['apply', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest]).stderr, /BOOTSTRAP_/);
const crashRecoveryResult = run(crashResume.args);
assert.equal(crashRecoveryResult.status, 0, crashRecoveryResult.stderr);
const crashRecoveryPlan = JSON.parse(crashRecoveryResult.stdout);
const crashRecoveryPath = join(crashResume.root, 'present-recovery-plan.json');
writeFileSync(crashRecoveryPath, crashRecoveryResult.stdout, { mode: 0o600 });
const crashRecoveryApply = run(['apply', '--plan', crashRecoveryPath, '--expected-digest', crashRecoveryPlan.digest]);
assert.equal(crashRecoveryApply.status, 0, `new reviewed present-trust plan resumes: ${crashRecoveryApply.stderr}`);
assert.equal(existsSync(`${crashResume.paths.config}.provision-journal`), false);

const crashRollback = fixture();
const rollbackPlanResult = run(crashRollback.args);
const rollbackPlan = JSON.parse(rollbackPlanResult.stdout);
const rollbackPlanPath = join(crashRollback.root, 'plan.json');
writeFileSync(rollbackPlanPath, rollbackPlanResult.stdout, { mode: 0o600 });
assert.equal(
  run(['apply', '--plan', rollbackPlanPath, '--expected-digest', rollbackPlan.digest], {
    CLAUDE_COORDINATION_TESTING: '1',
    CLAUDE_COORDINATION_TEST_SIGKILL_AFTER: '2',
  }).signal,
  'SIGKILL',
);
assert.match(
  run(['rollback', '--plan', rollbackPlanPath, '--expected-digest', rollbackPlan.digest]).stderr,
  /BOOTSTRAP_/,
);
const rollbackRecoveryResult = run(crashRollback.args);
assert.equal(rollbackRecoveryResult.status, 0, rollbackRecoveryResult.stderr);
const rollbackRecoveryPlan = JSON.parse(rollbackRecoveryResult.stdout);
const rollbackRecoveryPath = join(crashRollback.root, 'present-rollback-plan.json');
writeFileSync(rollbackRecoveryPath, rollbackRecoveryResult.stdout, { mode: 0o600 });
assert.equal(
  run(['rollback', '--plan', rollbackRecoveryPath, '--expected-digest', rollbackRecoveryPlan.digest]).status,
  0,
  'new reviewed present-trust plan rolls back exact pinned progress',
);
for (const file of [
  crashRollback.paths.manifest,
  crashRollback.paths.trust,
  crashRollback.paths.config,
  crashRollback.paths['linux-env'],
])
  assert.equal(existsSync(file), false);
assert.equal(existsSync(crashRollback.manifestSource), true, 'reviewed source is never a rollback target');

// Atomic no-replace publication never overwrites or rolls back a competing
// owner-created target that appears after the plan's absence snapshot.
const raced = fixture();
const racedPlanResult = run(raced.args);
const racedPlan = JSON.parse(racedPlanResult.stdout);
const racedPlanPath = join(raced.root, 'plan.json');
writeFileSync(racedPlanPath, racedPlanResult.stdout, { mode: 0o600 });
const racedApply = run(['apply', '--plan', racedPlanPath, '--expected-digest', racedPlan.digest], {
  CLAUDE_COORDINATION_TESTING: '1',
  CLAUDE_COORDINATION_TEST_RACE_TARGET: raced.paths.manifest,
});
assert.notEqual(racedApply.status, 0);
assert.equal(readFileSync(raced.paths.manifest, 'utf8'), 'competing-owner\n');

const sameRace = fixture();
const samePlanResult = run(sameRace.args);
const samePlan = JSON.parse(samePlanResult.stdout);
const samePlanPath = join(sameRace.root, 'plan.json');
writeFileSync(samePlanPath, samePlanResult.stdout, { mode: 0o600 });
const sameApply = run(['apply', '--plan', samePlanPath, '--expected-digest', samePlan.digest], {
  CLAUDE_COORDINATION_TESTING: '1',
  CLAUDE_COORDINATION_TEST_RACE_TARGET: sameRace.paths.manifest,
  CLAUDE_COORDINATION_TEST_RACE_SAME: '1',
  CLAUDE_COORDINATION_TEST_FAIL_AFTER: '1',
});
assert.notEqual(sameApply.status, 0);
assert.deepEqual(readFileSync(sameRace.paths.manifest), readFileSync(sameRace.manifestSource));

const postLinkRace = fixture();
const postLinkPlanResult = run(postLinkRace.args);
const postLinkPlan = JSON.parse(postLinkPlanResult.stdout);
const postLinkPlanPath = join(postLinkRace.root, 'plan.json');
writeFileSync(postLinkPlanPath, postLinkPlanResult.stdout, { mode: 0o600 });
const postLinkApply = run(['apply', '--plan', postLinkPlanPath, '--expected-digest', postLinkPlan.digest], {
  CLAUDE_COORDINATION_TESTING: '1',
  CLAUDE_COORDINATION_TEST_POST_LINK_REPLACE: postLinkRace.paths.manifest,
});
assert.notEqual(postLinkApply.status, 0);
assert.match(postLinkApply.stderr, /PROVISION_RECOVERY_UNCERTAIN/);
assert.deepEqual(readFileSync(postLinkRace.paths.manifest), readFileSync(postLinkRace.manifestSource));
const postLinkJournal = JSON.parse(readFileSync(`${postLinkRace.paths.config}.provision-journal`, 'utf8'));
assert.equal(existsSync(postLinkJournal.ownedTargets[0].proof), true, 'apply mismatch preserves proof');

// Rollback also refuses a same-byte foreign inode after publication and keeps
// the final path, proof, and journal as evidence.
const rollbackForeign = fixture();
const rollbackForeignPlanResult = run(rollbackForeign.args);
const rollbackForeignPlan = JSON.parse(rollbackForeignPlanResult.stdout);
const rollbackForeignPlanPath = join(rollbackForeign.root, 'plan.json');
writeFileSync(rollbackForeignPlanPath, rollbackForeignPlanResult.stdout, { mode: 0o600 });
assert.equal(
  run(['apply', '--plan', rollbackForeignPlanPath, '--expected-digest', rollbackForeignPlan.digest], {
    CLAUDE_COORDINATION_TESTING: '1',
    CLAUDE_COORDINATION_TEST_FAULT: 'SIGKILL:PROVISION_LINKED',
  }).signal,
  'SIGKILL',
);
const rollbackForeignJournalPath = `${rollbackForeign.paths.config}.provision-journal`;
const rollbackForeignJournal = JSON.parse(readFileSync(rollbackForeignJournalPath, 'utf8'));
unlinkSync(rollbackForeign.paths.manifest);
writeFileSync(rollbackForeign.paths.manifest, readFileSync(rollbackForeign.manifestSource), { mode: 0o600 });
const refusedRollback = run([
  'rollback',
  '--plan',
  rollbackForeignPlanPath,
  '--expected-digest',
  rollbackForeignPlan.digest,
]);
assert.notEqual(refusedRollback.status, 0);
assert.match(refusedRollback.stderr, /BOOTSTRAP_(ATTEMPT|JOURNAL)_REVIEW_REQUIRED/);
writeFileSync(rollbackForeign.paths.trust, Buffer.alloc(32, 9), { flag: 'wx', mode: 0o600 });
const foreignRecoveryResult = run(rollbackForeign.args);
assert.notEqual(foreignRecoveryResult.status, 0);
assert.match(foreignRecoveryResult.stderr, /PROVISION_RECOVERY_UNCERTAIN/);
assert.equal(existsSync(rollbackForeignJournalPath), true);
assert.equal(existsSync(rollbackForeignJournal.ownedTargets[0].proof), true, 'rollback mismatch preserves proof');
assert.deepEqual(readFileSync(rollbackForeign.paths.manifest), readFileSync(rollbackForeign.manifestSource));

for (const fault of ['SIGKILL:PROVISION_PRE_LINK', 'SIGKILL:PROVISION_LINKED', 'SIGKILL:PROVISION_LINK_FSYNCED']) {
  const crash = fixture();
  const crashPlanResult = run(crash.args);
  const crashPlan = JSON.parse(crashPlanResult.stdout);
  const crashPlanPath = join(crash.root, 'plan.json');
  writeFileSync(crashPlanPath, crashPlanResult.stdout, { mode: 0o600 });
  const result = run(['apply', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest], {
    CLAUDE_COORDINATION_TESTING: '1',
    CLAUDE_COORDINATION_TEST_FAULT: fault,
  });
  assert.equal(result.signal, 'SIGKILL', fault);
  assert.match(run(['rollback', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest]).stderr, /BOOTSTRAP_/);
  writeFileSync(crash.paths.trust, Buffer.alloc(32, 9), { flag: 'wx', mode: 0o600 });
  const recoveryResult = run(crash.args);
  assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
  const recoveryPlan = JSON.parse(recoveryResult.stdout);
  const recoveryPath = join(crash.root, 'present-recovery-plan.json');
  writeFileSync(recoveryPath, recoveryResult.stdout, { mode: 0o600 });
  assert.equal(
    run(['rollback', '--plan', recoveryPath, '--expected-digest', recoveryPlan.digest]).status,
    0,
    `${fault} rollback`,
  );
  assert.equal(existsSync(crash.paths.manifest), false);
}

// COMPLETE proof cleanup is sequential and crash-idempotent: a fresh apply
// authenticates finals whose proof was already removed and finishes cleanup.
const completeCleanup = fixture();
const completePlanResult = run(completeCleanup.args);
const completePlan = JSON.parse(completePlanResult.stdout);
const completePlanPath = join(completeCleanup.root, 'plan.json');
writeFileSync(completePlanPath, completePlanResult.stdout, { mode: 0o600 });
assert.equal(
  run(['apply', '--plan', completePlanPath, '--expected-digest', completePlan.digest], {
    CLAUDE_COORDINATION_TESTING: '1',
    CLAUDE_COORDINATION_TEST_SIGKILL_COMPLETE_PROOF_AFTER: '2',
  }).signal,
  'SIGKILL',
);
assert.equal(
  (() => {
    const recoveryResult = run(completeCleanup.args);
    assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
    const recoveryPlan = JSON.parse(recoveryResult.stdout);
    const recoveryPath = join(completeCleanup.root, 'present-complete-plan.json');
    writeFileSync(recoveryPath, recoveryResult.stdout, { mode: 0o600 });
    return run(['apply', '--plan', recoveryPath, '--expected-digest', recoveryPlan.digest]).status;
  })(),
  0,
  'fresh apply completes interrupted COMPLETE proof cleanup',
);
assert.equal(existsSync(`${completeCleanup.paths.config}.provision-journal`), false);

// Completion receipt publication recovers the exact deterministic preparation
// inode after every crash boundary; a forged receipt or preparation is refused.
for (const fault of ['SIGKILL:RECORD_PRE_LINK', 'SIGKILL:RECORD_LINKED', 'SIGKILL:RECORD_DIR_FSYNCED']) {
  const receiptCrash = fixture();
  writeFileSync(receiptCrash.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
  const receiptPlanResult = run(receiptCrash.args);
  assert.equal(receiptPlanResult.status, 0, receiptPlanResult.stderr);
  const receiptPlan = JSON.parse(receiptPlanResult.stdout);
  const receiptPlanPath = join(receiptCrash.root, 'receipt-plan.json');
  const receiptPath = `${receiptCrash.paths.config}.provision-receipt.${receiptPlan.digest}`;
  writeFileSync(receiptPlanPath, receiptPlanResult.stdout, { mode: 0o600 });
  const crashed = run(['apply', '--plan', receiptPlanPath, '--expected-digest', receiptPlan.digest], {
    CLAUDE_COORDINATION_TESTING: '1',
    CLAUDE_COORDINATION_TEST_RECORD_TARGET: receiptPath,
    CLAUDE_COORDINATION_TEST_FAULT: fault,
  });
  assert.equal(crashed.signal, 'SIGKILL', fault);
  const recoveryPlanResult = run(receiptCrash.args);
  assert.equal(recoveryPlanResult.status, 0, recoveryPlanResult.stderr);
  const recoveryPlan = JSON.parse(recoveryPlanResult.stdout);
  const recoveryPlanPath = join(receiptCrash.root, `receipt-recovery-${fault.replaceAll(':', '-')}.json`);
  writeFileSync(recoveryPlanPath, recoveryPlanResult.stdout, { mode: 0o600 });
  const recovered = run(['apply', '--plan', recoveryPlanPath, '--expected-digest', recoveryPlan.digest]);
  assert.equal(recovered.status, 0, `${fault} reviewed receipt recovery: ${recovered.stderr}`);
}

const forgedReceipt = fixture();
writeFileSync(forgedReceipt.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
const forgedPlanResult = run(forgedReceipt.args);
const forgedPlan = JSON.parse(forgedPlanResult.stdout);
const forgedPlanPath = join(forgedReceipt.root, 'forged-receipt-plan.json');
writeFileSync(forgedPlanPath, forgedPlanResult.stdout, { mode: 0o600 });
assert.equal(run(['apply', '--plan', forgedPlanPath, '--expected-digest', forgedPlan.digest]).status, 0);
const forgedReceiptPath = `${forgedReceipt.paths.config}.provision-receipt.${forgedPlan.digest}`;
const authenticReceipt = JSON.parse(readFileSync(forgedReceiptPath, 'utf8'));
unlinkSync(forgedReceiptPath);
writeFileSync(forgedReceiptPath, `${JSON.stringify({ ...authenticReceipt, signature: '0'.repeat(64) })}\n`, {
  mode: 0o600,
});
assert.match(
  run(['apply', '--plan', forgedPlanPath, '--expected-digest', forgedPlan.digest]).stderr,
  /INVALID_PROVISION_RECEIPT/,
);

const replacedTrust = fixture();
writeFileSync(replacedTrust.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
const replacedTrustPlanResult = run(replacedTrust.args);
const replacedTrustPlan = JSON.parse(replacedTrustPlanResult.stdout);
const replacedTrustPlanPath = join(replacedTrust.root, 'replaced-trust-plan.json');
writeFileSync(replacedTrustPlanPath, replacedTrustPlanResult.stdout, { mode: 0o600 });
unlinkSync(replacedTrust.paths.trust);
writeFileSync(replacedTrust.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
assert.match(
  run(['apply', '--plan', replacedTrustPlanPath, '--expected-digest', replacedTrustPlan.digest]).stderr,
  /TRUST_SNAPSHOT_CHANGED/,
  'same-byte trust replacement is rejected by descriptor identity',
);

const forgedJournal = fixture();
writeFileSync(forgedJournal.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
writeFileSync(
  `${forgedJournal.paths.config}.provision-journal`,
  `${JSON.stringify({
    version: 1,
    operationId: 'a'.repeat(32),
    planDigest: 'b'.repeat(64),
    phase: 'APPLYING',
    ownedTargets: [
      {
        path: forgedJournal.paths.manifest,
        proof: forgedJournal.manifestSource,
        digest: 'c'.repeat(64),
        dev: '1',
        ino: '1',
        birthtimeNs: '1',
        length: 1,
      },
    ],
  })}\n`,
  { mode: 0o600 },
);
assert.match(run(forgedJournal.args).stderr, /INVALID_PROVISION_JOURNAL/);

const postPlanJournal = fixture();
writeFileSync(postPlanJournal.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
const postPlanResult = run(postPlanJournal.args);
const postPlan = JSON.parse(postPlanResult.stdout);
const postPlanPath = join(postPlanJournal.root, 'post-plan-journal.json');
writeFileSync(postPlanPath, postPlanResult.stdout, { mode: 0o600 });
writeFileSync(
  `${postPlanJournal.paths.config}.provision-journal`,
  `${JSON.stringify({
    version: 1,
    operationId: 'a'.repeat(32),
    planDigest: postPlan.digest,
    phase: 'APPLYING',
    ownedTargets: [],
  })}\n`,
  { mode: 0o600 },
);
assert.match(
  run(['apply', '--plan', postPlanPath, '--expected-digest', postPlan.digest]).stderr,
  /PROVISION_JOURNAL_REVIEW_REQUIRED/,
  'a correct-shape journal created after review is never recovery authority',
);

// Upgrade keeps an existing owner-only key and provisions missing first-party artifacts.
const upgrade = fixture();
writeFileSync(upgrade.paths.trust, Buffer.alloc(32, 7), { mode: 0o600 });
const up = run(upgrade.args);
const upPlan = JSON.parse(up.stdout);
const upPath = join(upgrade.root, 'plan.json');
writeFileSync(upPath, up.stdout);
assert.equal(run(['apply', '--plan', upPath, '--expected-digest', upPlan.digest]).status, 0, 'upgrade');
assert.deepEqual(readFileSync(upgrade.paths.trust), Buffer.alloc(32, 7), 'existing key retained');

// A mismatched pre-existing generated artifact is never overwritten, and an
// already provisioned trust/config plane remains intact for rollback.
writeFileSync(upgrade.paths['linux-unit'], 'operator-owned mismatch\n', { mode: 0o600 });
const mismatch = run(['apply', '--plan', upPath, '--expected-digest', upPlan.digest]);
assert.notEqual(mismatch.status, 0);
assert.equal(readFileSync(upgrade.paths['linux-unit'], 'utf8'), 'operator-owned mismatch\n');
assert.deepEqual(readFileSync(upgrade.paths.trust), Buffer.alloc(32, 7));
assert.equal(existsSync(upgrade.paths.config), true);
console.log('coordination provisioning tests: PASS');
