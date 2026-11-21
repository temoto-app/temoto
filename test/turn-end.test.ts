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

describe('formatTurnDuration — 合計時間', () => {
  it('60 秒未満は 0.1 秒刻みの秒', () => {
    expect(formatTurnDuration(12_345, ja)).toBe('12.3 秒')
    expect(formatTurnDuration(59_900, ja)).toBe('59.9 秒')
    expect(formatTurnDuration(0, ja)).toBe('0 秒')
    expect(formatTurnDuration(12_345, en)).toBe('12.3 s')
  })

  it('60 秒以上は分と秒 (表示が 60.0 に丸まる 59.96 秒も分の側)', () => {
    expect(formatTurnDuration(59_960, ja)).toBe('1 分 0 秒')
    expect(formatTurnDuration(60_000, ja)).toBe('1 分 0 秒')
    expect(formatTurnDuration(754_200, ja)).toBe('12 分 34 秒')
    expect(formatTurnDuration(754_200, en)).toBe('12 min 34 s')
    expect(formatTurnDuration(HOUR - 1000, ja)).toBe('59 分 59 秒')
  })

  it('1 時間以上は時間と分', () => {
    expect(formatTurnDuration(HOUR, ja)).toBe('1 時間 0 分')
    expect(formatTurnDuration(HOUR + 2 * MIN + 30_000, ja)).toBe('1 時間 2 分')
    expect(formatTurnDuration(HOUR + 2 * MIN, en)).toBe('1 h 2 min')
  })

  it('壊れた値は 0 秒', () => {
    expect(formatTurnDuration(Number.NaN, ja)).toBe('0 秒')
    expect(formatTurnDuration(-5, ja)).toBe('0 秒')
  })
})

describe('formatEndedAgo — いつ終わったか', () => {
  const now = new Date(2026, 9, 4, 22, 27, 0).getTime()

  it('1 分未満は「たった今」、未来 (時計のずれ) も同じ', () => {
    expect(formatEndedAgo(now - 59_999, now, 'ja', ja)).toBe('たった今')
    expect(formatEndedAgo(now + 5000, now, 'ja', ja)).toBe('たった今')
    expect(formatEndedAgo(now - 10_000, now, 'en', en)).toBe('just now')
  })

  it('分・時間・日の境目', () => {
    expect(formatEndedAgo(now - MIN, now, 'ja', ja)).toBe('1 分前')
    expect(formatEndedAgo(now - (HOUR - 1), now, 'ja', ja)).toBe('59 分前')
    expect(formatEndedAgo(now - HOUR, now, 'ja', ja)).toBe('1 時間前')
    expect(formatEndedAgo(now - (DAY - 1), now, 'ja', ja)).toBe('23 時間前')
    expect(formatEndedAgo(now - DAY, now, 'ja', ja)).toBe('1 日前')
    expect(formatEndedAgo(now - (3 * DAY - 1), now, 'ja', ja)).toBe('2 日前')
    expect(formatEndedAgo(now - 5 * MIN, now, 'en', en)).toBe('5 min ago')
  })

  it('TODO 506: EN の n 日前は単数形を持つ (`1 days ago` だった)', () => {
    expect(formatEndedAgo(now - DAY, now, 'en', en)).toBe('1 day ago')
    expect(formatEndedAgo(now - (3 * DAY - 1), now, 'en', en)).toBe('2 days ago')
  })

  it('3 日以上前は日付 (表示言語に合わせる)', () => {
    const ts = new Date(2026, 9, 1, 22, 27, 0).getTime()
    expect(formatEndedAgo(ts, now, 'ja', ja)).toBe('10/1 22:27')
    expect(formatEndedAgo(ts, now, 'en', en)).toBe('Oct 1, 10:27 PM')
  })

  it('日付の空白は正規化する (Intl の U+202F を残さない)。年が違えば年を足す', () => {
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

describe('lastTurnCache — 最後のターンの寿命 (引き継ぎ込み)', () => {
  it('最後の result が寿命を持てばそれ', () => {
    expect(lastTurnCache([user('u1'), result('r1', 1, 300_000), user('u2'), result('r2', 2, HOUR)])).toEqual({
      resultId: 'r2',
      ttlMs: HOUR
    })
  })

  it('最後のターンで書かなかった (省略) なら直前の寿命を引き継ぐ。行き先は最後の result の行', () => {
    expect(lastTurnCache([result('r1', 1, 300_000), user('u2'), result('r2', 2)])).toEqual({
      resultId: 'r2',
      ttlMs: 300_000
    })
  })

  it('どこにも寿命が無い・result が無いなら null', () => {
    expect(lastTurnCache([result('r1', 1), result('r2', 2)])).toBeNull()
    expect(lastTurnCache([user('u1')])).toBeNull()
    expect(lastTurnCache([])).toBeNull()
  })
})

describe('cacheExpired / formatCacheTtl', () => {
  it('寿命を過ぎたら真 (ちょうどで真)', () => {
    expect(cacheExpired(0, HOUR, HOUR - 1)).toBe(false)
    expect(cacheExpired(0, HOUR, HOUR)).toBe(true)
    expect(cacheExpired(0, 5 * MIN, 6 * MIN)).toBe(true)
  })

  it('寿命の表示', () => {
    expect(formatCacheTtl(HOUR, ja)).toBe('1 時間')
    expect(formatCacheTtl(5 * MIN, ja)).toBe('5 分')
    expect(formatCacheTtl(5 * MIN, en)).toBe('5 min')
  })
})
