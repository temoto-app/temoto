// @vitest-environment jsdom
/**
 * TODO 490 (wave 25 bundle C): the last-updated time at the right end of a thread list row (`src/renderer/src/row-time.ts`).
 *
 * - Format: under 1 minute shows a "just now" label; under 1 hour shows minutes ago; under 1 day shows hours ago; under 3 days shows days ago; 3 days or more shows a date
 *   (this year: month/day; last year or earlier: year/month/day — owner decision 2026-10-06).
 * - One clock for the list: it ticks only while there are subscribers, and calls the subscribers on each tick.
 * - `ThreadRow` gives the same `threadRecency` (`lastEventAt ?? createdAt`) as the sort key (not `updatedAt`).
 *
 * Dates are built as local time with `new Date(y, m, d, …)` (independent of the runtime's time zone). Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'
import { translate, type Translate } from '../src/renderer/src/i18n/index.js'
import {
  ROW_CLOCK_TICK_MS,
  formatRowDate,
  formatRowTime,
  rowClockNow,
  rowClockRunning,
  subscribeRowClock
} from '../src/renderer/src/row-time.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ja: Translate = (key, params) => translate('ja', key, params)
const en: Translate = (key, params) => translate('en', key, params)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = new Date(2026, 9, 7, 12, 0, 0).getTime()

describe('formatRowTime (TODO 490)', () => {
  it('under 1 minute is just now; the future (clock skew) is also just now', () => {
    expect(formatRowTime(now - 59_000, now, 'ja', ja)).toBe('たった今')
    expect(formatRowTime(now + 5_000, now, 'ja', ja)).toBe('たった今')
    expect(formatRowTime(now - 10_000, now, 'en', en)).toBe('just now')
  })

  it('n minutes ago / n hours ago / n days ago', () => {
    expect(formatRowTime(now - MIN, now, 'ja', ja)).toBe('1 分前')
    expect(formatRowTime(now - 59 * MIN, now, 'ja', ja)).toBe('59 分前')
    expect(formatRowTime(now - HOUR, now, 'ja', ja)).toBe('1 時間前')
    expect(formatRowTime(now - 23 * HOUR - 59 * MIN, now, 'ja', ja)).toBe('23 時間前')
    expect(formatRowTime(now - DAY, now, 'ja', ja)).toBe('1 日前')
    expect(formatRowTime(now - 3 * DAY + MIN, now, 'ja', ja)).toBe('2 日前')
    expect(formatRowTime(now - 5 * MIN, now, 'en', en)).toBe('5 min ago')
  })

  it('TODO 506: EN n days ago has a singular form (it used to be `1 days ago`)', () => {
    expect(formatRowTime(now - DAY, now, 'en', en)).toBe('1 day ago')
    expect(formatRowTime(now - 3 * DAY + MIN, now, 'en', en)).toBe('2 days ago')
  })

  it('3 or more days ago is a date: this year is month/day', () => {
    const at = new Date(2026, 9, 2, 9, 30).getTime()
    expect(formatRowTime(at, now, 'ja', ja)).toBe('10/2')
    expect(formatRowTime(at, now, 'en', en)).toBe('10/2')
    expect(formatRowTime(now - 3 * DAY, now, 'ja', ja)).toBe('10/4')
  })

  it('last year or earlier is year/month/day (EN follows the display language order)', () => {
    const at = new Date(2025, 11, 31, 23, 0).getTime()
    expect(formatRowTime(at, now, 'ja', ja)).toBe('2025/12/31')
    expect(formatRowTime(at, now, 'en', en)).toBe('12/31/2025')
    expect(formatRowDate(new Date(2024, 0, 5).getTime(), 'ja', now)).toBe('2024/1/5')
  })

  it('right after the year boundary: December 25 seen from January 2 is last year', () => {
    const jan2 = new Date(2027, 0, 2, 8, 0).getTime()
    expect(formatRowTime(new Date(2026, 11, 25).getTime(), jan2, 'ja', ja)).toBe('2026/12/25')
  })

  it('a row with no time or a broken one is an empty string', () => {
    expect(formatRowTime(Number.NaN, now, 'ja', ja)).toBe('')
    expect(formatRowTime(0, now, 'ja', ja)).toBe('')
  })
})

describe('one clock for the list (TODO 490)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ticks only while there are subscribers, and calls everyone on each tick', () => {
    vi.setSystemTime(now)
    const a = vi.fn()
    const b = vi.fn()
    expect(rowClockRunning()).toBe(false)
    const offA = subscribeRowClock(a)
    const offB = subscribeRowClock(b)
    expect(rowClockRunning()).toBe(true)
    expect(rowClockNow()).toBe(now)
    vi.advanceTimersByTime(ROW_CLOCK_TICK_MS)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(rowClockNow()).toBe(now + ROW_CLOCK_TICK_MS)
    // The same value between ticks (getSnapshot is stable).
    expect(rowClockNow()).toBe(rowClockNow())
    offA()
    expect(rowClockRunning()).toBe(true)
    offB()
    expect(rowClockRunning()).toBe(false)
    vi.advanceTimersByTime(ROW_CLOCK_TICK_MS * 3)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('the tick is 30 to 60 seconds', () => {
    expect(ROW_CLOCK_TICK_MS).toBeGreaterThanOrEqual(30_000)
    expect(ROW_CLOCK_TICK_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('ThreadRow: last updated time at the right edge of the row (TODO 490)', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const summaryOf = (patch: { lastEventAt: number | null; createdAt: number; updatedAt: number }): ThreadSummary =>
    ({
      thread: {
        id: 't1',
        title: 'タイトル',
        cwdName: 'aios',
        cwdUri: 'file:///Users/me/git/aios',
        forkedFrom: null,
        rainbow: null,
        unread: false,
        ...patch
      },
      runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
      preview: null
    }) as unknown as ThreadSummary

  async function renderRow(summary: ThreadSummary): Promise<void> {
    const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadRow, { summary, active: false, sortKey: 'recent' })))
  }

  it('shows the sort key (lastEventAt) and does not use updatedAt (which advances on read and rename); placed at the end of the cwd row (TODO 490 / 674)', async () => {
    await renderRow(summaryOf({ lastEventAt: now - 5 * MIN, createdAt: now - DAY, updatedAt: now }))
    const time = host.querySelector('.thread-row-time')
    expect(time?.textContent).toBe('5 min ago')
    // TODO 674: the first line is cwd name → (pencil) → time; the second line is the title.
    expect(time?.parentElement?.classList.contains('thread-row-meta')).toBe(true)
    expect(time?.nextElementSibling).toBeNull()
    expect(host.querySelector('.thread-row-top .thread-row-title')).not.toBeNull()
    expect(host.querySelector('.thread-row-top .thread-row-cwd')).toBeNull()
    expect(host.querySelector('.thread-row-meta .thread-row-cwd')?.textContent).toBe('aios')
    expect(time?.getAttribute('title')).toContain('2026')
  })

  it('a thread without messages uses the creation time', async () => {
    await renderRow(summaryOf({ lastEventAt: null, createdAt: now - 2 * HOUR, updatedAt: now }))
    expect(host.querySelector('.thread-row-time')?.textContent).toBe('2 h ago')
  })

  it('redraws on the clock tick', async () => {
    await renderRow(summaryOf({ lastEventAt: now - 30_000, createdAt: now - DAY, updatedAt: now }))
    expect(host.querySelector('.thread-row-time')?.textContent).toBe('just now')
    act(() => {
      vi.advanceTimersByTime(ROW_CLOCK_TICK_MS)
    })
    expect(host.querySelector('.thread-row-time')?.textContent).toBe('1 min ago')
  })
})
