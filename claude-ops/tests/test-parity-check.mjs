#!/usr/bin/env node
// test-parity-check.mjs — contract tests for lib/parity/check.mjs.
//
// Every case builds a throwaway HOME under the OS temp dir: a reference
// release, then one install per host (Claude, Codex, Grok, Cursor, Hermes)
// shaped the way that host really stores it. Nothing reads or writes the real
// home. Public repo: placeholder names only.
//
// Load-bearing cases:
//   - same version, same size, same mtime, different bytes -> DRIFT
//   - the check is pure: every fs mutator throws while it runs, and a full
//     before/after snapshot (dir mtimes, new empty dirs, link text) is equal
//   - a rename-swap during the scan -> STALE_SCAN, never a stale MATCH

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkTargets, main, lockKey, STATUS_TABLE, STATUSES, docsAnchor } from '../lib/parity/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SRC = path.join(HERE, '..', 'lib', 'parity', 'check.mjs');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) {
    pass++;
    process.stdout.write(`  PASS: ${msg}\n`);
  } else {
    fail++;
    process.stdout.write(`  FAIL: ${msg}${detail ? `\n        ${detail}` : ''}\n`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-parity-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;

function write(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function makeRef(root, version = '9.9.9') {
  write(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ops', version }) + '\n');
  write(path.join(root, 'skills', 'ops', 'SKILL.md'), '---\nname: ops\n---\nrouter\n');
  write(path.join(root, 'skills', 'ops-a', 'SKILL.md'), '---\nname: ops-a\n---\nalpha\n');
  write(path.join(root, 'skills', 'ops-a', 'references', 'r.md'), 'reference body\n');
  write(path.join(root, 'skills', 'ops-b', 'SKILL.md'), '---\nname: ops-b\n---\nbeta\n');
  write(path.join(root, 'hermes-plugin', 'plugin.yaml'), `name: ops\nversion: "${version}"\n`);
  write(path.join(root, 'hermes-plugin', '__init__.py'), '# plugin\n');
  return root;
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

// A home where every primary host matches the reference.
function makeWorld({ hosts = ['claude', 'codex', 'grok', 'cursor', 'hermes'] } = {}) {
  const base = path.join(TMP, `w${++n}`);
  const home = path.join(base, 'home');
  const ref = makeRef(path.join(base, 'release'));
  fs.mkdirSync(home, { recursive: true });
  const t = {};
  if (hosts.includes('claude')) {
    t.claude = path.join(home, '.claude', 'plugins', 'cache', 'ops-marketplace', 'ops', '9.9.9');
    copyTree(ref, t.claude);
    write(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'ops@ops-marketplace': [{ installPath: t.claude, version: '9.9.9', gitCommitSha: 'a'.repeat(40) }] },
      }),
    );
  }
  if (hosts.includes('grok')) {
    t.grok = path.join(home, '.grok', 'installed-plugins', 'claude-ops-0000');
    copyTree(ref, t.grok);
    write(
      path.join(home, '.grok', 'installed-plugins', 'registry.json'),
      JSON.stringify({
        version: 1,
        repos: { 'claude-ops-0000': { path: t.grok, plugins: { ops: { version: '9.9.9' } } } },
      }),
    );
  }
  if (hosts.includes('cursor')) {
    t.cursor = path.join(home, '.cursor', 'plugins', 'cache', 'ops-marketplace', 'ops', 'b'.repeat(40));
    copyTree(ref, t.cursor);
  }
  if (hosts.includes('codex')) {
    t.codex = path.join(home, '.codex', 'skills');
    fs.mkdirSync(t.codex, { recursive: true });
    for (const s of ['ops', 'ops-a', 'ops-b']) fs.symlinkSync(path.join(ref, 'skills', s), path.join(t.codex, s));
  }
  if (hosts.includes('hermes')) {
    t.hermes = path.join(home, '.hermes', 'plugins', 'ops');
    copyTree(path.join(ref, 'hermes-plugin'), t.hermes);
    copyTree(path.join(ref, 'skills'), path.join(t.hermes, 'skills'));
  }
  const env = { HOME: home, PATH: process.env.PATH };
  return { base, home, ref, t, env };
}

function run(w, opts = {}) {
  return checkTargets({ source: w.ref, env: w.env, configPath: null, ...opts });
}

function rec(report, host) {
  return report.records.find((r) => r.target === host);
}

// Full snapshot: every path with lstat type, size, mtime, link text, content hash.
function snapshot(root) {
  const out = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    let extra = '';
    if (st.isSymbolicLink()) extra = fs.readlinkSync(p);
    else if (st.isFile()) extra = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    out.push(`${path.relative(root, p)}|${st.mode}|${st.size}|${st.mtimeMs}|${extra}`);
    if (st.isDirectory()) for (const c of fs.readdirSync(p).sort()) walk(path.join(p, c));
  };
  walk(root);
  return out.join('\n');
}

process.stdout.write('=== parity check core ===\n');

// 1. Everything matches
{
  const w = makeWorld();
  const r = run(w);
  const primary = ['claude', 'codex', 'grok', 'cursor', 'hermes'].map((h) => rec(r, h)?.status);
  ok(
    primary.every((s) => s === 'MATCH'),
    'all five hosts MATCH a byte-identical install',
    JSON.stringify(primary),
  );
  ok(r.aggregate.exit_code === 0 && r.aggregate.class === 'clean', 'clean aggregate exits 0');
  ok(rec(r, 'grok').observed.consumer_proof === 'grok registry.json', 'grok consumer comes from its registry');
  ok(rec(r, 'claude').coverage.compared > 0, 'coverage reports the compared file count');
}

// 2. Same size, same mtime, different bytes
{
  const w = makeWorld();
  const f = path.join(w.t.grok, 'skills', 'ops-a', 'SKILL.md');
  fs.utimesSync(f, 1700000000, 1700000000);
  const st = fs.statSync(f);
  const orig = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, orig.replace('alpha', 'ALPHA'));
  fs.utimesSync(f, 1700000000, 1700000000);
  const st2 = fs.statSync(f);
  const r = run(w);
  ok(st2.size === st.size && st2.mtimeMs === st.mtimeMs, 'fixture keeps size and mtime equal');
  ok(
    rec(r, 'grok').status === 'DRIFT' && rec(r, 'grok').coverage.changed.includes('skills/ops-a/SKILL.md'),
    'same size+mtime with different bytes is DRIFT on the exact path',
    JSON.stringify(rec(r, 'grok').coverage),
  );
  ok(r.aggregate.exit_code === 1, 'drift exits 1');
}

// 3. Missing reference file
{
  const w = makeWorld();
  fs.rmSync(path.join(w.t.cursor, 'skills', 'ops-a', 'references', 'r.md'));
  const c = rec(run(w), 'cursor');
  ok(
    c.status === 'DRIFT' && c.coverage.missing.includes('skills/ops-a/references/r.md'),
    'a missing reference file is DRIFT',
  );
}

// 4. Codex: only one link present, and an old OPS skill still linked
{
  const w = makeWorld();
  fs.unlinkSync(path.join(w.t.codex, 'ops-a'));
  fs.unlinkSync(path.join(w.t.codex, 'ops-b'));
  const old = makeRef(path.join(w.base, 'old-release'), '9.9.8');
  write(path.join(old, 'skills', 'ops-retired', 'SKILL.md'), 'old\n');
  fs.symlinkSync(path.join(old, 'skills', 'ops-retired'), path.join(w.t.codex, 'ops-retired'));
  const c = rec(run(w), 'codex');
  ok(c.status === 'DRIFT', "codex with only the ops link is DRIFT, not 'nothing to do'");
  ok(
    c.coverage.missing.includes('skills/ops-a/SKILL.md') && c.coverage.missing.includes('skills/ops-b/SKILL.md'),
    'every missing codex skill is listed, not only ops',
  );
  ok(c.coverage.extra.includes('skills/ops-retired/'), 'an old OPS skill no longer shipped is extra');
}

// 5. Hermes developer symlink
{
  const w = makeWorld();
  fs.rmSync(w.t.hermes, { recursive: true });
  const checkout = path.join(w.base, 'dev-checkout');
  copyTree(w.ref, path.join(checkout, 'claude-ops'));
  write(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(checkout, '.git', 'refs', 'heads', 'main'), 'c'.repeat(40) + '\n');
  fs.symlinkSync(path.join(checkout, 'claude-ops', 'hermes-plugin'), w.t.hermes);
  const before = fs.readlinkSync(w.t.hermes);
  const h = rec(run(w), 'hermes');
  ok(
    h.status === 'DEV_SOURCE' && h.observed.sha === 'c'.repeat(40),
    'a dev-checkout symlink is DEV_SOURCE with its SHA',
    JSON.stringify(h.observed),
  );
  ok(fs.readlinkSync(w.t.hermes) === before, 'the dev symlink is left untouched');
  ok(h.class === 'drift' && h.error.next.includes('migration'), 'DEV_SOURCE is a drift with a migration next step');
}

// 6. Hermes legacy copy without bundled skills
{
  const w = makeWorld();
  fs.rmSync(path.join(w.t.hermes, 'skills'), { recursive: true });
  const h = rec(run(w), 'hermes');
  ok(
    h.status === 'DRIFT' && /registers 0 ops skills/.test(h.error.cause),
    'a copy install without skills/ is DRIFT with the 0-skills cause',
  );
}

// 7. Cursor with two cache dirs
{
  const w = makeWorld();
  copyTree(w.t.cursor, path.join(path.dirname(w.t.cursor), 'd'.repeat(40)));
  const r = run(w);
  ok(
    rec(r, 'cursor').status === 'AMBIGUOUS_CONSUMER',
    'two Cursor cache dirs are AMBIGUOUS_CONSUMER, not newest-by-name',
  );
  ok(r.aggregate.exit_code === 2, 'an ambiguous consumer is a gap (exit 2)');
}

// 8. Required vs not configured
{
  const w = makeWorld({ hosts: ['claude'] });
  const r1 = run(w);
  ok(
    rec(r1, 'codex').status === 'NOT_CONFIGURED' && r1.aggregate.exit_code === 0,
    'an absent, not-required host is NOT_CONFIGURED and clean',
  );
  const r2 = run(w, { required: ['claude', 'codex'] });
  ok(
    rec(r2, 'codex').status === 'MISSING_REQUIRED' && r2.aggregate.exit_code === 2,
    'an absent required host is MISSING_REQUIRED (exit 2)',
  );
  const cfg = path.join(w.base, 'parity.json');
  write(cfg, JSON.stringify({ required: ['grok'] }));
  const r3 = run(w, { configPath: cfg });
  ok(rec(r3, 'grok').status === 'MISSING_REQUIRED', 'the required set can come from parity.json');
}

// 9. Diagnostic selection does not shrink the required set
{
  const w = makeWorld();
  const r = run(w, { hosts: ['claude'], required: ['claude', 'hermes'] });
  ok(
    rec(r, 'hermes').status === 'NOT_CHECKED' && r.aggregate.exit_code === 2,
    'a required host outside --host is NOT_CHECKED (gap)',
  );
  ok(!rec(r, 'grok'), 'non-required hosts outside the selection are not reported');
}

// 10. Lock held by another run
{
  const w = makeWorld();
  const lockBase = path.join(w.home, '.local', 'state', 'claude-ops', 'locks');
  write(path.join(lockBase, `${lockKey(w.t.grok)}.lock`, 'pid'), '12345\n');
  const r = run(w);
  ok(rec(r, 'grok').status === 'LOCKED' && r.aggregate.exit_code === 6, 'a held target lock is LOCKED (exit 6)');
  ok(rec(r, 'claude').status === 'MATCH', 'other targets are still checked');
}

// 11. Rename-swap during the scan
{
  const w = makeWorld();
  const r = run(w, {
    midScanHook: () => {
      const next = `${w.t.hermes}.new`;
      copyTree(w.t.hermes, next);
      fs.renameSync(w.t.hermes, `${w.t.hermes}.old`);
      fs.renameSync(next, w.t.hermes);
    },
  });
  ok(rec(r, 'hermes').status === 'STALE_SCAN', 'a swap during the scan is STALE_SCAN', rec(r, 'hermes').status);
  ok(rec(r, 'claude').status === 'MATCH', 'untouched targets keep their result');
  const r2 = run(w, {
    midScanHook: () =>
      write(path.join(w.ref, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ops', version: '9.9.10' })),
  });
  ok(
    r2.records.filter((x) => x.class !== 'clean').every((x) => x.status === 'STALE_SCAN') &&
      r2.records.some((x) => x.status === 'STALE_SCAN'),
    'a reference change during the scan makes every compared target STALE_SCAN',
  );
}

// 12. Missing reference
{
  const w = makeWorld({ hosts: [] });
  const r = checkTargets({ env: w.env, configPath: null });
  ok(
    r.records[0].status === 'MISSING_REFERENCE' && r.aggregate.exit_code === 2,
    'no --source and no Claude install is MISSING_REFERENCE (exit 2)',
  );
  ok(/claude-ops-installer fetch/.test(r.records[0].error.next), 'the next step names the separate fetch command');
  const r2 = checkTargets({ source: path.join(w.base, 'nope'), env: w.env, configPath: null });
  ok(r2.records[0].status === 'MISSING_REFERENCE', 'a nonexistent --source is MISSING_REFERENCE');
}

// 13. Exceptions
{
  const w = makeWorld();
  write(path.join(w.t.hermes, 'skills', 'ops', 'SKILL.md'), 'operator overlay\n');
  const good = path.join(w.base, 'good.json');
  write(
    good,
    JSON.stringify({
      exceptions: [
        {
          host: 'hermes',
          path: 'skills/ops/SKILL.md',
          reason: 'local router overlay',
          owner: 'operator',
          compatibility: '9.9.x',
        },
      ],
    }),
  );
  const r = run(w, { configPath: good });
  ok(
    rec(r, 'hermes').status === 'EXCEPTION' && rec(r, 'hermes').exceptions.length === 1,
    'a complete exception record yields EXCEPTION and is listed separately',
  );
  const bad = path.join(w.base, 'bad.json');
  write(bad, JSON.stringify({ exceptions: [{ host: 'hermes', path: 'skills/ops/SKILL.md', reason: 'overlay' }] }));
  const r2 = run(w, { configPath: bad });
  ok(
    rec(r2, 'hermes').status === 'DRIFT' && rec(r2, 'hermes').invalid_exceptions.length === 1,
    'an exception without owner/compatibility is not applied and is reported invalid',
  );
}

// 14. Excludes match the apply side
{
  const w = makeWorld();
  write(path.join(w.t.hermes, '__pycache__', 'x.pyc'), 'bytecode');
  write(path.join(w.t.hermes, '.ops-manifest'), 'manifest');
  write(path.join(w.t.grok, 'skills', 'ops-a', '.git', 'HEAD'), 'x');
  const r = run(w);
  ok(
    rec(r, 'hermes').status === 'MATCH' && rec(r, 'grok').status === 'MATCH',
    '__pycache__, .git and .ops-manifest are excluded',
  );
}

// 15. Purity: no fs mutation API is reachable, and the snapshot is identical
{
  const w = makeWorld();
  write(path.join(w.home, '.hermes', 'profiles', 'p1', 'skills', 'ops', 'x', 'SKILL.md'), 'private\n');
  const before = snapshot(w.base);
  const mutators = [
    'writeFileSync',
    'mkdirSync',
    'rmSync',
    'rmdirSync',
    'renameSync',
    'symlinkSync',
    'unlinkSync',
    'copyFileSync',
    'cpSync',
    'utimesSync',
    'mkdtempSync',
    'appendFileSync',
    'chmodSync',
  ];
  const saved = {};
  const calls = [];
  for (const m of mutators) {
    saved[m] = fs[m];
    fs[m] = (...a) => {
      calls.push(`${m} ${a[0]}`);
      throw new Error(`mutation ${m} during check`);
    };
  }
  const realReaddir = fs.readdirSync;
  const read = [];
  fs.readdirSync = (p, ...rest) => {
    read.push(String(p));
    return realReaddir(p, ...rest);
  };
  let r;
  try {
    r = run(w);
  } finally {
    for (const m of mutators) fs[m] = saved[m];
    fs.readdirSync = realReaddir;
  }
  ok(calls.length === 0 && r.aggregate.exit_code === 0, 'checkTargets calls no fs mutator', calls.join('; '));
  ok(snapshot(w.base) === before, 'before/after snapshot (dir mtimes, links, bytes) is identical');
  ok(!read.some((p) => p.includes(`${path.sep}profiles${path.sep}`)), 'Hermes profile trees are never read');
  ok(!read.some((p) => p === w.home), 'HOME itself is never listed (no HOME sweep)');
}

// 16. The check core does not import the mutating installer modules
{
  const src = fs.readFileSync(CHECK_SRC, 'utf8');
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  ok(
    !imports.some((i) => /source\.mjs|mirror\.mjs|manifest\.mjs|child_process/.test(i)),
    'check.mjs imports no ensureSource/planMirror/manifest/child_process',
    imports.join(','),
  );
  ok(!/ensureSource|planMirror|applyActions/.test(src), 'check.mjs never names ensureSource/planMirror/applyActions');
}

// 17. Status table + error records + CLI exit codes
{
  ok(
    STATUSES.length >= 18 &&
      [
        'MATCH',
        'DRIFT',
        'MISSING_REQUIRED',
        'DEV_SOURCE',
        'UNSUPPORTED_SAFE_APPLY',
        'STALE_SCAN',
        'LOCKED',
        'OWNERSHIP_CONFLICT',
      ].every((s) => STATUSES.includes(s)),
    'status enum carries every status the plan requires',
  );
  ok(
    STATUSES.every((s) => STATUS_TABLE.exit_codes[STATUS_TABLE.statuses[s].class] !== undefined),
    'every status maps to an exit code',
  );
  const w = makeWorld();
  fs.rmSync(path.join(w.t.cursor, 'skills', 'ops-b', 'SKILL.md'));
  const r = run(w, { required: ['codex'] });
  const bad = r.records.filter((x) => x.class !== 'clean');
  ok(
    bad.length > 0 &&
      bad.every((x) =>
        ['problem', 'basis', 'cause', 'next', 'docs'].every((k) => typeof x.error[k] === 'string' && x.error[k]),
      ),
    'every non-clean record has problem/basis/cause/next/docs',
  );
  ok(
    bad.every((x) => x.error.docs === docsAnchor(x.status)),
    'docs field is the status anchor',
  );
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = (s) => ((out += s), true);
  process.stderr.write = (s) => ((out += s), true);
  let c1, c2, c3;
  try {
    c1 = main(['--host', 'nope'], w.env);
    c2 = main(['--help'], w.env);
    c3 = main(['--source', w.ref, '--host', 'claude'], w.env);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  ok(c1 === 4, 'an unknown host is a usage error (exit 4)', String(c1));
  ok(c2 === 0, '--help exits 0');
  ok(c3 === 0 && /claude\s+MATCH/.test(out), 'CLI prints a compact per-target line and exits 0 on match');
}

process.stdout.write(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
