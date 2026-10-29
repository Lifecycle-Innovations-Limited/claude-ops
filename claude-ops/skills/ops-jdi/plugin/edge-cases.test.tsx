import { test, expect } from 'claude-code/testing'
import { setup, pane, command } from './test-support'

test('pane button writes bridge pause', async ($, on) => {
  const f = setup(on)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'toggle' })
  expect(f.state.paused).toBe(true)
})
test('refresh uses existing session only', async ($, on) => {
  const f = setup(on)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' })
  expect(f.actions).toEqual(['status'])
})
test('failed bridge diagnosis never claims completion', async ($, on) => {
  const f = setup(on)
  f.reply.exitCode = 1
  expect((await $.command.run(command('diagnose'))).text).toContain('Geen voltooiingsbewijs')
})
test('malformed bridge is contained', async ($, on) => {
  const f = setup(on)
  f.reply.malformed = true
  expect((await $.command.run(command('diagnose'))).text).toContain('brugdiagnose')
})
