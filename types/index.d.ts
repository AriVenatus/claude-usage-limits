export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Cat = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type Item = { name: string; sub: string; tokens: number }
export type Breakdown = { cats: Cat[]; total: number; max: number; mcp: Item[]; mem: Item[] }
export type Usage = {
  breakdown?: Breakdown
  limits: Limit[]
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  costUsd?: number
  startedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': { usage: Shaped<Usage>; keepWarm: boolean; open: string; pings: number; maxPings: number }
  }
}
