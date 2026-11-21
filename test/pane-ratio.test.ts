/**
 * The split ratio of ThreadPane / ViewerPane (ARCHITECTURE.md chapter 5, T15 / TODO 28).
 *
 * The ratio is one number from 0 to 1, rounded to a range where neither side goes below 280px. It is saved in `localStorage`.
 * The main point here is that it **does not break even when it cannot be read or written** (in a private window, or with site data refused, getItem / setItem themselves throw).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_RATIO,
  MIN_PANE_PX,
  PANE_RATIO_KEY,
  clampRatio,
  loadPaneRatio,
  ratioFromPointer,
  savePaneRatio,
  type RatioStorage
} from '@renderer/paneRatio.js'

function memoryStorage(initial: Record<string, string> = {}): RatioStorage & {
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

const throwingStorage: RatioStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

describe('clampRatio', () => {
  it('stops at the boundary that keeps 280px on both sides in a wide window', () => {
    const width = 1400
    const margin = MIN_PANE_PX / width
    expect(clampRatio(0.5, width)).toBe(0.5)
    expect(clampRatio(0, width)).toBeCloseTo(margin, 10)
    expect(clampRatio(1, width)).toBeCloseTo(1 - margin, 10)
    // Even the rounded ratio is at least 280px in actual size
    expect(clampRatio(0, width) * width).toBeGreaterThanOrEqual(MIN_PANE_PX)
    expect((1 - clampRatio(1, width)) * width).toBeGreaterThanOrEqual(MIN_PANE_PX - 1e-9)
  })

  it('when 280px cannot be given to both sides, returns an even split without touching the ratio (leaves the minimum width to CSS)', () => {
    expect(clampRatio(0.9, MIN_PANE_PX * 2 - 1)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(0.9, 0)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(0.9, Number.NaN)).toBe(DEFAULT_PANE_RATIO)
  })

  it('falls back to the default for a broken ratio', () => {
    expect(clampRatio(Number.NaN, 1400)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(Number.POSITIVE_INFINITY, 1400)).toBe(DEFAULT_PANE_RATIO)
  })
})

describe('ratioFromPointer', () => {
  it('computes the ratio with the left edge of the split area as the origin (the Sidebar width is not included)', () => {
    // A split area 1000px wide, starting from a left edge at 368px (48 + 320)
    expect(ratioFromPointer(868, 368, 1000)).toBeCloseTo(0.5, 10)
    expect(ratioFromPointer(668, 368, 1000)).toBeCloseTo(0.3, 10)
  })

  it('stops at the minimum-width boundary even when dragged far outside the area', () => {
    expect(ratioFromPointer(0, 368, 1000)).toBeCloseTo(0.28, 10)
    expect(ratioFromPointer(9999, 368, 1000)).toBeCloseTo(0.72, 10)
  })

  it('an even split when the width is 0 or less', () => {
    expect(ratioFromPointer(500, 368, 0)).toBe(DEFAULT_PANE_RATIO)
  })
})

describe('saving to localStorage', () => {
  it('round-trips', () => {
    const storage = memoryStorage()
    savePaneRatio(0.375, storage)
    expect(storage.data[PANE_RATIO_KEY]).toBe('0.3750')
    expect(loadPaneRatio(storage)).toBeCloseTo(0.375, 10)
  })

  it('falls back to the default for unsaved, broken and edge values', () => {
    expect(loadPaneRatio(memoryStorage())).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: 'nope' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '0' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '1' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '-0.5' }))).toBe(DEFAULT_PANE_RATIO)
  })

  it('read and write do not leak an exception even when storage throws', () => {
    expect(loadPaneRatio(throwingStorage)).toBe(DEFAULT_PANE_RATIO)
    expect(() => savePaneRatio(0.4, throwingStorage)).not.toThrow()
  })

  it('can render with the default even in an environment without storage (undefined)', () => {
    expect(loadPaneRatio(undefined)).toBe(DEFAULT_PANE_RATIO)
    expect(() => savePaneRatio(0.4, undefined)).not.toThrow()
  })

  it('does not save a broken ratio', () => {
    const storage = memoryStorage()
    savePaneRatio(Number.NaN, storage)
    savePaneRatio(0, storage)
    savePaneRatio(1, storage)
    expect(storage.data[PANE_RATIO_KEY]).toBeUndefined()
  })
})
