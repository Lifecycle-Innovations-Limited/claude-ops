import { test, expect } from 'claude-code/testing'
import { setup, command } from './test-support'

const finding = (id: string, autoFixable: boolean, severity = 'low') => ({
  id, severity, source: '/x', evidence: `evidence for ${id}`, proposedFix: `fix for ${id}`, autoFixable, patch: [],
})
const scripted = (f: ReturnType<typeof setup>, findings: ReturnType<typeof finding>[]) => {
  f.replies['diagnose-config'] = { schemaVersion: 1, session_id: 'fixture', action: 'diagnose-config', recorded: 0, findings }
}
const stdinFor = (f: ReturnType<typeof setup>, action: string) => {
  const at = f.actions.indexOf(action)
  expect(at).toBeGreaterThanOrEqual(0)
  // stdins only holds calls that sent stdin, so match by content instead of position.
  return f.stdins.map(s => JSON.parse(s)).find(s => (action === 'diagnose-config' ? 'record' in s : 'ids' in s))
}

test('maintain is read-only by default: diagnose without recording, no fix, no model call', async ($, on) => {
  const f = setup(on)
  scripted(f, [finding('settings-hook-missing:Stop/0/0', false, 'high'), finding('exec-bit:smoke.py', true)])
  const r = await $.command.run(command('maintain'))
  expect(f.actions).toContain('diagnose-config')
  expect(f.actions).not.toContain('apply-fix')
  expect(stdinFor(f, 'diagnose-config').record).toBe(false)
  expect(r.text).toContain('alleen lezen')
  expect(r.text).toContain('settings-hook-missing:Stop/0/0')
  expect(r.text).toContain('voorstel voor de eigenaar, niet toegepast')
  expect(f.model.fork + f.model.complete + f.model.classify).toBe(0)
})
test('maintain record asks the bridge to record incidents', async ($, on) => {
  const f = setup(on)
  scripted(f, [finding('hooks-script-missing:hooks/bridge.py', false, 'high')])
  await $.command.run(command('maintain record'))
  expect(stdinFor(f, 'diagnose-config').record).toBe(true)
  expect(f.actions).not.toContain('apply-fix')
})
test('maintain fix sends only autoFixable ids and never findings outside the plugin', async ($, on) => {
  const f = setup(on)
  scripted(f, [finding('settings-hook-missing:Stop/0/0', false, 'high'), finding('plugin-install-missing:a@m/0', false, 'medium'),
    finding('runtime-stale:old.json', true), finding('exec-bit:smoke.py', true)])
  f.replies['apply-fix'] = { schemaVersion: 1, session_id: 'fixture', action: 'apply-fix', results: [
    { id: 'runtime-stale:old.json', status: 'applied', fixId: 'fix-1-aa' }, { id: 'exec-bit:smoke.py', status: 'refused', reason: 'x' }] }
  const r = await $.command.run(command('maintain fix'))
  expect(stdinFor(f, 'apply-fix').ids).toEqual(['runtime-stale:old.json', 'exec-bit:smoke.py'])
  expect(r.text).toContain('runtime-stale:old.json: applied [fix-1-aa]')
  expect(r.text).toContain('exec-bit:smoke.py: refused (x)')
  expect(stdinFor(f, 'diagnose-config').record).toBe(false)
})
test('maintain fix with nothing fixable does not call apply-fix', async ($, on) => {
  const f = setup(on)
  scripted(f, [finding('settings-hook-missing:Stop/0/0', false, 'high')])
  await $.command.run(command('maintain fix'))
  expect(f.actions).not.toContain('apply-fix')
})
test('unknown maintain argument stays read-only', async ($, on) => {
  const f = setup(on)
  scripted(f, [finding('exec-bit:smoke.py', true)])
  await $.command.run(command('maintain everything'))
  expect(f.actions).not.toContain('apply-fix')
  expect(stdinFor(f, 'diagnose-config').record).toBe(false)
})
test('clean machine reports no findings', async ($, on) => {
  const f = setup(on)
  scripted(f, [])
  const r = await $.command.run(command('maintain'))
  expect(r.text).toContain('geen bevindingen')
})
test('a failing bridge changes nothing and says so', async ($, on) => {
  const f = setup(on)
  f.reply.exitCode = 1
  const r = await $.command.run(command('maintain fix'))
  expect(r.text).toContain('niets gewijzigd')
  expect(f.actions).not.toContain('apply-fix')
})
