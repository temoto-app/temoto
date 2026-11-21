/**
 * Format of the end-of-turn row (TODO 466, wave 23 bundle D). The boundary of the total time, the boundary of the 'n min ago' label and 3 days,
 * the date format (EN matches TODO 457), and inheritance of the cache lifetime and the expiry check. Does not call the model.
 */
import { describe, expect, it } from 'vitest'
import type { ResultPayload } from '../src/shared/agent.js'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'
import { translate, type MessageParams } from '../src/renderer/src/i18n/index.js'
import type { MessageKey } from '../src/renderer/src/i18n/ja.js'
import {
  cacheExpired,
  formatCacheTtl,
  formatEndedAgo,
  formatEndedDate,
  formatTurnDuration,
  lastTurnCache
} from '../src/renderer/src/thread/turn-end.js'

const ja = (key: MessageKey, params?: MessageParams): string => translate('ja', key, params)
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatTurnDuration: total time', () => {
  it('under 60 seconds is seconds in 0.1-second steps', () => {
    expect(formatTurnDuration(12_345, ja)).toBe('12.3 秒')
    expect(formatTurnDuration(59_900, ja)).toBe('59.9 秒')
    expect(formatTurnDuration(0, ja)).toBe('0 秒')
    expect(formatTurnDuration(12_345, en)).toBe('12.3 s')
  })

  it('60 seconds or more is minutes and seconds (59.96 seconds, which rounds to 60.0 in display, is on the minutes side too)', () => {
    expect(formatTurnDuration(59_960, ja)).toBe('1 分 0 秒')
    expect(formatTurnDuration(60_000, ja)).toBe('1 分 0 秒')
    expect(formatTurnDuration(754_200, ja)).toBe('12 分 34 秒')
    expect(formatTurnDuration(754_200, en)).toBe('12 min 34 s')
    expect(formatTurnDuration(HOUR - 1000, ja)).toBe('59 分 59 秒')
  })

  it('1 hour or more is hours and minutes', () => {
    expect(formatTurnDuration(HOUR, ja)).toBe('1 時間 0 分')
    expect(formatTurnDuration(HOUR + 2 * MIN + 30_000, ja)).toBe('1 時間 2 分')
    expect(formatTurnDuration(HOUR + 2 * MIN, en)).toBe('1 h 2 min')
  })

  it('a broken value is 0 seconds', () => {
    expect(formatTurnDuration(Number.NaN, ja)).toBe('0 秒')
    expect(formatTurnDuration(-5, ja)).toBe('0 秒')
  })
})

describe('formatEndedAgo: when it ended', () => {
  const now = new Date(2026, 9, 4, 22, 27, 0).getTime()

  it('under 1 minute is 「たった今」, and the future (clock skew) is the same', () => {
    expect(formatEndedAgo(now - 59_999, now, 'ja', ja)).toBe('たった今')
    expect(formatEndedAgo(now + 5000, now, 'ja', ja)).toBe('たった今')
    expect(formatEndedAgo(now - 10_000, now, 'en', en)).toBe('just now')
  })

  it('the boundaries of minutes, hours, and days', () => {
    expect(formatEndedAgo(now - MIN, now, 'ja', ja)).toBe('1 分前')
    expect(formatEndedAgo(now - (HOUR - 1), now, 'ja', ja)).toBe('59 分前')
    expect(formatEndedAgo(now - HOUR, now, 'ja', ja)).toBe('1 時間前')
    expect(formatEndedAgo(now - (DAY - 1), now, 'ja', ja)).toBe('23 時間前')
    expect(formatEndedAgo(now - DAY, now, 'ja', ja)).toBe('1 日前')
    expect(formatEndedAgo(now - (3 * DAY - 1), now, 'ja', ja)).toBe('2 日前')
    expect(formatEndedAgo(now - 5 * MIN, now, 'en', en)).toBe('5 min ago')
  })

  it("TODO 506: EN's n days ago has a singular form (it was `1 days ago`)", () => {
    expect(formatEndedAgo(now - DAY, now, 'en', en)).toBe('1 day ago')
    expect(formatEndedAgo(now - (3 * DAY - 1), now, 'en', en)).toBe('2 days ago')
  })

  it('3 days or more ago is a date (following the display language)', () => {
    const ts = new Date(2026, 9, 1, 22, 27, 0).getTime()
    expect(formatEndedAgo(ts, now, 'ja', ja)).toBe('10/1 22:27')
    expect(formatEndedAgo(ts, now, 'en', en)).toBe('Oct 1, 10:27 PM')
  })

  it("normalizes the whitespace of the date (does not leave Intl's U+202F), and adds the year when the year differs", () => {
    const ts = new Date(2026, 9, 4, 9, 5, 0).getTime()
    const text = formatEndedDate(ts, 'en', now)
    expect(text).toBe('Oct 4, 9:05 AM')
    expect(/[\u00a0\u202f]/.test(text)).toBe(false)
    const lastYear = new Date(2025, 11, 31, 23, 0, 0).getTime()
    expect(formatEndedDate(lastYear, 'en', now)).toContain('2025')
    expect(formatEndedDate(lastYear, 'ja', now)).toContain('2025')
  })
})

function result(id: string, ts: number, cacheTtlMs?: number): TimelineItem {
  const payload: ResultPayload = {
    ok: true,
    subtype: 'success',
    turns: 1,
    durationMs: 1000,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: null,
    denials: [],
    text: null,
    ...(cacheTtlMs === undefined ? {} : { cacheTtlMs })
  }
  return { kind: 'result', id, ts, result: payload }
}

function user(id: string): TimelineItem {
  return { kind: 'user', id, ts: 0, text: 'q' }
}

describe('lastTurnCache: lifetime of the last turn (including carry-over)', () => {
  it('if the last result has a lifetime, that', () => {
    expect(lastTurnCache([user('u1'), result('r1', 1, 300_000), user('u2'), result('r2', 2, HOUR)])).toEqual({
      resultId: 'r2',
      ttlMs: HOUR
    })
  })

  it('when the last turn did not write it (omitted), carries over the previous lifetime, and the destination is the row of the last result', () => {
    expect(lastTurnCache([result('r1', 1, 300_000), user('u2'), result('r2', 2)])).toEqual({
      resultId: 'r2',
      ttlMs: 300_000
    })
  })

  it('null when there is no lifetime anywhere or no result', () => {
    expect(lastTurnCache([result('r1', 1), result('r2', 2)])).toBeNull()
    expect(lastTurnCache([user('u1')])).toBeNull()
    expect(lastTurnCache([])).toBeNull()
  })
})

describe('cacheExpired / formatCacheTtl', () => {
  it('true once the lifetime has passed (true exactly at it)', () => {
    expect(cacheExpired(0, HOUR, HOUR - 1)).toBe(false)
    expect(cacheExpired(0, HOUR, HOUR)).toBe(true)
    expect(cacheExpired(0, 5 * MIN, 6 * MIN)).toBe(true)
  })

  it('lifetime display', () => {
    expect(formatCacheTtl(HOUR, ja)).toBe('1 時間')
    expect(formatCacheTtl(5 * MIN, ja)).toBe('5 分')
    expect(formatCacheTtl(5 * MIN, en)).toBe('5 min')
  })
})
