export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  limits: Limit[]
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  costUsd?: number
  startedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': { usage: Shaped<Usage>; keepWarm: boolean; pings: number; maxPings: number }
  }
}
