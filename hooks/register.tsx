import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Breakdown, Cat, Item, Limit, Usage } from '../types'

const PANE = 'usage-limits'
const usage = atom({ plugin: 'usage-limits', key: 'usage' } as const, { limits: [], ctxWindow: 0 } as Usage, {
  shape: 'usage-4',
})
const keepWarm = atom({ plugin: 'usage-limits', key: 'keepWarm' } as const, false)
const maxPings = atom({ plugin: 'usage-limits', key: 'maxPings' } as const, 4)
const open = atom({ plugin: 'usage-limits', key: 'open' } as const, '')
const pings = atom({ plugin: 'usage-limits', key: 'pings' } as const, 0)
const WINDOWS: Record<string, { name: string; ms: number }> = {
  five_hour: { name: 'Session (5h)', ms: 5 * 3600e3 },
  seven_day: { name: 'Weekly', ms: 7 * 86400e3 },
}

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const color = (p: number) => (p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green')
const bar = (p: number) => {
  const n = Math.round(Math.min(100, p) / 10)
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

// Pace compares use so far with the share of the window elapsed; the projection
// assumes the burn rate so far holds (shortcut: linear, ignores bursts and idle time).
const pace = (percent: number, resetsAt: string | undefined, windowMs: number) => {
  if (!resetsAt) return {}
  const left = Date.parse(resetsAt) - Date.now()
  const elapsed = windowMs - left
  if (elapsed < windowMs * 0.02 || percent <= 0) return { left }
  const ratio = percent / ((elapsed / windowMs) * 100)
  const toFull = ((100 - percent) / percent) * elapsed
  return {
    left,
    hint: ratio > 1.1 ? 'ahead of pace' : ratio < 0.9 ? 'under pace' : 'on pace',
    hit: toFull < left ? `hits 100% in ${dur(toFull)}` : 'safe until reset',
    isHot: toFull < left,
  }
}

const tok = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K` : String(n)

async function breakdown($: any): Promise<Breakdown | undefined> {
  const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (!b) return undefined
  return {
    cats: b.categories.map(({ name, tokens, color, kind }: Cat) => ({ name, tokens, color, kind })),
    total: b.totalTokens,
    max: b.rawMaxTokens,
    mcp: b.mcpTools.map((t: any) => ({ name: t.name, sub: t.serverName, tokens: t.tokens })),
    mem: b.memoryFiles.map((f: any) => ({ name: f.path.split('/').pop(), sub: f.type, tokens: f.tokens })),
  }
}

// Rows like /context: used categories, then buffer and free space, then deferred
// schemas (outside the window, so no percent), then collapsible MCP tools and memory files.
function ctxView({ Box, Text, Button }: any, b: Breakdown, openKey: string, toggle: (k: string) => void) {
  const w = Math.max(...b.cats.map(c => c.name.length)) + 5 // name column, then at least 5 spaces
  const row = (key: string, color: string, name: string, tokens: number, right: string, dim = false) => (
    <Text key={key} dimColor={dim}>
      <Text color={color as any}>■ {name.padEnd(w)}</Text>
      {tok(tokens).padStart(7)}  {right.padStart(8)}
    </Text>
  )
  const pct = (n: number) => `${((n / b.max) * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
  const by = (k: Cat['kind']) => b.cats.filter(c => c.kind === k)
  const p = Math.round((b.total / b.max) * 100)
  const list = (k: string, label: string, items: Item[]) => (
    <Box flexDirection="column">
      <Button key={k} label={`${openKey === k ? 'v' : '>'} ${label}  ${items.length}`} onPress={() => toggle(k)} />
      {openKey === k &&
        items.map(i => (
          <Text key={i.sub + i.name} dimColor>
            {i.name.slice(0, w + 2).padEnd(w + 2)}{tok(i.tokens).padStart(7)}
          </Text>
        ))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color(p)}>{bar(p)}</Text> {p} % genutzt · {tok(b.total)} / {b.max.toLocaleString('de-DE')}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {by('used').map(c => row(c.name, c.color, c.name, c.tokens, pct(c.tokens)))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {[...by('buffer'), ...by('free')].map(c => row(c.name, c.color, c.name, c.tokens, pct(c.tokens)))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {by('deferred').map(c => row(c.name, c.color, c.name, c.tokens, '—', true))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {list('mcp', 'MCP-Tools', b.mcp)}
        {list('mem', 'Gedächtnisdateien', b.mem)}
      </Box>
    </Box>
  )
}

async function refresh($: any, u: any) {
  const bd = await breakdown($)
  await update($, usage, prev => ({
    breakdown: bd ?? prev.breakdown,
    limits: u.rateLimits,
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    costUsd: u.cost?.usd,
    startedAt: u.startedAt ?? prev.startedAt, // a session.measure has none
  }))
}

// Limit alerts: toast once per window when it passes 80 / 90 %, and when it resets.
const seen = new Set<string>()
const lastPct: Record<string, number> = {}
function alerts($: any, limits: Limit[], isQuiet: boolean) {
  for (const l of limits) {
    const w = WINDOWS[l.kind]
    if (!w) continue
    const before = lastPct[l.kind]
    lastPct[l.kind] = l.percentUsed
    if (before !== undefined && before - l.percentUsed >= 20 && !isQuiet) {
      $.ui.toast(`${w.name} limit reset (now ${l.percentUsed}%)`)
    }
    for (const t of [90, 80]) {
      const key = `${l.kind}:${t}:${l.resetsAt}`
      if (l.percentUsed < t) continue
      if (!seen.has(key) && !isQuiet) $.ui.toast(`${w.name} limit at ${l.percentUsed}% (resets in ${dur(Date.parse(l.resetsAt ?? '') - Date.now())})`)
      seen.add(key)
      break
    }
  }
}

// Cache keep-alive: a fork over the session's own transcript re-reads the cached
// prefix, which renews its 1h lifetime. Each ping bills one cache read of the whole
// context plus a one-word reply.
// Stops after maxPings pings with no real turn in between (set in the tab).
const PING_MS = 50 * 60e3
let lastTurnAt = 0
let timer: { cancel: () => void } | undefined

async function ping($: any) {
  const now = await $.clock.now()
  if (now - lastTurnAt < PING_MS - 60e3) return
  const n = (await read($, pings)) + 1
  const max = await read($, maxPings)
  if (n > max) {
    await update($, keepWarm, () => false)
    timer?.cancel()
    timer = undefined
    $.ui.toast(`Cache keep-alive stopped: no activity for ~${Math.round((max * PING_MS) / 3600e3)}h`)
    return
  }
  await update($, pings, () => n)
  const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
  if (!r.isAnswered) $.ui.toast(`Cache keep-alive ping failed: ${r.reason}`)
}

function setKeepWarm($: any, isOn: boolean) {
  timer?.cancel()
  timer = isOn ? $.clock.every(PING_MS / 2, () => void ping($)) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const u = await $.session.usage()
    await refresh($, u)
    alerts($, u.rateLimits, true)
    lastTurnAt = await $.clock.now()
    setKeepWarm($, await read($, keepWarm))
    // Redraw each minute so session time and countdowns follow the clock.
    $.clock.every(60e3, () => $.ui.invalidate('ui.render'))
    void $.ui.open({ id: PANE, title: 'Usage' })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e)
    alerts($, e.rateLimits, false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    lastTurnAt = await $.clock.now()
    await update($, pings, () => 0)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const u = await read($, usage)
    const openKey = await read($, open)
    const isOn = await read($, keepWarm)
    const max = await read($, maxPings)
    const limits = u.limits.filter(l => WINDOWS[l.kind])
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Context</Text>
        {u.breakdown ? ctxView({ Box, Text, Button }, u.breakdown, openKey, k => update($, open, () => (openKey === k ? '' : k))) : u.ctxPercent === undefined ? (
          <Text dimColor>no reading yet</Text>
        ) : (
          <Text>
            <Text color={color(u.ctxPercent)}>{bar(u.ctxPercent)}</Text> {u.ctxPercent}%
            {u.ctxTokens ? ` · ${Math.round(u.ctxTokens / 1000)}k / ${Math.round(u.ctxWindow / 1000)}k` : ''}
          </Text>
        )}
        <Box marginTop={1}><Text bold color="cyan">Session time</Text></Box>
        <Text>{u.startedAt ? dur(Date.now() - u.startedAt) : 'n/a'}</Text>
        <Box marginTop={1}><Text bold color="cyan">Session cost</Text></Box>
        <Text>{u.costUsd === undefined ? 'n/a' : `$${u.costUsd.toFixed(2)} (estimate)`}</Text>
        {limits.length === 0 && <Text dimColor>No subscription limits yet.</Text>}
        {limits.map(l => {
          const w = WINDOWS[l.kind]!
          const p = pace(l.percentUsed, l.resetsAt, w.ms)
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="cyan">{w.name}</Text>
              <Text>
                <Text color={color(l.percentUsed)}>{bar(l.percentUsed)}</Text> {l.percentUsed}%
              </Text>
              {p.left !== undefined && <Text dimColor>resets in {dur(p.left)}</Text>}
              {p.hint && <Text>{p.hint}</Text>}
              {p.hit && <Text color={p.isHot ? 'red' : 'green'}>{p.hit}</Text>}
            </Box>
          )
        })}
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Cache keep-alive</Text>
          <Button
            key="keepwarm"
            label={isOn ? 'on: ping every 50 min' : 'off'}
            onPress={async () => {
              await update($, keepWarm, () => !isOn)
              await update($, pings, () => 0)
              setKeepWarm($, !isOn)
            }}
          />
          <Input
            key="maxpings"
            label="Max idle pings (1-48)"
            value={String(max)}
            submitLabel="save"
            onSubmit={async v => {
              const n = Number(v)
              if (!Number.isInteger(n) || n < 1 || n > 48) return $.ui.toast('Max idle pings: whole number 1-48')
              await update($, maxPings, () => n)
            }}
          />
        </Box>
      </Box>
    )
  })
}
