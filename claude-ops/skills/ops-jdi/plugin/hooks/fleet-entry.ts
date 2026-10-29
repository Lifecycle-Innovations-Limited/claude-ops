import type { EngineInterface, Register } from 'claude-code'
import { createFleetRuntime } from './fleet-runtime'
import type { FleetRuntimeConfig } from './fleet-runtime'

/** Optional entry only: caller provides a private config path. No global setup. */
export function createFleetEntry(options: { fleetConfigPath?: string }) {
  let timer: { cancel(): void } | undefined
  let end = false
  let tick: (() => void) | undefined
  async function runOnce($: EngineInterface) {
    if (!options.fleetConfigPath) return { status: 'disabled' }
    try {
      const reply = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/fleet-source.py`],
        { timeoutMs: 10000, stdin: JSON.stringify({ action: 'load-config', path: options.fleetConfigPath }) })
      if (reply.exitCode !== 0 || reply.isStdoutTruncated || reply.isStderrTruncated) throw new Error('config refused')
      const parsed = JSON.parse(reply.stdout)
      if (parsed.ok !== true) throw new Error('config invalid')
      const config = parsed.result as FleetRuntimeConfig
      if (config.enabled !== true || config.maxJudgeCalls === 0) {
        timer?.cancel(); timer = undefined
        return { status: 'disabled' }
      }
      if (!end && tick && !timer) timer = $.clock.every(60000, tick)
      return await createFleetRuntime(config).runOnce($)
    } catch {
      timer?.cancel(); timer = undefined
      return { status: 'uncertain', gaps: ['Fleet configuration/source diagnosis required'] }
    }
  }
  let running = false
  const register: Register = on => {
    const inspect = async ($: EngineInterface) => {
      if (running) return
      running = true
      try { const report = await runOnce($); if (report.status !== 'disabled') await $.ui.status(`Fleet guard: ${report.status}`) }
      finally { running = false }
    }
    on('session.start', async ($, e, next) => {
      const result = await next(e)
      timer?.cancel(); timer = undefined; end = false
      tick = () => { void inspect($).catch(() => { timer?.cancel(); timer = undefined }) }
      await inspect($)
      return result
    })
    on('session.end', async (_, e, next) => { end = true; timer?.cancel(); timer = undefined; return next(e) })
    on('turn.complete', async ($, e, next) => {
      const result = await next(e)
      if (e.agentId === undefined && !e.isAborted && !['aborted', 'refusal', 'error'].includes(String(e.reason))) await inspect($)
      return result
    })
  }
  return { runOnce, register }
}

export const register: Register = (on, options) => createFleetEntry({
  fleetConfigPath: typeof options.fleetConfigPath === 'string' ? options.fleetConfigPath : undefined,
}).register(on, options)
