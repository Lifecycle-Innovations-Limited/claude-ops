import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { createFleetRuntime } from './hooks/fleet-runtime'

const config = { enabled: true, maxJudgeCalls: 10, maxOutputTokens: 1024, jobsRoot: '/fixture/jobs', projectRoot: '/fixture/projects',
  stateRoot: '/fixture/private-state', jobIds: ['job-a'], sessions: { worker: 'session-a' }, allowedToolResultIds: [] }
function fixture() {
  const actions: string[] = [], records = new Map<string, unknown>()
  let models = 0, sends = 0
  const source = { eligible: false }
  const engine = {
    plugin: { root: '/fixture/plugin' },
    session: { async id() { return 'supervisor' }, async model() { return 'fixture-model' },
      async send() { sends++; return { isDelivered: true } } },
    tool: { async call() { return { result: { listing: 'fixture', sections: [
      { kind: 'sessions', total: 1, rows: [{ id: 'worker' }] }] } } } },
    process: { async run(argv: string[], input: { stdin: string }) {
      expect(argv[0]).toBe('python3'); expect(argv[1]).toBe('-I')
      const request = JSON.parse(input.stdin); actions.push(request.action)
      let result: unknown = null
      switch (request.action) {
        case 'snapshot': result = { sessionId: 'session-a', generation: 1, contractHash: 'c', evidenceSetHash: 'e',
          transcriptIdentity: 't', messages: [], receipts: [], authority: { state: 'unknown' } }; break
        case 'binding': result = { sessionId: 'session-a', generation: 1, contractHash: 'c', evidenceSetHash: 'e',
          transcriptIdentity: 't', snapshotHash: 'fixture-hash' }; break
        case 'eligible': result = { eligible: source.eligible }; break
        case 'instructions': result = { instructions: 'Review transcript and return binding unchanged' }; break
        case 'get': result = records.get(request.key) ?? null; break
        case 'reserve': result = { reserved: !records.has(request.key) }; records.set(request.key, request.record); break
        case 'put': records.set(request.key, request.record); result = { written: true }; break
        case 'validate-snapshot': case 'validate-judgment': result = { valid: true }; break
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '',
        isStdoutTruncated: false, isStderrTruncated: false }
    } },
    model: { async complete(request: { prompt: string }) {
      models++
      const input = JSON.parse(request.prompt)
      expect(input.binding.snapshotHash).toBe('fixture-hash')
      return { isAnswered: true, text: JSON.stringify({ schemaVersion: 1, binding: input.binding,
        verdict: 'ONZEKER', expiresAt: Date.now() / 1000 + 60 }), usage: { input_tokens: 1, output_tokens: 1 } }
    } },
  } as unknown as EngineInterface
  return { engine, actions, source, counts: () => ({ models, sends }) }
}

test('standalone runtime captures, judges, validates and rechecks without native authority', async () => {
  const f = fixture(), runtime = createFleetRuntime(config)
  const report = await runtime.runOnce(f.engine)
  expect(report.status).toBe('uncertain')
  expect(f.actions).toContain('snapshot'); expect(f.actions).toContain('validate-judgment')
  expect(f.counts().models).toBe(1); expect(f.counts().sends).toBe(0)
  await runtime.runOnce(f.engine)
  expect(f.counts().models).toBe(1)
})
test('proven advisory eligibility queues once and never claims read', async () => {
  const f = fixture(); f.source.eligible = true
  const runtime = createFleetRuntime(config)
  const report = await runtime.runOnce(f.engine)
  expect((report.sessions as { status: string }[])[0].status).toBe('queued')
  expect(f.counts().sends).toBe(1)
  await runtime.runOnce(f.engine)
  expect(f.counts().sends).toBe(1)
})

test('disabled runtime and incomplete config do no work', async () => {
  const f = fixture()
  expect((await createFleetRuntime({ ...config, enabled: false }).runOnce(f.engine)).status).toBe('disabled')
  expect((await createFleetRuntime({ ...config, jobIds: [] }).runOnce(f.engine)).status).toBe('uncertain')
  expect(f.actions.length).toBe(0); expect(f.counts().models).toBe(0)
})
