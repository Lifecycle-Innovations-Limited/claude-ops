#!/usr/bin/env bash
# Validate actual routing expressions and the release check-name contract.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node --input-type=module - "$ROOT" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = process.argv[2];
const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
const jobs = Object.fromEntries([...ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)].map(m => [m[1], m[2]]));
const routed = ['optimize-ci', 'lint-and-check', 'pii-gate', 'pii-gate-metadata', 'test-suite', 'ci-summary'];
const cases = [
  ['same-repo PR', 'pull_request', 'example/repo', ['self-hosted', 'Linux', 'aws']],
  ['fork PR', 'pull_request', 'example/fork', 'ubuntu-latest'],
  ['push', 'push', null, ['self-hosted', 'Linux', 'aws']],
];
for (const job of routed) {
  const match = jobs[job]?.match(/^    runs-on: \$\{\{ (.+) \}\}$/m);
  assert.ok(match, `${job} must declare conditional routing`);
  // Evaluate the expression read from the workflow, not a copied predicate.
  const evaluate = new Function('github', 'fromJSON', `return (${match[1]});`);
  for (const [label, event_name, head, expected] of cases) {
    const github = { event_name, repository: 'example/repo', event: head ? { pull_request: { head: { repo: { full_name: head } } } } : {} };
    assert.deepEqual(evaluate(github, JSON.parse), expected, `${job}: ${label}`);
  }
}
const summary = jobs['ci-summary'];
assert.match(summary, /^    name: CI Summary$/m);
assert.match(summary, /^    permissions: \{\}$/m);
assert.match(summary, /^    if: always\(\)$/m);
assert.match(summary, /^    needs: \[optimize-ci, lint-and-check, pii-gate, pii-gate-metadata, test-suite\]$/m);
assert.match(summary, /NEEDS_RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}/);
const run = summary.split('        run: |\n')[1].split('\n').filter(Boolean).map(line => line.slice(10)).join('\n');
for (const [results, expected] of [['success skipped', 0], ['success failure', 1], ['success cancelled', 1], ['success timed_out', 1]]) {
  const result = spawnSync('bash', ['-c', run], { env: { ...process.env, NEEDS_RESULTS: results }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, expected, `Summary result enforcement: ${results}`);
}
const release = readFileSync(`${root}/claude-ops/bin/ops-release`, 'utf8');
const required = JSON.parse(release.match(/^RELEASE_REQUIRED_CHECKS='(.+)'$/m)[1]);
for (const job of ['lint-and-check', 'test-suite']) {
  assert.match(jobs[job], /^        os: \[ubuntu-latest\]$/m);
  assert.ok(required.includes(`${job} (ubuntu-latest)`), `${job} release context must remain exact`);
}
console.log('PASS: six jobs route same-repo PR/push to AWS and forks to hosted runners');
console.log('PASS: CI Summary permissions, dependencies, always condition and result enforcement retained');
console.log('PASS: release required matrix check names retained');
JS
