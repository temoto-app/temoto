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

describe('rewrite mark (TODO 963 (2))', () => {
  it('is not attached to a hit call (mostly reads)', () => {
    expect(isCacheRewrite(usage(180_000, 2_000))).toBe(false)
    // Even one large tool result (30,000 written) is not marked if reads are larger.
    expect(isCacheRewrite(usage(120_000, 30_000))).toBe(false)
  })

  it('attached when writes are at least reads and at least the lower bound; not attached to a small conversation under the lower bound', () => {
    expect(isCacheRewrite(usage(0, 180_000))).toBe(true)
    expect(isCacheRewrite(usage(15_000, 40_000))).toBe(true)
    expect(isCacheRewrite(usage(0, CACHE_REWRITE_MIN_TOKENS - 1))).toBe(false)
    expect(isCacheRewrite(usage(0, CACHE_REWRITE_MIN_TOKENS))).toBe(true)
  })

  it('adds the written token count to the donut title (no money amount is shown)', () => {
    const view = contextUsageView(usage(0, 180_000), t)
    expect(view?.cacheRewrite).toBe(true)
    expect(view?.title).toContain('180.0k tokens をキャッシュに書き込み直しました')
    expect(view?.title).not.toMatch(/\$|USD|円/)
    expect(contextUsageView(usage(180_000, 2_000), t)?.cacheRewrite).toBe(false)
  })
})

describe('bar for an expired cache (TODO 963 (3))', () => {
  const ended = Date.UTC(2026, 9, 25, 9, 0, 0)

  it('the expiry time is the end of the last turn + lifetime; null if either is missing', () => {
    expect(cacheExpiresAt(ended, HOUR)).toBe(ended + HOUR)
    expect(cacheExpiresAt(null, HOUR)).toBeNull()
    expect(cacheExpiresAt(ended, null)).toBeNull()
    expect(cacheExpiresAt(ended, 0)).toBeNull()
  })

  it('the size of the conversation is the total input of the last call', () => {
    expect(conversationTokens(usage(150_000, 2_000, 5))).toBe(152_005)
    expect(conversationTokens(null)).toBeNull()
    expect(conversationTokens(usage(0, 0, 0))).toBeNull()
  })

  it('shows once the lifetime has passed, and does not show before it passes, while responding, or when the lifetime or usage is unknown', () => {
    const base = { endedAt: ended, ttlMs: HOUR, usage: usage(150_000, 2_000), active: false }
    expect(cacheBarState({ ...base, now: ended + HOUR - 1 })).toBeNull()
    expect(cacheBarState({ ...base, now: ended + HOUR })).toEqual({ tokens: 152_003 })
    expect(cacheBarState({ ...base, active: true, now: ended + 2 * HOUR })).toBeNull()
    expect(cacheBarState({ ...base, ttlMs: null, now: ended + 2 * HOUR })).toBeNull()
    expect(cacheBarState({ ...base, usage: null, now: ended + 2 * HOUR })).toBeNull()
  })

  it('the bar text is only token counts (no amount), in both EN and JA', () => {
    expect(translate('ja', 'cacheBar.expired', { tokens: '152.0k' })).toContain('約 152.0k tokens')
    expect(translate('en', 'cacheBar.expired', { tokens: '152.0k' })).toContain('about 152.0k tokens')
  })
})
