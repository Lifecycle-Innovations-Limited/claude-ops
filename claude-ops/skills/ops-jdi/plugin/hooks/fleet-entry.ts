import type { EngineInterface, Register } from 'claude-code'
import { runFleetOnce } from './fleet-runtime'
import type { FleetRuntimeConfig } from './fleet-runtime'

/** Optional entry only: caller provides a private config path. No global setup.
 * Every function that receives `$` is a top-level declaration, as the host requires. */
type FleetState = {
  path?: string
  timer?: { cancel(): void }
  end: boolean
  tick?: () => void
  running: boolean
}

function newState(path?: string): FleetState {
  return { path, end: false, running: false }
}

function stopTimer(st: FleetState) {
  st.timer?.cancel()
  st.timer = undefined
}

async function fleetRunOnce($: EngineInterface, st: FleetState) {
  if (!st.path) return { status: 'disabled' }
  try {
    const reply = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/fleet-source.py`],
      { timeoutMs: 10000, stdin: JSON.stringify({ action: 'load-config', path: st.path }) })
    if (reply.exitCode !== 0 || reply.isStdoutTruncated || reply.isStderrTruncated) throw new Error('config refused')
    const parsed = JSON.parse(reply.stdout)
    if (parsed.ok !== true) throw new Error('config invalid')
    const config = parsed.result as FleetRuntimeConfig
    if (config.enabled !== true || config.maxJudgeCalls === 0) {
      stopTimer(st)
      return { status: 'disabled' }
    }
    if (!st.end && st.tick && !st.timer) st.timer = $.clock.every(60000, st.tick)
    return await runFleetOnce($, config)
  } catch {
    stopTimer(st)
    return { status: 'uncertain', gaps: ['Fleet configuration/source diagnosis required'] }
  }
}

async function fleetInspect($: EngineInterface, st: FleetState) {
  if (st.running) return
  st.running = true
  try {
    const report = await fleetRunOnce($, st)
    if (report.status !== 'disabled') await $.ui.status(`Fleet guard: ${report.status}`)
  } finally { st.running = false }
}

async function fleetBegin($: EngineInterface, st: FleetState) {
  stopTimer(st)
  st.end = false
  st.tick = () => { void fleetInspect($, st).catch(() => stopTimer(st)) }
  await fleetInspect($, st)
}

async function fleetAfterTurn($: EngineInterface, st: FleetState, agentId: unknown, aborted: unknown, reason: unknown) {
  if (agentId === undefined && !aborted && !['aborted', 'refusal', 'error'].includes(String(reason))) await fleetInspect($, st)
}

export function createFleetEntry(options: { fleetConfigPath?: string }) {
  const st = newState(options.fleetConfigPath)
  const register: Register = on => {
    on('session.start', async ($, e, next) => { const result = await next(e); await fleetBegin($, st); return result })
    on('session.end', async (_, e, next) => { st.end = true; stopTimer(st); return next(e) })
    on('turn.complete', async ($, e, next) => {
      const result = await next(e)
      await fleetAfterTurn($, st, e.agentId, e.isAborted, e.reason)
      return result
    })
  }
  return { runOnce: ($: EngineInterface) => fleetRunOnce($, st), register }
}

/** Shared-state entry for register.tsx, which owns the session.start/end/turn.complete hooks. */
let shared = newState()
export function configureFleet(fleetConfigPath: unknown) {
  shared = newState(typeof fleetConfigPath === 'string' ? fleetConfigPath : undefined)
}
export async function fleetStart($: EngineInterface) { await fleetBegin($, shared) }
export function fleetEnd() { shared.end = true; stopTimer(shared) }
export async function fleetComplete($: EngineInterface, agentId: unknown, aborted: unknown, reason: unknown) {
  await fleetAfterTurn($, shared, agentId, aborted, reason)
}
