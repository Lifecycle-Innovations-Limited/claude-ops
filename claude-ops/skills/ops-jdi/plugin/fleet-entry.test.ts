import { test, expect } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import { createFleetEntry } from './hooks/fleet-entry'

test('enabled bounded timer starts once and cancels on session end', async () => {
  const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {}
  const on = ((event: string, handler: (...args: any[]) => Promise<unknown>) => { handlers[event] = handler }) as unknown as On
  let timers = 0, cancelled = 0
  const engine = { plugin: { root: '/fixture/plugin' },
    ui: { async status() {} }, clock: { every() { timers++; return { cancel() { cancelled++ } } } },
    process: { async run() { return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {
      enabled: true, maxJudgeCalls: 1, maxOutputTokens: 100, jobsRoot: '/fixture/jobs', projectRoot: '/fixture/project',
      stateRoot: '/fixture/state', jobIds: [], sessions: {} } }), isStdoutTruncated: false, isStderrTruncated: false } } },
  } as unknown as EngineInterface
  createFleetEntry({ fleetConfigPath: '/fixture/config' }).register(on, {})
  await handlers['session.start'](engine, {}, async (e: unknown) => e)
  expect(timers).toBe(1)
  await handlers['session.end'](engine, {}, async (e: unknown) => e)
  expect(cancelled).toBe(1)
})

test('absent config path does not call any native API', async () => {
  const result = await createFleetEntry({}).runOnce({} as EngineInterface)
  expect(result.status).toBe('disabled')
})
test('private disabled config calls only secure config loader', async () => {
  let processes = 0
  const engine = { plugin: { root: '/fixture/plugin' }, process: { async run(_: unknown, input: { stdin: string }) {
    processes++; expect(JSON.parse(input.stdin).action).toBe('load-config')
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { enabled: false } }),
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  } } } as unknown as EngineInterface
  expect((await createFleetEntry({ fleetConfigPath: '/fixture/config.json' }).runOnce(engine)).status).toBe('disabled')
  expect(processes).toBe(1)
})
test('invalid config yields generic diagnosis without source/model/send', async () => {
  const engine = { plugin: { root: '/fixture/plugin' }, process: { async run() {
    return { exitCode: 1, stdout: '', stderr: 'private details', isStdoutTruncated: false, isStderrTruncated: false }
  } } } as unknown as EngineInterface
  const result = await createFleetEntry({ fleetConfigPath: '/fixture/config.json' }).runOnce(engine)
  expect(result.status).toBe('uncertain')
  expect(JSON.stringify(result)).not.toContain('private details')
})
