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
  it('広い窓では両側 280px を確保する境界で止まる', () => {
    const width = 1400
    const margin = MIN_PANE_PX / width
    expect(clampRatio(0.5, width)).toBe(0.5)
    expect(clampRatio(0, width)).toBeCloseTo(margin, 10)
    expect(clampRatio(1, width)).toBeCloseTo(1 - margin, 10)
    // Even the rounded ratio is at least 280px in actual size
    expect(clampRatio(0, width) * width).toBeGreaterThanOrEqual(MIN_PANE_PX)
    expect((1 - clampRatio(1, width)) * width).toBeGreaterThanOrEqual(MIN_PANE_PX - 1e-9)
  })

  it('両側に 280px を配れない幅では比率を触らず等分を返す (最小幅を CSS に任せる)', () => {
    expect(clampRatio(0.9, MIN_PANE_PX * 2 - 1)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(0.9, 0)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(0.9, Number.NaN)).toBe(DEFAULT_PANE_RATIO)
  })

  it('壊れた比率は既定に倒す', () => {
    expect(clampRatio(Number.NaN, 1400)).toBe(DEFAULT_PANE_RATIO)
    expect(clampRatio(Number.POSITIVE_INFINITY, 1400)).toBe(DEFAULT_PANE_RATIO)
  })
})

describe('ratioFromPointer', () => {
  it('分割領域の左端を原点に比率を出す (Sidebar の幅は含めない)', () => {
    // A split area 1000px wide, starting from a left edge at 368px (48 + 320)
    expect(ratioFromPointer(868, 368, 1000)).toBeCloseTo(0.5, 10)
    expect(ratioFromPointer(668, 368, 1000)).toBeCloseTo(0.3, 10)
  })

  it('領域の外へ振り切っても最小幅の境界で止まる', () => {
    expect(ratioFromPointer(0, 368, 1000)).toBeCloseTo(0.28, 10)
    expect(ratioFromPointer(9999, 368, 1000)).toBeCloseTo(0.72, 10)
  })

  it('幅が 0 以下なら等分', () => {
    expect(ratioFromPointer(500, 368, 0)).toBe(DEFAULT_PANE_RATIO)
  })
})

describe('localStorage への保存', () => {
  it('往復する', () => {
    const storage = memoryStorage()
    savePaneRatio(0.375, storage)
    expect(storage.data[PANE_RATIO_KEY]).toBe('0.3750')
    expect(loadPaneRatio(storage)).toBeCloseTo(0.375, 10)
  })

  it('未保存 / 壊れた値 / 端の値は既定に倒す', () => {
    expect(loadPaneRatio(memoryStorage())).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: 'nope' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '0' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '1' }))).toBe(DEFAULT_PANE_RATIO)
    expect(loadPaneRatio(memoryStorage({ [PANE_RATIO_KEY]: '-0.5' }))).toBe(DEFAULT_PANE_RATIO)
  })

  it('storage が投げても読み書きが例外を漏らさない', () => {
    expect(loadPaneRatio(throwingStorage)).toBe(DEFAULT_PANE_RATIO)
    expect(() => savePaneRatio(0.4, throwingStorage)).not.toThrow()
  })

  it('storage が無い環境 (undefined) でも既定で描ける', () => {
    expect(loadPaneRatio(undefined)).toBe(DEFAULT_PANE_RATIO)
    expect(() => savePaneRatio(0.4, undefined)).not.toThrow()
  })

  it('壊れた比率は保存しない', () => {
    const storage = memoryStorage()
    savePaneRatio(Number.NaN, storage)
    savePaneRatio(0, storage)
    savePaneRatio(1, storage)
    expect(storage.data[PANE_RATIO_KEY]).toBeUndefined()
  })
})
