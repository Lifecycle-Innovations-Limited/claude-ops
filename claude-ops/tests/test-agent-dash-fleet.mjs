#!/usr/bin/env node
// Offline fleet/control regression: intercept every child process before importing modules.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agent-dash-fleet-'));
const oldEnv = { ...process.env };
const originalExec = cp.execFileSync;
const originalSpawn = cp.spawnSync;
const originalNow = Date.now;
let clock = originalNow();
let liveHosts = ['alpha.example', 'beta.example'];
const calls = [];
try {
  process.env.HOME = home;
  process.env.CLAUDE_PLUGIN_DATA_DIR = join(home, 'data');
  process.env.AGENT_DASH_REMOTE_HOSTS = 'alpha.example,beta.example';
  mkdirSync(process.env.CLAUDE_PLUGIN_DATA_DIR);
  writeFileSync(
    join(process.env.CLAUDE_PLUGIN_DATA_DIR, 'preferences.json'),
    JSON.stringify({ agent_dash: { remote_hosts: ['beta.example'] } }),
  );
  cp.execFileSync = (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === 'band') return 'band-output';
    if (command === 'ssh') {
      const host = args.at(-2);
      if (!liveHosts.includes(host)) throw new Error('offline');
      if (args.at(-1).includes('agent-dash-probe'))
        return JSON.stringify([{ type: 'claude', host, id: 'shared', sessionId: 'session', pid: 123, name: 'worker' }]);
      return '';
    }
    if (command === process.execPath) return '[]';
    throw new Error(`unexpected command: ${command}`);
  };
  cp.spawnSync = (command, args) => {
    calls.push({ command, args });
    return { status: 0 };
  };
  syncBuiltinESMExports();
  Date.now = () => clock;
  const { collect, collectRemote } = await import('../scripts/agent-dash/collect.mjs');
  const ctrl = await import('../scripts/agent-dash/control.mjs');
  const snap = collect({ force: true });
  assert.deepEqual(
    snap.agents.map((a) => a.host),
    liveHosts,
    'both live hosts aggregate',
  );
  assert.equal(snap.hosts['beta.example'].count, 1);
  assert.equal(calls.filter((c) => c.command === 'band').length, 5);
  collect();
  assert.equal(calls.filter((c) => c.command === 'band').length, 5, 'same-process Band cache reused');
  clock += 30001;
  collect();
  assert.equal(calls.filter((c) => c.command === 'band').length, 10, 'Band TTL expires');
  collect({ skipCollaboration: true });
  collect({ localOnly: true });
  assert.equal(calls.filter((c) => c.command === 'band').length, 10, 'control/local paths skip Band');
  assert.equal(collectRemote().hosts['alpha.example'].cached, true);
  liveHosts = ['alpha.example'];
  const partial = collectRemote({ force: true });
  assert.equal(partial.hosts['beta.example'].known, false);
  assert.equal(partial.hosts['beta.example'].count, null);
  assert.equal(partial.hosts['beta.example'].stale, true);
  liveHosts = [];
  const stale = collectRemote({ force: true });
  assert.equal(stale.hosts['alpha.example'].cached, true);
  assert.equal(stale.hosts['alpha.example'].stale, true);

  for (const query of ['shared', '123', 'session', 'worker', 'sha']) {
    assert.throws(() => ctrl.findAgent(snap, query), /ambiguous.*host:id/i, `reject ambiguous ${query}`);
  }
  assert.equal(ctrl.findAgent(snap, 'beta.example:shared').host, 'beta.example');
  assert.equal(ctrl.findAgent(snap, 'alpha.example:123').host, 'alpha.example');
  assert.equal(ctrl.findAgent(snap, undefined), null);
  assert.equal(ctrl.findAgent(snap, 'missing'), null);

  // Environment is an override: collection and controls must agree even when prefs differ.
  process.env.AGENT_DASH_REMOTE_HOSTS = 'alpha.example';
  assert.deepEqual(collectRemote().agents, [], 'configuration change invalidates cached agents');
  assert.throws(() => ctrl.attach(snap.agents[1]), /unconfigured host/);
  liveHosts = ['alpha.example'];
  const alphaOnly = collectRemote({ force: true });
  assert.deepEqual(Object.keys(alphaOnly.hosts), ['alpha.example']);
  process.env.AGENT_DASH_REMOTE_HOSTS = '';
  liveHosts = ['beta.example'];
  assert.equal(collectRemote({ force: true }).agents[0].host, 'beta.example');
  assert.equal(ctrl.attach(snap.agents[1]), 0, 'preference host accepted by control');

  for (const value of [null, '', '-option', 'bad\nvalue']) {
    const before = calls.length;
    assert.throws(() => ctrl.attach({ ...snap.agents[1], id: value }), /invalid remote identifier/);
    assert.throws(() => ctrl.revive({ ...snap.agents[1], type: 'agy', sessionId: value }), /invalid remote identifier/);
    assert.equal(calls.length, before, 'invalid identifiers never dispatched');
  }
  const agent = { ...snap.agents[1], id: "id'; touch injected", sessionId: "session'$(bad)", name: 'worker' };
  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  ctrl.attach(agent);
  assert.equal(calls.at(-1).args.at(-1), `CLAUDE_NO_TMUX=1 claude attach ${quote(agent.id)}`);
  ctrl.steer(agent, "hello'$(bad)");
  assert.equal(calls.at(-1).args.at(-1), `ops-bg send ${quote(agent.id)} ${quote("hello'$(bad)")}`);
  ctrl.revive(agent);
  assert.equal(
    calls.at(-1).args.at(-1),
    `CLAUDE_NO_TMUX=1 claude attach ${quote(agent.id)} || CLAUDE_NO_TMUX=1 claude -r ${quote(agent.sessionId)}`,
  );
  ctrl.kill(agent);
  assert.equal(calls.at(-1).args.at(-1), `CLAUDE_NO_TMUX=1 claude stop ${quote(agent.id)}`);
  ctrl.archive(agent);
  assert.equal(calls.at(-1).args.at(-1), `CLAUDE_NO_TMUX=1 claude rm ${quote(agent.id)}`);
  ctrl.attach({ ...agent, type: 'agy' });
  assert.equal(calls.at(-1).args.at(-1), `agy --conversation ${quote(agent.sessionId)}`);
  ctrl.revive({ ...agent, type: 'agy' });
  assert.equal(calls.at(-1).args.at(-1), `agy --conversation ${quote(agent.sessionId)}`);
  for (const pid of ['1; touch injected', '-1', 0, 1.5, '123junk']) {
    const before = calls.length;
    assert.equal(ctrl.kill({ ...agent, type: 'proc', pid }).ok, false);
    assert.equal(calls.length, before, 'invalid PID never dispatched');
  }
  ctrl.kill({ ...agent, type: 'proc', pid: 123 });
  assert.equal(calls.at(-1).args.at(-1), "kill '123'");
  for (const host of ['-oProxyCommand=bad', 'bad$(command)', 'beta.example;bad']) {
    process.env.AGENT_DASH_REMOTE_HOSTS = host;
    assert.throws(() => ctrl.attach({ ...agent, host }), /unconfigured host/);
    assert.equal(collectRemote({ force: true }).source, 'not-configured');
  }
  console.log('agent-dash fleet regression passed (aggregation, cache, configuration, selection, safe dispatch)');
} finally {
  Date.now = originalNow;
  cp.execFileSync = originalExec;
  cp.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  process.env = oldEnv;
  rmSync(home, { recursive: true, force: true });
}
