#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../provision-coordination.mjs', import.meta.url).pathname;
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
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
const plan = JSON.parse(planned.stdout);
assert.doesNotMatch(
  planned.stdout,
  /approvalKey|access[_-]?token|refresh[_-]?token/i,
  'plan contains no key/token material',
);
const planPath = join(f.root, 'plan.json');
writeFileSync(planPath, planned.stdout, { mode: 0o600 });
let applied = run(['apply', '--plan', planPath, '--expected-digest', plan.digest]);
assert.equal(applied.status, 0, applied.stderr);
assert.equal(run(['apply', '--plan', planPath, '--expected-digest', plan.digest]).status, 0, 'idempotent rerun');
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

const selfStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
const selfStart = selfStat.slice(selfStat.lastIndexOf(') ') + 2).split(' ')[19];
writeFileSync(
  f.paths['provision-lock'],
  `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: process.pid, start: selfStart, nonce: 'a'.repeat(32) })}\n`,
  { mode: 0o600 },
);
assert.match(
  run(['apply', '--plan', planPath, '--expected-digest', plan.digest]).stderr,
  /PROVISION_LOCK_HELD/,
  'concurrent provisioning writer refused',
);
writeFileSync(
  f.paths['provision-lock'],
  `${JSON.stringify({ version: 1, planDigest: plan.digest, pid: 99999999, start: '1', nonce: 'b'.repeat(32) })}\n`,
  { mode: 0o600 },
);
assert.equal(
  run(['apply', '--plan', planPath, '--expected-digest', plan.digest]).status,
  0,
  'authenticated plan-bound stale provisioning lock recovered',
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
  CLAUDE_COORDINATION_TEST_FAIL_AFTER: '3',
});
assert.notEqual(failed.status, 0);
for (const file of [rollback.paths.trust, rollback.paths.config, rollback.paths['linux-env']])
  assert.equal(existsSync(file), false);
assert.equal(existsSync(rollback.paths.manifest), false);

// SIGKILL leaves an owner-only digest-bound journal. A fresh process can either
// finish the same reviewed plan or roll back only targets absent at plan start.
const crashResume = fixture();
const crashPlanResult = run(crashResume.args);
const crashPlan = JSON.parse(crashPlanResult.stdout);
const crashPlanPath = join(crashResume.root, 'plan.json');
writeFileSync(crashPlanPath, crashPlanResult.stdout, { mode: 0o600 });
const killed = run(['apply', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest], {
  CLAUDE_COORDINATION_TEST_SIGKILL_AFTER: '3',
});
assert.equal(killed.signal, 'SIGKILL');
assert.equal(existsSync(`${crashResume.paths.config}.provision-journal`), true);
assert.equal(
  run(['apply', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest]).status,
  0,
  'fresh-process resume',
);
assert.equal(existsSync(`${crashResume.paths.config}.provision-journal`), false);

const crashRollback = fixture();
const rollbackPlanResult = run(crashRollback.args);
const rollbackPlan = JSON.parse(rollbackPlanResult.stdout);
const rollbackPlanPath = join(crashRollback.root, 'plan.json');
writeFileSync(rollbackPlanPath, rollbackPlanResult.stdout, { mode: 0o600 });
assert.equal(
  run(['apply', '--plan', rollbackPlanPath, '--expected-digest', rollbackPlan.digest], {
    CLAUDE_COORDINATION_TEST_SIGKILL_AFTER: '2',
  }).signal,
  'SIGKILL',
);
assert.equal(
  run(['rollback', '--plan', rollbackPlanPath, '--expected-digest', rollbackPlan.digest]).status,
  0,
  'fresh-process rollback',
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
assert.match(refusedRollback.stderr, /PROVISION_RECOVERY_UNCERTAIN/);
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
  assert.equal(
    run(['rollback', '--plan', crashPlanPath, '--expected-digest', crashPlan.digest]).status,
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
    CLAUDE_COORDINATION_TEST_SIGKILL_COMPLETE_PROOF_AFTER: '2',
  }).signal,
  'SIGKILL',
);
assert.equal(
  run(['apply', '--plan', completePlanPath, '--expected-digest', completePlan.digest]).status,
  0,
  'fresh apply completes interrupted COMPLETE proof cleanup',
);
assert.equal(existsSync(`${completeCleanup.paths.config}.provision-journal`), false);

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
