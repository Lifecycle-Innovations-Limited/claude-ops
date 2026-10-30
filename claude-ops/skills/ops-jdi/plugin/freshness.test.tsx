import { test, expect } from 'claude-code/testing'
import { setup, pane, command } from './test-support'

test('pane exposes last successful refresh and open criteria', async ($, on) => {
  const f = setup(on)
  f.state.outcomes = { required: { dod: 'Deliver required effect', evidence: [], needsReconciliation: false } }
  await $.command.run(command('status'))
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ type: 'Text', text: 'required: Deliver required effect · bewijs 0' }))?.text).toBe('required: Deliver required effect · bewijs 0')
})
test('failed refresh explicitly marks cached panel stale', async ($, on) => {
  const f = setup(on)
  await $.command.run(command('status'))
  f.reply.exitCode = 1
  await $.command.run(command('status'))
  const ui = await $.ui.mount(pane)
  expect((await ui.find({ type: 'Text', text: 'Verouderde gegevens; verversen mislukt.' }))?.text).toBe('Verouderde gegevens; verversen mislukt.')
})
