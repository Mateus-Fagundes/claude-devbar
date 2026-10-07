// The line's meter (context, 5-hour and weekly quota, cost), prompt cache and relative times.
import type { Lang, MeterView, StatusLine, UsageLimit } from '../../types'
import { TEXT } from './text'

// Claude Code reserves ~16.5% of the window for auto-compact.
const AUTOCOMPACT_BUFFER_PCT = 16.5
const BAR_CELLS = 10
const ALERT_AT_PCT = 80
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

export const VIEWS: readonly MeterView[] = ['context', 'five_hour', 'seven_day', 'cost']

export function usablePercent(rawPercent: number): number {
  const remaining = 100 - rawPercent
  const usableRemaining = Math.max(0, ((remaining - AUTOCOMPACT_BUFFER_PCT) / (100 - AUTOCOMPACT_BUFFER_PCT)) * 100)
  return Math.max(0, Math.min(100, Math.round(100 - usableRemaining)))
}

// Tokens left before auto-compact kicks in (the same 16.5% reserve as the bar).
export function tokensToCompact(tokens: number, window: number): number {
  return Math.max(0, Math.round(window * (1 - AUTOCOMPACT_BUFFER_PCT / 100) - tokens))
}

// "1.2M", "45k", "800".
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export const CACHE_TTL_MS = { '5m': 5 * MS_PER_MINUTE, '1h': MS_PER_HOUR } as const
export type CacheTtl = keyof typeof CACHE_TTL_MS
// Below this, the cache time turns yellow: the next message will soon pay for the whole context again.
const CACHE_WARN_MS = 5 * MS_PER_MINUTE

// Time left before the prompt cache goes cold, counted from the end of the last model call.
export function cacheLeft(lastRequestAt: number | null, ttl: CacheTtl, now: number): number | undefined {
  if (lastRequestAt === null) return undefined
  return lastRequestAt + CACHE_TTL_MS[ttl] - now
}

// Note of the context meter: tokens until auto-compact (with the /compact button) and cache state.
export function contextNote(
  status: StatusLine,
  cacheMs: number | undefined,
  lang: Lang,
): { compact?: string; cache?: string; isCacheWarn: boolean } {
  const text = TEXT[lang]
  const compact =
    status.tokens !== undefined && status.window !== undefined
      ? text.toCompact(formatTokens(tokensToCompact(status.tokens, status.window)))
      : undefined
  const cache = cacheMs === undefined ? undefined : cacheMs > 0 ? text.cacheLeft(formatSpan(cacheMs)) : text.cacheCold
  const isCacheWarn = cacheMs !== undefined && cacheMs > 0 && cacheMs < CACHE_WARN_MS
  return { compact, cache, isCacheWarn }
}

export function contextBar(used: number): string {
  const filled = Math.floor(used / BAR_CELLS)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${used}%`
}

// Bar ranges: green up to 50%, yellow up to 65%, orange up to 80%, red above.
export function barColor(used: number): 'success' | 'warning' | 'claude' | 'error' {
  if (used < 50) return 'success'
  if (used < 65) return 'warning'
  if (used < 80) return 'claude'
  return 'error'
}

export function ago(at: number, now: number, lang: Lang): string {
  const minutes = Math.max(0, Math.round((now - at) / MS_PER_MINUTE))
  if (minutes < 1) return TEXT[lang].now
  if (minutes < 60) return TEXT[lang].minutesAgo(minutes)
  return TEXT[lang].hoursAgo(Math.round(minutes / 60))
}

export function nextView(current: MeterView): MeterView {
  return VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length] ?? 'context'
}

// Length of the usage windows, to compute the pace.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * MS_PER_HOUR, seven_day: 7 * 24 * MS_PER_HOUR }
// Before 20% of the window the average is still unstable: no forecast.
const MIN_ELAPSED_SHARE = 0.2

// How long until the limit runs out if the average pace since the window started continues.
// undefined when the window resets first, or when it is still too early to tell.
export function exhaustsIn(limit: UsageLimit, now: number): number | undefined {
  const window = WINDOW_MS[limit.kind]
  if (window === undefined || limit.resetsAt === undefined) return undefined
  const untilReset = Date.parse(limit.resetsAt) - now
  const elapsed = window - untilReset
  if (!Number.isFinite(untilReset) || elapsed < window * MIN_ELAPSED_SHARE || limit.percentUsed <= 0) return undefined
  if (limit.percentUsed >= 100) return 0
  const left = ((100 - limit.percentUsed) * elapsed) / limit.percentUsed
  return left < untilReset ? left : undefined
}

// "2d 5h", "3h", "1h20", "45 min".
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MS_PER_MINUTE))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `${minutes} min`
}

// On "context", a usage limit above the alert, or one that runs out before it resets, takes over by itself.
export function effectiveView(chosen: MeterView, status: StatusLine, now: number): MeterView {
  if (chosen !== 'context') return chosen
  const alert = status.limits
    .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
    .find(l => l.percentUsed >= ALERT_AT_PCT || exhaustsIn(l, now) !== undefined)
  return (alert?.kind as MeterView | undefined) ?? 'context'
}

// "resets in 2d 5h" / "resets in 3h": relative, so it does not depend on the time zone.
export function resetsIn(resetsAt: string | undefined, now: number, lang: Lang): string {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  // An unreadable date: nothing, rather than "resets in NaNh".
  if (!Number.isFinite(at)) return ''
  const hours = Math.max(0, Math.round((at - now) / MS_PER_HOUR))
  const days = Math.floor(hours / 24)
  return TEXT[lang].resetsIn(days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`)
}

// What the meter shows: a bar (when there is a percentage) and a note.
// `isPaceHigh`: at the current pace the limit runs out before it resets (the note becomes the warning).
export function meter(
  status: StatusLine,
  shown: MeterView,
  now: number,
  lang: Lang,
): { used?: number; note: string; isPaceHigh?: boolean } | undefined {
  if (shown === 'cost') return status.costUsd === undefined ? undefined : { note: `US$ ${status.costUsd.toFixed(2)}` }
  if (shown === 'context') return status.used === undefined ? undefined : { used: status.used, note: '' }
  const limit = status.limits.find(l => l.kind === shown)
  if (limit === undefined) return undefined
  const used = Math.min(100, Math.round(limit.percentUsed))
  const left = exhaustsIn(limit, now)
  if (left !== undefined) return { used, note: TEXT[lang].exhaustsIn(formatSpan(left)), isPaceHigh: true }
  return { used, note: resetsIn(limit.resetsAt, now, lang) }
}
