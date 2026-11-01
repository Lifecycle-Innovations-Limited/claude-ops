import { test, expect, mock } from 'claude-code/testing'
import { setup, command } from './test-support'

test('healthy idle starts no prompts or model work', async ($, on) => {
  const clock = mock.clock(on)
  const f = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(180000)
  expect(f.actions).toEqual(['status'])
})
test('classic downstream decision is unchanged', async ($, on) => {
  setup(on)
  on('classic.Stop', () => ({ preventContinuation: true, block: 'existing approval' }))
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(r.preventContinuation).toBe(true)
  expect(r.block).toBe('existing approval')
})
test('diagnosis does not invoke remediation', async ($, on) => {
  const f = setup(on)
  await $.command.run(command('diagnose'))
  expect(f.actions).toEqual(['status'])
})
test('same policy notices do not selfwake', async ($, on) => {
  const clock = mock.clock(on)
  mock.session(on)
  const f = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.append({ door: 'notice', origin: { kind: 'engine' }, uuid: 'policy', message: { type: 'system', content: [{ type: 'text', text: 'just-do-it hook skipped by policy' }] } })
  await clock.advance(180000)
  expect(f.actions).toEqual(['status'])
})
