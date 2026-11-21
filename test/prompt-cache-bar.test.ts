/**
 * TODO 963 (2) (3): the "rewrite" mark on the usage donut, and the bar's judgment for a thread whose cache has expired. Pure functions, no DOM.
 * Does not call the model.
 */
import { describe, expect, it } from 'vitest'
import type { ContextUsage } from '../src/shared/thread.js'
import { CACHE_REWRITE_MIN_TOKENS, contextUsageView, isCacheRewrite } from '../src/renderer/src/context-usage.js'
import { cacheBarState, cacheExpiresAt, conversationTokens } from '../src/renderer/src/thread/prompt-cache.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const t = (key: string, params?: Record<string, string | number>): string => translate('ja', key, params)
const HOUR = 3_600_000

const usage = (read: number, creation: number, input = 3): ContextUsage => ({
  model: 'model-x',
  inputTokens: input,
  outputTokens: 10,
  cacheCreationTokens: creation,
  cacheReadTokens: read,
  contextWindow: 1_000_000,
  windowSource: 'table',
  at: 0
})

describe('書き込み直しの印 (TODO 963 (2))', () => {
  it('当たった呼び出し (読み込みが大半) には付けない', () => {
    expect(isCacheRewrite(usage(180_000, 2_000))).toBe(false)
    // Even one large tool result (30,000 written) is not marked if reads are larger.
    expect(isCacheRewrite(usage(120_000, 30_000))).toBe(false)
  })

  it('書き込みが読み込み以上で、下限以上なら付ける。下限未満の小さな会話には付けない', () => {
    expect(isCacheRewrite(usage(0, 180_000))).toBe(true)
    expect(isCacheRewrite(usage(15_000, 40_000))).toBe(true)
    expect(isCacheRewrite(usage(0, CACHE_REWRITE_MIN_TOKENS - 1))).toBe(false)
    expect(isCacheRewrite(usage(0, CACHE_REWRITE_MIN_TOKENS))).toBe(true)
  })

  it('ドーナツの title に書き込んだトークン数を足す (金額は出さない)', () => {
    const view = contextUsageView(usage(0, 180_000), t)
    expect(view?.cacheRewrite).toBe(true)
    expect(view?.title).toContain('180.0k tokens をキャッシュに書き込み直しました')
    expect(view?.title).not.toMatch(/\$|USD|円/)
    expect(contextUsageView(usage(180_000, 2_000), t)?.cacheRewrite).toBe(false)
  })
})

describe('cache が切れた帯 (TODO 963 (3))', () => {
  const ended = Date.UTC(2026, 9, 25, 9, 0, 0)

  it('切れる時刻は最後のターンの終わり + 寿命。どちらか無ければ null', () => {
    expect(cacheExpiresAt(ended, HOUR)).toBe(ended + HOUR)
    expect(cacheExpiresAt(null, HOUR)).toBeNull()
    expect(cacheExpiresAt(ended, null)).toBeNull()
    expect(cacheExpiresAt(ended, 0)).toBeNull()
  })

  it('会話の大きさは最後の呼び出しの入力の総量', () => {
    expect(conversationTokens(usage(150_000, 2_000, 5))).toBe(152_005)
    expect(conversationTokens(null)).toBeNull()
    expect(conversationTokens(usage(0, 0, 0))).toBeNull()
  })

  it('寿命を過ぎたら出し、過ぎる前・応答中・寿命や使用量が分からないときは出さない', () => {
    const base = { endedAt: ended, ttlMs: HOUR, usage: usage(150_000, 2_000), active: false }
    expect(cacheBarState({ ...base, now: ended + HOUR - 1 })).toBeNull()
    expect(cacheBarState({ ...base, now: ended + HOUR })).toEqual({ tokens: 152_003 })
    expect(cacheBarState({ ...base, active: true, now: ended + 2 * HOUR })).toBeNull()
    expect(cacheBarState({ ...base, ttlMs: null, now: ended + 2 * HOUR })).toBeNull()
    expect(cacheBarState({ ...base, usage: null, now: ended + 2 * HOUR })).toBeNull()
  })

  it('帯の文はトークン数だけ (金額なし)、EN / JA の両方', () => {
    expect(translate('ja', 'cacheBar.expired', { tokens: '152.0k' })).toContain('約 152.0k tokens')
    expect(translate('en', 'cacheBar.expired', { tokens: '152.0k' })).toContain('about 152.0k tokens')
  })
})
