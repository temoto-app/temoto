/**
 * Calculation for the context usage pie chart (item 60 / ARCHITECTURE.md 4.5.2). Pure functions, guarded
 * by `test/context-usage.test.ts`. It is drawn by `components/ContextUsageDonut.tsx`.
 *
 * - The numerator is `inputTokens + cacheReadTokens + cacheCreationTokens` of "the last API call that arrived"
 *   (= the total tokens passed to the model in that call). **Not summed across turns.**
 * - The denominator is the model's context window limit (main looks it up in a table by the real model name, or
 *   the backend reports it). If absent, nothing is drawn (null).
 * - The coloring is by billing category (input / cache_read / cache_creation + free): owner decision.
 *   This differs in meaning from the breakdown in the backend's "Context usage" panel (system prompt / tool definitions / conversation)
 *   and rounding does not match either, so the `title` says so.
 * - When the limit is exceeded (the table is stale: item 74) it does not stick at 100%; the title states the excess.
 * - **Cache rewrite** (TODO 963): a mark (`cacheRewrite`) when in the last call writes (creation) are at least reads (read) and also at least
 *   `CACHE_REWRITE_MIN_TOKENS`. Either most of the conversation was rewritten without hitting the cache
 *   (expiry, change at the start), or it is the first call of a new conversation. It is not compared with the previous call because, like the numerator,
 *   it is decided from "the last one" only (a restored value gives the same mark). No amounts are shown (constraint 4 / item 165).
 */
import type { ContextUsage } from '@shared/thread.js'
import type { Translate } from './i18n/index.js'

export type UsageSegmentKey = 'input' | 'cacheRead' | 'cacheCreation'

export interface UsageSegment {
  readonly key: UsageSegmentKey
  readonly tokens: number
  /** Share of the denominator (0 to 1). The total never exceeds 1 (the excess is clipped). */
  readonly fraction: number
}

export interface ContextUsageView {
  /** Usage rate (integer %). When over the limit it keeps the value above 100 as it is (the display side handles it). */
  readonly percent: number
  readonly used: number
  readonly contextWindow: number
  readonly overflow: boolean
  /** Drawing order (fixed): input -> cacheRead -> cacheCreation. */
  readonly segments: readonly UsageSegment[]
  /** The last call rewrote the cache (TODO 963). Put a mark on the donut. */
  readonly cacheRewrite: boolean
  readonly title: string
}

/** Writes below this get no mark (so a write the size of one tool result does not light it up). */
export const CACHE_REWRITE_MIN_TOKENS = 20_000

/** Whether the last call rewrote the cache without hitting it (TODO 963). */
export function isCacheRewrite(usage: Pick<ContextUsage, 'cacheReadTokens' | 'cacheCreationTokens'>): boolean {
  const creation = Math.max(0, usage.cacheCreationTokens)
  return creation >= CACHE_REWRITE_MIN_TOKENS && creation >= Math.max(0, usage.cacheReadTokens)
}

const SEGMENT_LABEL_KEY: Readonly<Record<UsageSegmentKey, 'context.segment.input' | 'context.segment.cacheRead' | 'context.segment.cacheCreation'>> = {
  input: 'context.segment.input',
  cacheRead: 'context.segment.cacheRead',
  cacheCreation: 'context.segment.cacheCreation'
}

/** In the form `94.2k` / `1.0M`. Matches how the backend's panel shows it. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function contextUsageView(usage: ContextUsage | null, t: Translate): ContextUsageView | null {
  if (usage === null || usage.contextWindow === null || usage.contextWindow <= 0) return null
  const window = usage.contextWindow
  const parts: readonly { key: UsageSegmentKey; tokens: number }[] = [
    { key: 'input', tokens: Math.max(0, usage.inputTokens) },
    { key: 'cacheRead', tokens: Math.max(0, usage.cacheReadTokens) },
    { key: 'cacheCreation', tokens: Math.max(0, usage.cacheCreationTokens) }
  ]
  const used = parts.reduce((sum, p) => sum + p.tokens, 0)
  const overflow = used > window
  // On excess, each section is scaled down proportionally so that the total is 1 (the arc does not wrap around twice).
  const scale = overflow ? window / used : 1
  const segments = parts.map((p) => ({ ...p, fraction: (p.tokens / window) * scale }))
  const percent = Math.round((used / window) * 100)
  const breakdown = parts
    .map((p) => `${t(SEGMENT_LABEL_KEY[p.key])} ${formatTokens(p.tokens)}`)
    .join(' / ')
  const cacheRewrite = isCacheRewrite(usage)
  const source = t(usage.windowSource === 'reported' ? 'context.source.reported' : 'context.source.table')
  const lines = [
    t('context.summary', { used: formatTokens(used), window: formatTokens(window), percent }),
    usage.model === null ? null : t('context.model', { model: usage.model }),
    t('context.breakdown', { breakdown }),
    t('context.windowSource', { source }),
    overflow ? t('context.overflow') : null,
    cacheRewrite ? t('context.cacheRewrite', { tokens: formatTokens(Math.max(0, usage.cacheCreationTokens)) }) : null,
    t('context.approx')
  ]
  return {
    percent,
    used,
    contextWindow: window,
    overflow,
    segments,
    cacheRewrite,
    title: lines.filter((l): l is string => l !== null).join('\n')
  }
}
