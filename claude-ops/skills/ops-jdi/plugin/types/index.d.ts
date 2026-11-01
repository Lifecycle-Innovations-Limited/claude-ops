export type WorkState = {
  stopObserved: boolean
  busy: boolean
  seenWarnings: string[]
  warnings: string[]
  maintenanceQueued: boolean
  generation: number
  lastFailures: number
  cycle: number
  enabled: boolean
  phase: string
  detail: string
  next: string
  evidence: string
  continuations: number
  tools: number
  failures: number
  lastTools: number
  stalled: number
  lastStep: string
  interrupted: boolean
  refreshedAt?: number
  stale?: boolean
  bridge?: BridgeState
  promptObservation?: {
    sessionId: string
    sequence: number
    generation: number
    promptHash: string
    observationId: string
    turnId?: string
    origin: { kind: string }
    isMeta: boolean
    human: boolean
    authorityTransport: 'unavailable'
  }
}

export type BridgeState = {
  schemaVersion: number
  session_id: string
  revision: number
  generation: number
  observationRevision?: number
  promptBindingPending?: boolean
  paused: boolean
  interrupted: boolean
  phase: string
  next: string
  stopInvocations: number
  continuations: number
  integration: string
  outcomes: Record<string, unknown>
  tasks: Record<string, unknown>
  incidents: Record<string, unknown>
  deliveries?: Record<string, unknown>
  fixes?: unknown[]
  audit?: { generation: number, requests: number, acceptance: 'none', answered: boolean, verdict: string, reason: string, stale?: boolean } | null
}

declare module 'claude-code' {
  interface PluginState {
    'just-do-it': { work: Shaped<WorkState> }
  }
}
