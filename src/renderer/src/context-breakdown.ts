/**
 * Display calculations for the context usage breakdown dialog (item 155 / ARCHITECTURE.md 4.5.1). Pure functions, guarded
 * by `test/context-breakdown.test.ts`. It is drawn by `components/ContextUsageDialog.tsx`.
 *
 * - The heading numbers (usage / window / %) use the breakdown's values if there is one, otherwise the donut's values (item 60).
 * - The bar goes in the order of the `used` rows (the backend's order) -> `buffer` -> `free`, with widths as a share of the window.
 *   `deferred` rows are outside the window (not in the total), so they are not drawn in the bar and appear only in the table (the share is "—").
 * - Shares are to the window with one decimal place (the same as the backend's `/context` table).
 */
import type { ContextBreakdown, ContextCategoryKind, ContextTone } from '@shared/context-breakdown.js'
import type { ContextUsage } from '@shared/thread.js'
import { formatTokens } from './context-usage.js'

export interface BreakdownHeader {
  readonly model: string | null
  readonly used: string
  readonly max: string
  readonly percent: number
}

export interface BreakdownBarSegment {
  readonly key: string
  readonly name: string
  readonly kind: ContextCategoryKind
  readonly tone: ContextTone | null
  /** Share of the window (0 to 1). If the total exceeds 1, it is scaled down proportionally. */
  readonly fraction: number
}

export interface BreakdownRow {
  readonly key: string
  readonly name: string
  readonly kind: ContextCategoryKind
  readonly tone: ContextTone | null
  readonly tokens: string
  /** `12.3%`. Null for `deferred` rows (not counted in the window). */
  readonly share: string | null
}

export interface BreakdownView {
  readonly header: BreakdownHeader
  readonly bar: readonly BreakdownBarSegment[]
  readonly rows: readonly BreakdownRow[]
}

/** Share of the window as a `%` with one decimal place. */
export function formatShare(tokens: number, max: number): string {
  if (max <= 0) return '0.0%'
  return `${((tokens / max) * 100).toFixed(1)}%`
}

/** The heading only (when there is no breakdown, from the donut's values). Null if the window is unknown. */
export function headerFromUsage(usage: ContextUsage | null): BreakdownHeader | null {
  if (usage === null || usage.contextWindow === null || usage.contextWindow <= 0) return null
  const used = Math.max(0, usage.inputTokens) + Math.max(0, usage.cacheReadTokens) + Math.max(0, usage.cacheCreationTokens)
  return {
    model: usage.model,
    used: formatTokens(used),
    max: formatTokens(usage.contextWindow),
    percent: Math.round((used / usage.contextWindow) * 100)
  }
}

const BAR_ORDER: Readonly<Record<ContextCategoryKind, number>> = { used: 0, buffer: 1, free: 2, deferred: 3 }

export function breakdownView(breakdown: ContextBreakdown): BreakdownView {
  const max = breakdown.maxTokens
  const inWindow = breakdown.categories
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.kind !== 'deferred' && c.tokens > 0)
    .sort((a, b) => BAR_ORDER[a.c.kind] - BAR_ORDER[b.c.kind] || a.index - b.index)
  const sum = inWindow.reduce((total, { c }) => total + c.tokens, 0)
  const scale = max > 0 && sum > max ? max / sum : 1
  const bar = inWindow.map(({ c, index }) => ({
    key: `${index}`,
    name: c.name,
    kind: c.kind,
    tone: c.tone,
    fraction: max > 0 ? (c.tokens / max) * scale : 0
  }))
  // Table: sections occupying the window -> free / reserved -> outside the window (the same order as the backend's `/context` table). Rows of 0 are not shown.
  const rows = breakdown.categories
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.tokens > 0)
    .sort((a, b) => tableRank(a.c.kind) - tableRank(b.c.kind) || a.index - b.index)
    .map(({ c, index }) => ({
      key: `${index}`,
      name: c.name,
      kind: c.kind,
      tone: c.tone,
      tokens: formatTokens(c.tokens),
      share: c.kind === 'deferred' ? null : formatShare(c.tokens, max)
    }))
  return {
    header: {
      model: breakdown.model,
      used: formatTokens(breakdown.totalTokens),
      max: formatTokens(max),
      percent: breakdown.percentage
    },
    bar,
    rows
  }
}

function tableRank(kind: ContextCategoryKind): number {
  return kind === 'used' ? 0 : kind === 'free' ? 1 : kind === 'buffer' ? 2 : 3
}

/** CSS variable for the section's color (7.4.1). `used` per role, the others neutral. */
export function breakdownColor(kind: ContextCategoryKind, tone: ContextTone | null): string {
  if (kind === 'free') return 'var(--usage-free)'
  if (kind === 'buffer') return 'var(--ctx-buffer)'
  if (kind === 'deferred' || tone === null) return 'var(--ctx-deferred)'
  return `var(--ctx-${tone})`
}
