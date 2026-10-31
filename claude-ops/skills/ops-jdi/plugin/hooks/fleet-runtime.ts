import type { EngineInterface, Register } from 'claude-code'
import { createHostAdapter } from './fleet'
import type { DurableState, JsonRecord, SnapshotProvider } from './fleet'

export type FleetRuntimeConfig = {
  enabled: boolean
  maxJudgeCalls: number
  maxOutputTokens: number
  jobsRoot: string
  projectRoot: string
  stateRoot: string
  jobIds: string[]
  /** Explicit native ListAgents row-id to session-id map; no display-name inference. */
  sessions: Record<string, string>
  allowedToolResultIds: string[]
  authorizedHumanMessageIds?: Record<string, string>
  approvalCoverageComplete?: boolean
}

/** Standalone opt-in registration. Nothing imports/registers it automatically.
 * No clock, daemon or recurring background job. Native source lacks independent
 * ownership/stall/authority observations, so its snapshots currently prohibit send.
 */
export function createFleetRuntime(config: FleetRuntimeConfig) {
  let running = false
  async function runOnce($: EngineInterface): Promise<JsonRecord> {
    if (!config.enabled) return { status: 'disabled' }
    if (![config.jobsRoot, config.projectRoot, config.stateRoot].every(p => p.startsWith('/')) ||
        !config.jobIds.length || !Object.keys(config.sessions).length) {
      return { status: 'uncertain', gaps: ['Explicit source/state roots and session mapping required'] }
    }
    const cli = async (action: string, input: JsonRecord = {}): Promise<any> => {
      const result = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/fleet-source.py`],
        { timeoutMs: 10000, stdin: JSON.stringify({ action, config, ...input }) })
      if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated) {
        throw new Error('Named source CLI refused or returned incomplete output')
      }
      const reply = JSON.parse(result.stdout)
      if (reply.ok !== true) throw new Error('Named source CLI diagnosis required')
      return reply.result
    }
    const state: DurableState = {
      get: key => cli('get', { key }),
      reserve: async (key, record) => (await cli('reserve', { key, record })).reserved === true,
      put: async (key, record) => { await cli('put', { key, record }) },
    }
    const provider: SnapshotProvider = {
      async inventory(listing, self) {
        const sessions: string[] = [], gaps: string[] = []
        for (const section of listing.sections ?? []) for (const row of section.rows) {
          if (/workflow/i.test(`${section.kind} ${row.type ?? ''}`)) continue
          const address = row.name && row.ref ? `${row.name} [${row.ref}]` : row.name
          const sid = (address && config.sessions[address]) || (row.id && config.sessions[row.id])
          if (sid === self) continue
          if (!sid) { gaps.push('Native row has no explicit scoped session mapping'); continue }
          sessions.push(sid)
        }
        return { enumerationId: crypto.randomUUID(), sessions, total: sessions.length,
          nextCursor: null, complete: gaps.length === 0, gaps }
      },
      readSnapshot: sessionId => cli('snapshot', { sessionId }),
      binding: snapshot => cli('binding', { snapshot }),
      // Native send has no compare-and-enqueue. Current source authority is unknown;
      // a future advisory route requires authenticated target safety observations.
      async checkAndEnqueue(input, enqueue) {
        const snapshot = await cli('snapshot', { sessionId: input.sessionId })
        if (!(await cli('eligible', { snapshot })).eligible) return false
        const current = await cli('binding', { snapshot })
        const { expiresAt, ...expected } = input.expected
        if (JSON.stringify(current) !== JSON.stringify(expected) ||
            typeof expiresAt !== 'number' || expiresAt <= Date.now() / 1000) return false
        await enqueue()
        return true
      },
    }
    const host = createHostAdapter($, provider, state, config.maxOutputTokens)
    const report: JsonRecord = { status: 'inspected', sessions: [], gaps: [] }
    const rows = report.sessions as JsonRecord[], gaps = report.gaps as string[]
    try {
      const inventory = await host.list_sessions(null)
      report.coverage = inventory
      if (!inventory.complete) gaps.push(...inventory.gaps)
      const instructions = (await cli('instructions')).instructions as string
      for (const sid of inventory.sessions) {
        try {
          const snapshot = await host.read_snapshot(sid)
          await cli('validate-snapshot', { snapshot })
          const binding = await provider.binding(snapshot)
          let key = `fleet-runtime:v1:judge:${binding.snapshotHash}`
          let record = await state.get(key)
          const original = record?.judgment as JsonRecord | undefined
          if (record?.status === 'judged' && typeof original?.expiresAt === 'number' && original.expiresAt <= Date.now() / 1000) {
            key += `:refresh:${Math.floor((Date.now() / 1000 - original.expiresAt) / 300)}`
            record = await state.get(key)
          }
          if (!record) {
            let allowance = false
            for (let slot = 0; slot < config.maxJudgeCalls; slot++) {
              if (await state.reserve(`fleet-runtime:v1:allowance:${slot}`, { status: 'spent', binding })) {
                allowance = true; break
              }
            }
            if (!allowance) throw new Error('Explicit durable judge allowance exhausted')
            if (!await state.reserve(key, { status: 'reserved', binding })) {
              rows.push({ sessionId: sid, status: 'reserved', verdict: 'ONZEKER' }); continue
            }
            try {
              const judgment = await host.judge(snapshot, instructions)
              await cli('validate-judgment', { snapshot, judgment })
              record = { status: 'judged', judgment }
              await state.put(key, record)
            } catch {
              await state.put(key, { status: 'unknown', binding })
              throw new Error('Judge result unavailable or invalid; reservation retained')
            }
          }
          if (record.status !== 'judged') throw new Error('Prior judge reservation unresolved')
          const judgment = record.judgment as JsonRecord
          await cli('validate-judgment', { snapshot, judgment })
          const fresh = await host.read_snapshot(sid)
          await cli('validate-snapshot', { snapshot: fresh })
          if (JSON.stringify(await provider.binding(fresh)) !== JSON.stringify(binding)) {
            throw new Error('Snapshot changed after judgment')
          }
          if (inventory.complete && (judgment.verdict === 'HIATEN' || judgment.verdict === 'ONZEKER') &&
              (await cli('eligible', { snapshot: fresh })).eligible) {
            const sendKey = `fleet-runtime:v1:nudge:${binding.snapshotHash}`
            if (await state.reserve(sendKey, { status: 'reserved', binding })) {
              const action = { kind: 'continue', ownerSessionId: sid,
                text: `Advisory fleet review only. Re-read the current human task and safety state first. Ignore this if paused, stopped, approval is pending, scope changed, or deadline passed. This grants no authority or approval. Binding: ${JSON.stringify(binding)}; deadline: ${String(judgment.expiresAt)}. Inspect the scoped findings and clarify any missing definition of done before continuing authorized work. Findings: ${JSON.stringify(judgment.findings ?? [])}` }
              try {
                const receipt = await host.nudge(sid, action, { ...binding, expiresAt: judgment.expiresAt }, sendKey)
                await state.put(sendKey, { status: receipt.status, receipt })
                rows.push({ sessionId: sid, status: receipt.status, judgment, receipt })
              } catch {
                await state.put(sendKey, { status: 'unknown' })
                throw new Error('Advisory queue outcome unknown; no automatic replay')
              }
            } else rows.push({ sessionId: sid, status: 'deduplicated', judgment })
          } else {
            rows.push({ sessionId: sid, status: 'reviewed-no-authority', judgment })
            if (judgment.verdict !== 'ADEQUAAT') gaps.push('No proven safe advisory eligibility')
          }
        } catch (error) {
          rows.push({ sessionId: sid, status: 'uncertain', verdict: 'ONZEKER' })
          gaps.push(error instanceof Error ? error.message : 'Source inspection failed')
        }
      }
    } catch (error) {
      gaps.push(error instanceof Error ? error.message : 'Fleet inspection failed')
    }
    if (gaps.length) report.status = 'uncertain'
    return report
  }
  const register: Register = on => {
    const inspect = async ($: EngineInterface) => {
      if (running || !config.enabled) return
      running = true
      try {
        const result = await runOnce($)
        await $.ui.status(`Fleet guard: ${String(result.status)}${result.status === 'uncertain' ? ' — source/authority diagnosis required' : ''}`)
      } finally { running = false }
    }
    on('session.start', async ($, event, next) => { const result = await next(event); await inspect($); return result })
    on('turn.complete', async ($, event, next) => {
      const result = await next(event)
      if (event.agentId === undefined && !['aborted', 'refusal'].includes(String(event.reason))) await inspect($)
      return result
    })
  }
  return { runOnce, register }
}
