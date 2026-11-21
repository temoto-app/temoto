// @vitest-environment jsdom
/**
 * TODO 466 (wave 23 bundle D): the 'n min ago' label at the end of a turn (`TurnEndAge`).
 *
 * - Advances on one clock for the window (only the part is redrawn at each tick).
 * - On the last turn, once past the cache lifetime it gets `.stale` (a faint warning color). A row that is not given a lifetime does not change color.
 * - ThreadPane uses this part and `formatTurnDuration` for the end-of-turn row (check in the source).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOCK_TICK_MS, TurnEndAge } from '../src/renderer/src/components/TurnEndAge.js'
import { useLocale } from '../src/renderer/src/localeStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIN = 60_000
const NOW = new Date(2026, 9, 4, 22, 0, 0).getTime()

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  useLocale.setState({ resolved: 'ja' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function age(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.turn-end-age')
  if (el === null) throw new Error('no .turn-end-age')
  return el
}

describe('TurnEndAge (TODO 466)', () => {
  it('advances from 「たった今」 to 「n 分前」 by the clock tick', () => {
    act(() => root.render(createElement(TurnEndAge, { endedAt: NOW - 30_000 })))
    expect(age().textContent).toBe('たった今')
    act(() => {
      vi.advanceTimersByTime(2 * MIN)
    })
    expect(age().textContent).toBe('2 分前')
    expect(CLOCK_TICK_MS).toBeLessThanOrEqual(MIN)
  })

  it('.stale once the lifetime has passed, and not added within the lifetime or for a row not given a lifetime', () => {
    act(() => root.render(createElement(TurnEndAge, { endedAt: NOW - 4 * MIN, cacheTtlMs: 5 * MIN })))
    expect(age().classList.contains('stale')).toBe(false)
    act(() => {
      vi.advanceTimersByTime(MIN + CLOCK_TICK_MS)
    })
    expect(age().classList.contains('stale')).toBe(true)
    act(() => root.render(createElement(TurnEndAge, { endedAt: NOW - 4 * MIN })))
    expect(age().classList.contains('stale')).toBe(false)
  })

  it('a row without a time (ts is 0) shows nothing', () => {
    act(() => root.render(createElement(TurnEndAge, { endedAt: 0 })))
    expect(host.innerHTML).toBe('')
  })

  it('the end row of ThreadPane uses the total-time format and this component', () => {
    const source = readFileSync(join(__dirname, '../src/renderer/src/components/ThreadPane.tsx'), 'utf8')
    expect(source).toContain('formatTurnDuration(item.result.durationMs, t)')
    expect(source).toContain('<TurnEndAge endedAt={item.ts}')
    // The old seconds-only format is gone.
    expect(source).not.toContain("t('timeline.result.seconds'")
  })
})
