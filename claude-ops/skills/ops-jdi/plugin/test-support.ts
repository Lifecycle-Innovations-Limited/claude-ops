import type { On } from 'claude-code'
export const pane = { plugin: 'just-do-it', component: 'Pane', requestId: 'just-do-it', surface: 'terminal', props: {
  title: 'Just Do It', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {},
} } as const
export function setup(on: On) {
  const actions: string[] = []
  const state: Record<string, any> = { schemaVersion: 1, session_id: 'fixture', revision: 1, generation: 1, paused: false,
    interrupted: false, phase: 'reconcile intent', next: 'Inspect required outcome', stopInvocations: 0,
    continuations: 0, integration: 'not run', outcomes: {}, tasks: {}, incidents: {}, audit: null }
  const reply = { exitCode: 0, stdout: '', stderr: '', malformed: false }
  // Every model entry point is counted so tests can prove the cost guard.
  const model = { fork: 0, complete: 0, classify: 0, prompts: [] as string[], forkReply: undefined as any, forkThrows: false }
  const stdins: string[] = []
  // Per-action stdout overrides so a test can script a bridge reply.
  const replies: Record<string, any> = {}
  on('model.fork', (_, e) => {
    model.fork++
    model.prompts.push(e.prompt)
    if (model.forkThrows) throw new Error('fork unavailable')
    return { value: model.forkReply ?? { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('model.complete', () => { model.complete++; return { value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
  on('model.classify', () => { model.classify++; return { value: undefined } })
  on('session.id', () => ({ value: 'fixture' }))
  on('command.register', () => ({ value: { command: 'just-do-it' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const action = e.argv[3]
    if (action === undefined) return { value: { exitCode: reply.exitCode, stdout: '', stderr: reply.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
    actions.push(action)
    if (e.init?.stdin !== undefined) stdins.push(e.init.stdin)
    if (action === 'audit-record') {
      const input = JSON.parse(e.init?.stdin ?? '{}')
      state.audit = { generation: input.generation, requests: (state.audit?.requests ?? 0) + 1, acceptance: 'none',
        answered: Boolean(input.verdict), verdict: input.verdict ?? '', reason: input.reason ?? '' }
    }
    if (['pause', 'resume', 'interrupt'].includes(action)) {
      state.generation++
      state.paused = action !== 'resume'
      state.interrupted = action === 'interrupt'
      state.phase = state.paused ? 'paused' : 'reconcile intent'
    }
    return { value: { exitCode: reply.exitCode, stdout: reply.malformed ? '{bad' : JSON.stringify(replies[action] ?? state), stderr: reply.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { state, actions, reply, model, stdins, replies }
}
export const command = (args: string) => ({ command: 'just-do-it', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })
