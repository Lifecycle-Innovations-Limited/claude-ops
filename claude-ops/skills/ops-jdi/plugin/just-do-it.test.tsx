import { test, expect } from 'claude-code/testing'
import { setup, pane, command } from './test-support'

test('loads real bridge API without invoking model', async ($, on) => {
  const fixture = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(fixture.actions).toEqual(['status'])
})
test('pause updates command bridge', async ($, on) => {
  const f = setup(on)
  await $.command.run(command('pause'))
  expect(f.state.paused).toBe(true)
  expect(f.actions).toEqual(['pause'])
})
test('resume invalidates generation', async ($, on) => {
  const f = setup(on)
  await $.command.run(command('pause'))
  await $.command.run(command('resume'))
  expect(f.state.paused).toBe(false)
  expect(f.state.generation).toBe(3)
})
test('status distinguishes integration from invocation', async ($, on) => {
  const f = setup(on)
  f.state.stopInvocations = 2
  const r = await $.command.run(command('diagnose'))
  expect(r.text).toContain('2 keer')
  expect(r.text).toContain('not run')
})
test('pane never claims unobserved stop works', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ type: 'Text', text: 'Brug nog niet gelezen; stopcontrole onbewezen.' }))?.text).toBe('Brug nog niet gelezen; stopcontrole onbewezen.')
})
