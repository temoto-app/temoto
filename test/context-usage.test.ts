/**
 * Calculation for the pie chart of context usage (item 60). Pure functions, no DOM.
 * The numbers match the real values in `test/fixtures/stream-session.jsonl` (the last assistant = 27,734 tokens,
 * denominator 1,000,000).
 */
import { describe, expect, it } from 'vitest'
import type { ContextUsage } from '../src/shared/thread.js'
import { contextUsageView, formatTokens } from '../src/renderer/src/context-usage.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const t = (key: string, params?: Record<string, string | number>): string =>
  translate('ja', key, params)

const base: ContextUsage = {
  model: 'model-x',
  inputTokens: 2,
  outputTokens: 4,
  cacheCreationTokens: 168,
  cacheReadTokens: 27_564,
  contextWindow: 1_000_000,
  windowSource: 'table',
  at: 0
}

describe('contextUsageView (item 60)', () => {
  it('the numerator is input + cache_read + cache_creation (output not included), and % is an integer', () => {
    const view = contextUsageView(base, t)
    expect(view?.used).toBe(27_734)
    expect(view?.percent).toBe(3)
    expect(view?.overflow).toBe(false)
    expect(view?.segments.map((s) => s.key)).toEqual(['input', 'cacheRead', 'cacheCreation'])
    const total = view!.segments.reduce((sum, s) => sum + s.fraction, 0)
    expect(total).toBeCloseTo(27_734 / 1_000_000, 9)
  })

  it('null = hidden when there is no denominator (a model not in the table) or no response yet', () => {
    expect(contextUsageView(null, t)).toBeNull()
    expect(contextUsageView({ ...base, contextWindow: null, windowSource: null }, t)).toBeNull()
    expect(contextUsageView({ ...base, contextWindow: 0 }, t)).toBeNull()
  })

  it('over the limit, the arc fits in one turn, and % and title state the excess (item 74)', () => {
    const view = contextUsageView({ ...base, cacheReadTokens: 1_500_000 }, t)
    expect(view?.overflow).toBe(true)
    expect(view?.percent).toBe(150)
    const total = view!.segments.reduce((sum, s) => sum + s.fraction, 0)
    expect(total).toBeCloseTo(1, 9)
    expect(view?.title).toContain('上限を超えています')
  })

  it('the title shows the number, breakdown, source and that it does not match exactly', () => {
    const view = contextUsageView(base, t)
    expect(view?.title).toContain('27.7k / 1.0M tokens (3%)')
    expect(view?.title).toContain('モデル: model-x')
    expect(view?.title).toContain('キャッシュ読み込み 27.6k')
    expect(view?.title).toContain('Temoto の表')
    expect(view?.title).toContain('厳密に一致しません')
    expect(contextUsageView({ ...base, windowSource: 'reported' }, t)?.title).toContain('バックエンドの報告')
  })
})

describe('formatTokens', () => {
  it('rounds to k / M', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(27_734)).toBe('27.7k')
    expect(formatTokens(94_200)).toBe('94.2k')
    expect(formatTokens(1_000_000)).toBe('1.0M')
  })
})
