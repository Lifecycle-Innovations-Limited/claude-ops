import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { createHostAdapter } from './hooks/fleet'
import type { DurableState, SnapshotProvider } from './hooks/fleet'

const state: DurableState = {
  async get() { return null }, async reserve() { return true }, async put() {},
}
function fixture() {
  const calls: unknown[] = []
  const replies = {
    listing: { listing: 'Workers', sections: [{ kind: 'sessions', total: 1, rows: [{ id: 'worker' }] }] },
    answered: true, text: '{"verdict":"ONZEKER","usage":{"input_tokens":999}}', delivered: true,
  }
  // Explicit test double boundary, not a claim to implement the entire host.
  const engine = {
    session: { async id() { return 'supervisor' }, async model() { return 'fixture-model' },
      async send(input: unknown) { calls.push(input); return replies.delivered ? { isDelivered: true } :
        { isDelivered: false, reason: 'recipient gone' } } },
    tool: { async call(input: unknown) { calls.push(input); return { result: replies.listing, ref: 'tool-receipt' } } },
    model: { async complete(input: unknown) { calls.push(input); return replies.answered ?
      { isAnswered: true, text: replies.text, usage: { input_tokens: 12, output_tokens: 3 } } :
      { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0 } } } },
  } as unknown as EngineInterface
  const provider: SnapshotProvider = {
    async inventory(_, self, ref) {
      expect(self).toBe('supervisor'); expect(ref).toBe('tool-receipt')
      return { enumerationId: 'scan', sessions: ['worker'], nextCursor: null, complete: true, total: 1, gaps: [] }
    },
    async readSnapshot(sessionId) { return { sessionId, schemaVersion: 1 } },
    async binding(snapshot) { return { sessionId: snapshot.sessionId, generation: snapshot.generation,
      contractHash: snapshot.contractHash, evidenceSetHash: snapshot.evidenceSetHash,
      transcriptIdentity: snapshot.transcriptIdentity, snapshotHash: 'coordinator-content-hash' } },
    async checkAndEnqueue(_, enqueue) { await enqueue(); return true },
  }
  return { calls, replies, provider, host: createHostAdapter(engine, provider, state) }
}
const action = { ownerSessionId: 'worker', kind: 'continue', text: 'Inspect the result' }
const expected = { sessionId: 'worker', expiresAt: Date.now() / 1000 + 300 }

test('native inventory passes source receipt to scoped provider', async () => {
  const f = fixture()
  expect((await f.host.list_sessions(null)).complete).toBe(true)
  expect((await f.host.read_snapshot('worker')).sessionId).toBe('worker')
  expect(f.host.state).toBe(state)
  expect((f.calls[0] as { tool: string }).tool).toBe('ListAgents')
})
test('incomplete native section never claims full coverage', async () => {
  const f = fixture(); f.replies.listing.sections[0].total = 2
  expect((await f.host.list_sessions(null)).complete).toBe(false)
})
test('model completion uses native usage and provenance', async () => {
  const f = fixture()
  const snapshot = { schemaVersion: 1, sessionId: 'worker', generation: 1,
    contractHash: 'contract-a', evidenceSetHash: 'evidence-a', transcriptIdentity: 'transcript-a',
    observedAt: 100, paused: false, stopped: false, approval: 'clear',
    owner: { state: 'known', sessionId: 'worker', refs: ['message:request'] },
    authority: { state: 'authorized', contractHash: 'contract-a', refs: ['message:request'] },
    eligibility: { state: 'stalled', refs: ['receipt:progress'] },
    coverage: { complete: true, gaps: [], messageCount: 1, receiptCount: 1,
      transcriptIdentity: 'transcript-a', messageIds: ['request'], receiptIds: ['progress'] },
    messages: [{ id: 'request', role: 'user', origin: 'human', text: 'Build and demonstrate output' }],
    receipts: [{ id: 'progress', text: 'Output missing' }] }
  const result = await f.host.judge(snapshot, 'Return binding unchanged')
  const sent = JSON.parse((f.calls[0] as { prompt: string }).prompt)
  expect(sent.snapshot.sessionId).toBe(snapshot.sessionId)
  expect(sent.snapshot.messages[0].origin).toBe('human')
  expect(sent.binding.snapshotHash).toBe('coordinator-content-hash')
  expect(sent.binding.generation).toBe(snapshot.generation)
  expect((result.reviewerProvenance as { requestId?: string }).requestId).toBe(undefined)
  expect(typeof (result.reviewerProvenance as { correlationId: string }).correlationId).toBe('string')
  expect((result.usage as { input_tokens: number }).input_tokens).toBe(12)
  expect((result.reviewerProvenance as { model: string }).model).toBe('fixture-model')
})
test('native queue acceptance is never delivered or read proof', async () => {
  const f = fixture(); const result = await f.host.nudge('worker', action, expected, 'key')
  expect(f.calls.length).toBe(1); expect(result.status).toBe('queued'); expect(result.receiptRef).toBe(null)
})
test('provider refusal sends nothing', async () => {
  const f = fixture(); f.provider.checkAndEnqueue = async () => false
  expect((await f.host.nudge('worker', action, expected, 'key')).status).toBe('refused')
  expect(f.calls.length).toBe(0)
})
test('provider success without enqueue is unknown', async () => {
  const f = fixture(); f.provider.checkAndEnqueue = async () => true
  expect((await f.host.nudge('worker', action, expected, 'key')).status).toBe('unknown')
})
test('native refusal is retained', async () => {
  const f = fixture(); f.replies.delivered = false
  expect((await f.host.nudge('worker', action, expected, 'key')).status).toBe('refused')
})
