import { test, expect } from 'claude-code/testing'
import { setup, pane, command } from './test-support'

test('all surfaces retain pause control', async ($, on) => {
  const f = setup(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'toggle' })
    expect(f.state.paused).toBe(true)
    await $.command.run(command('resume'))
    await ui.unmount()
  }
})
test('prompt passes untouched without mega injection', async ($, on) => {
  setup(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const r = await $.prompt.submit({ text: 'Question', context: ['existing'], wait: false, origin: { kind: 'composer' } })
  expect(r.text).toBe('Question')
  expect(r.context).toEqual(['existing'])
})
test('module never intercepts native Stop', async ($, on) => {
  const f = setup(on)
  on('classic.Stop', () => ({ additionalContext: ['existing'] }))
  expect((await $.classic.Stop({ stop_hook_active: true })).additionalContext).toEqual(['existing'])
  expect(f.actions).toEqual([])
})
test('no bridge response from other session accepted', async ($, on) => {
  const f = setup(on)
  f.state.session_id = 'other'
  expect((await $.command.run(command('diagnose'))).text).toContain('Geen voltooiingsbewijs')
})
