import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Usage } from '../types'

const PANE = 'usage-limits'
const usage = atom({ plugin: 'usage-limits', key: 'usage' } as const, { limits: [], ctxWindow: 0 } as Usage, {
  shape: 'usage-3',
})
const keepWarm = atom({ plugin: 'usage-limits', key: 'keepWarm' } as const, false)
const maxPings = atom({ plugin: 'usage-limits', key: 'maxPings' } as const, 4)
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

async function refresh($: any, u: any) {
  await update($, usage, prev => ({
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
    const isOn = await read($, keepWarm)
    const max = await read($, maxPings)
    const limits = u.limits.filter(l => WINDOWS[l.kind])
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Context</Text>
        {u.ctxPercent === undefined ? (
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
