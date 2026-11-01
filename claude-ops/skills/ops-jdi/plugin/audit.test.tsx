import { test, expect, mock } from 'claude-code/testing'
import { setup, pane, command } from './test-support'

const contracted = (f: ReturnType<typeof setup>) => {
  f.state.outcomes = { result: { dod: 'Required result', evidence: [{ receipt: 'r' }] } }
}
const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('audit reads the bridge, forks once, reports verdict and usage without claiming completion', async ($, on) => {
  const f = setup(on)
  contracted(f)
  f.model.forkReply = { isAnswered: true, text: 'ADEQUAAT\n- bewijs dekt DoD', usage }
  const r = await $.command.run(command('audit'))
  expect(f.model.fork).toBe(1)
  expect(f.model.prompts[0]).toContain('result')
  expect(f.model.prompts[0]).toContain('Required result')
  expect(r.text).toContain('ADEQUAAT')
  expect(r.text).toContain('120 in / 30 uit')
  expect(r.text).toContain('wijzigt geen acceptatie')
  expect(r.text).toContain('Audits tot nu toe: 1')
  expect(f.state.audit.acceptance).toBe('none')
})
test('audit mutates only the audit record, never acceptance actions', async ($, on) => {
  const f = setup(on)
  contracted(f)
  f.model.forkReply = { isAnswered: true, text: 'HIATEN', usage }
  await $.command.run(command('audit'))
  for (const a of f.actions) expect(['status', 'audit-record']).toContain(a)
  expect(f.state.paused).toBe(false)
  expect(f.state.generation).toBe(1)
})
test('audit survives a fork with no answer', async ($, on) => {
  const f = setup(on)
  contracted(f)
  const r = await $.command.run(command('audit'))
  expect(f.model.fork).toBe(1)
  expect(r.text).toContain('geen verdict')
  expect(r.text).toContain('nothing-to-fork')
  expect(r.text).toContain('Geen voltooiing bewezen')
})
test('audit survives an unavailable or throwing fork', async ($, on) => {
  const f = setup(on)
  contracted(f)
  f.model.forkThrows = true
  const r = await $.command.run(command('audit'))
  expect(r.text).toContain('fork-unavailable')
  expect(r.text).not.toContain('ADEQUAAT')
})
test('audit without a contract makes no model call', async ($, on) => {
  const f = setup(on)
  const r = await $.command.run(command('audit'))
  expect(f.model.fork).toBe(0)
  expect(r.text).toContain('geen contract')
})
test('audit with unreadable bridge makes no model call', async ($, on) => {
  const f = setup(on)
  contracted(f)
  f.reply.exitCode = 1
  const r = await $.command.run(command('audit'))
  expect(f.model.fork).toBe(0)
  expect(r.text).toContain('brugdiagnose')
})
test('pane shows the audit counter', async ($, on) => {
  const f = setup(on)
  contracted(f)
  f.state.audit = { generation: 1, requests: 3, acceptance: 'none', answered: true, verdict: 'x', reason: '' }
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /audits op verzoek: 3/ }))).toBeTruthy()
})
test('cost guard: ordinary operation makes zero model calls', async ($, on) => {
  const clock = mock.clock(on)
  const f = setup(on)
  contracted(f)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('diagnose'))
  await $.command.run(command('pause'))
  await $.command.run(command('resume'))
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' })
  await clock.advance(600000)
  expect(f.model.fork).toBe(0)
  expect(f.model.complete).toBe(0)
  expect(f.model.classify).toBe(0)
})
