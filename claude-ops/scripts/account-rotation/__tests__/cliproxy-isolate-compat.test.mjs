#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateCompatYaml, applyIsolateCompat, splitCompatItems } from '../cliproxy-isolate-compat.mjs';

const yaml = `host: 127.0.0.1
port: 8319
openai-compatibility:
- name: kimi
  base-url: https://api.kimi.example/v1
  api-key-entries:
  - api-key: fake-kimi-key
  models:
  - name: k3
    alias: kimi-k3
- name: opencode-go
  base-url: https://opencode.example/v1
  api-key-entries:
  - api-key: fake-opencode-key
  models:
  - name: glm-5
    alias: go-glm-5
  - name: mimo-v2.5
    alias: go-mimo-v2.5
- name: gemini
  base-url: https://gemini.example/v1
  api-key-entries:
  - api-key: fake-gemini-key
  models:
  - name: gemini-2.5-flash
auth-auto-refresh-workers: 16
ws-auth: true
`;

const split = splitCompatItems(yaml);
assert.deepEqual(
  split.items.map((it) => it.name),
  ['kimi', 'opencode-go', 'gemini'],
);

const isolated = isolateCompatYaml(yaml, ['opencode-go']);
assert.deepEqual(
  isolated.removed.map((it) => it.name),
  ['opencode-go'],
);
assert.deepEqual(isolated.kept, ['kimi', 'gemini']);
assert.match(isolated.yaml, /^- name: kimi$/m);
assert.match(isolated.yaml, /^- name: gemini$/m);
assert.doesNotMatch(isolated.yaml, /^- name: opencode-go$/m);
assert.match(isolated.yaml, /^auth-auto-refresh-workers: 16$/m);
assert.match(isolated.yaml, /fake-kimi-key/);
assert.doesNotMatch(isolated.yaml, /fake-opencode-key/);

const dir = mkdtempSync(join(tmpdir(), 'cliproxy-isolate-'));
const configPath = join(dir, 'config.yaml');
const isolateDir = join(dir, 'isolated');
const manifestPath = join(dir, 'manifest.json');
writeFileSync(configPath, yaml);
writeFileSync(
  manifestPath,
  JSON.stringify({
    providers: ['opencode-go'],
    reasons: { 'opencode-go': 'CreditsError: no payment method' },
  }),
);

const applied = applyIsolateCompat({ configPath, isolateDir, manifestPath });
assert.equal(applied.ok, true);
assert.deepEqual(applied.removed, ['opencode-go']);
assert.equal(existsSync(join(isolateDir, 'opencode-go.yaml')), true);
const after = readFileSync(configPath, 'utf8');
assert.doesNotMatch(after, /^- name: opencode-go$/m);
assert.match(after, /^- name: kimi$/m);
assert.match(readFileSync(join(isolateDir, 'opencode-go.yaml'), 'utf8'), /fake-opencode-key/);

const second = applyIsolateCompat({ configPath, isolateDir, manifestPath });
assert.equal(second.unchanged, true);

// Regression: openai-compatibility sequences indented under the key (valid
// YAML) must still be detected — a column-0-only scan silently returns zero
// items and leaves an unservable provider advertised.
const indentedYaml = `host: 127.0.0.1
port: 8319
openai-compatibility:
  - name: kimi
    base-url: https://api.kimi.example/v1
    api-key-entries:
      - api-key: fake-kimi-key
    models:
      - name: k3
        alias: kimi-k3
  - name: opencode-go
    base-url: https://opencode.example/v1
    api-key-entries:
      - api-key: fake-opencode-key
    models:
      - name: glm-5
        alias: go-glm-5
auth-auto-refresh-workers: 16
`;
const indentedSplit = splitCompatItems(indentedYaml);
assert.deepEqual(
  indentedSplit.items.map((it) => it.name),
  ['kimi', 'opencode-go'],
  'indented openai-compatibility sequence must be detected, not silently return zero items',
);
const indentedIsolated = isolateCompatYaml(indentedYaml, ['opencode-go']);
assert.deepEqual(
  indentedIsolated.removed.map((it) => it.name),
  ['opencode-go'],
);
assert.deepEqual(indentedIsolated.kept, ['kimi']);

// Regression: a comment-only line right after the `openai-compatibility:`
// header, and a comment-only line between two same-depth items, are both
// valid YAML and must not stop the scan — a provider after either comment
// must still be parsed and remain isolatable.
const commentedYaml = `host: 127.0.0.1
port: 8319
openai-compatibility:
  # header comment before the first item
- name: kimi
  base-url: https://api.kimi.example/v1
  api-key-entries:
  - api-key: fake-kimi-key
  models:
  - name: k3
    alias: kimi-k3
# comment between kimi and opencode-go
- name: opencode-go
  base-url: https://opencode.example/v1
  api-key-entries:
  - api-key: fake-opencode-key
  models:
  - name: glm-5
    alias: go-glm-5
- name: gemini
  base-url: https://gemini.example/v1
  api-key-entries:
  - api-key: fake-gemini-key
  models:
  - name: gemini-2.5-flash
auth-auto-refresh-workers: 16
`;
const commentedSplit = splitCompatItems(commentedYaml);
assert.deepEqual(
  commentedSplit.items.map((it) => it.name),
  ['kimi', 'opencode-go', 'gemini'],
  'a comment after the header, and a comment between items, must not truncate the scan',
);

const commentedIsolated = isolateCompatYaml(commentedYaml, ['opencode-go']);
assert.deepEqual(
  commentedIsolated.removed.map((it) => it.name),
  ['opencode-go'],
  'opencode-go must still be isolatable when preceded by a comment line',
);
assert.deepEqual(commentedIsolated.kept, ['kimi', 'gemini']);
assert.match(commentedIsolated.yaml, /^- name: kimi$/m);
assert.match(commentedIsolated.yaml, /^- name: gemini$/m);
assert.doesNotMatch(commentedIsolated.yaml, /^- name: opencode-go$/m);
// The comment attached to the removed item travels with it into the
// isolated block, not into the rewritten config.yaml.
assert.doesNotMatch(commentedIsolated.yaml, /comment between kimi and opencode-go/);
assert.match(commentedIsolated.removed[0].lines.join('\n'), /comment between kimi and opencode-go/);
// The header comment is attached to kept item "kimi" and is preserved.
assert.match(commentedIsolated.yaml, /header comment before the first item/);

// Regression: a same-depth comment that follows the LAST item in the list
// must keep its original position (attached after that item, before
// whatever key follows the list), not be silently dropped. The inner loop
// that reads an item's body stops as soon as it sees a comment at or above
// the item's own indent, so the outer loop buffers it as `pendingComments`
// — and previously discarded that buffer entirely when the list then ended
// with no further item to attach it to.
const trailingCommentYaml = `host: 127.0.0.1
port: 8319
openai-compatibility:
- name: kimi
  base-url: https://api.kimi.example/v1
  api-key-entries:
  - api-key: fake-kimi-key
  models:
  - name: k3
    alias: kimi-k3
- name: gemini
  base-url: https://gemini.example/v1
  api-key-entries:
  - api-key: fake-gemini-key
  models:
  - name: gemini-2.5-flash
# trailing comment after the last provider
auth-auto-refresh-workers: 16
ws-auth: true
`;
const trailingSplit = splitCompatItems(trailingCommentYaml);
assert.deepEqual(
  trailingSplit.items.map((it) => it.name),
  ['kimi', 'gemini'],
);
assert.match(
  trailingSplit.after,
  /^# trailing comment after the last provider$/m,
  'a comment after the final item must be preserved in `after`, not dropped',
);
assert.match(trailingSplit.after, /^auth-auto-refresh-workers: 16$/m);

const trailingIsolated = isolateCompatYaml(trailingCommentYaml, ['gemini']);
assert.deepEqual(trailingIsolated.kept, ['kimi']);
assert.match(
  trailingIsolated.yaml,
  /^# trailing comment after the last provider$/m,
  'round-tripping through isolateCompatYaml must not lose the trailing comment',
);
assert.match(trailingIsolated.yaml, /^auth-auto-refresh-workers: 16$/m);

console.log('cliproxy-isolate-compat.test.mjs: ok');
