import { test, expect } from 'claude-code/testing'
import { setup } from './test-support'

for (const origin of [{ kind: 'composer' }, { kind: 'peer', sessionId: 'peer' }, { kind: 'unclassified' }, { kind: 'plugin', plugin: 'fixture' }] as const) {
  for (const isMeta of [undefined, true] as const) {
    test(`pinned ${origin.kind} meta=${String(isMeta)} observation forwards unchanged`, async ($, on) => {
      const f = setup(on)
      let forwarded = ''
      let observed: { origin?: { kind: string }, human?: boolean, isMeta?: boolean, promptHash?: string, generation?: number, observationId?: string, authorityTransport?: string } | undefined
      on('state.set', (_, e, next) => {
        const value = e.value as { value?: { promptObservation?: typeof observed } }
        observed = value.value?.promptObservation
        return next(e)
      })
      on('prompt.submit', (_, e) => { forwarded = e.text; return { text: e.text } })
      // Testing host supplies these fields; production $.prompt.submit cannot
      // stamp an origin. These fixtures prove handling, not live attestation.
      const result = await $.prompt.submit({ text: 'Machine notification', wait: false, origin, isMeta })
      expect(result).toEqual({ text: 'Machine notification' })
      expect(forwarded).toBe('Machine notification')
      expect(observed?.origin?.kind).toBe(origin.kind)
      expect(observed?.human).toBe(origin.kind === 'composer' && isMeta !== true)
      expect(observed?.isMeta).toBe(isMeta === true)
      expect(observed?.promptHash).toBe('d459fd036a623e871962610ad6d4715b0e953b74d454d9b1ca2c76be637b03e5')
      expect(observed?.generation).toBe(0)
      expect(observed?.observationId).toContain('fixture:0:1:')
      expect(observed?.authorityTransport).toBe('unavailable')
      expect(f.actions).toEqual([])
      expect(f.stdins).toEqual([])
    })
  }
}
