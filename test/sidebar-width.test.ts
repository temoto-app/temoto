/**
 * Sidebar width (ARCHITECTURE.md 5.5.1, T24 / TODO 33).
 *
 * Unlike the pane ratio (`test/pane-ratio.test.ts`), this is in **px**. Three things to look at: it cannot be collapsed (it does not become 0); when the three boundaries line up, the minimum widths of ThreadPane / ViewerPane are kept on the right; and it renders with the default even when `localStorage` is broken.
 */
import { describe, expect, it } from 'vitest'
import { MIN_PANE_PX } from '@renderer/paneRatio.js'
import {
  ACTIVITY_BAR_PX,
  DEFAULT_SIDEBAR_WIDTH,
  DIVIDER_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidth,
  saveSidebarWidth,
  widthFromPointer
} from '@renderer/sidebarWidth.js'
import type { PrefStorage } from '@renderer/uiPrefs.js'

function memoryStorage(initial: Record<string, string> = {}): PrefStorage & {
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

const throwingStorage: PrefStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

describe('clampSidebarWidth', () => {
  it("rounds to 180-640px and does not squash to 0 (collapsing is not the drag's job)", () => {
    expect(clampSidebarWidth(320)).toBe(320)
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX)
  })

  it('makes it integer px (a fractional width causes subpixel flicker)', () => {
    expect(clampSidebarWidth(320.4)).toBe(320)
    expect(clampSidebarWidth(320.6)).toBe(321)
  })

  it('a broken value falls back to the default', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('even if limit is smaller than the minimum width, the minimum width is kept', () => {
    expect(clampSidebarWidth(400, 10)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(400, Number.NaN)).toBe(400)
  })
})

describe('maxSidebarWidth (where to cut when the window is narrow)', () => {
  it('the upper limit is 640px in a wide window', () => {
    expect(maxSidebarWidth(2560, true)).toBe(SIDEBAR_MAX_PX)
  })

  it('when the viewer is open, leaves room for the minimum width of 2 panes on the right', () => {
    const host = 1200
    const limit = maxSidebarWidth(host, true)
    expect(limit).toBe(host - (ACTIVITY_BAR_PX + DIVIDER_PX * 2 + MIN_PANE_PX * 2))
    // With what remains, both panes get exactly their minimum width.
    expect(host - ACTIVITY_BAR_PX - DIVIDER_PX * 2 - limit).toBe(MIN_PANE_PX * 2)
  })

  it('if the viewer is closed, the sidebar can take more width in the same window', () => {
    expect(maxSidebarWidth(1200, false)).toBeGreaterThan(maxSidebarWidth(1200, true))
    expect(maxSidebarWidth(1200, false)).toBe(SIDEBAR_MAX_PX)
  })

  it('in a window too narrow for the 3 boundaries it falls to the minimum width (beyond that it is CSS min-width)', () => {
    expect(maxSidebarWidth(700, true)).toBe(SIDEBAR_MIN_PX)
    expect(maxSidebarWidth(0, true)).toBe(SIDEBAR_MIN_PX)
  })

  it('returns the upper limit when the width cannot be measured', () => {
    expect(maxSidebarWidth(Number.NaN, true)).toBe(SIDEBAR_MAX_PX)
  })
})

describe('widthFromPointer', () => {
  it('computes the width with the right edge of the icon bar (48px) as the origin', () => {
    expect(widthFromPointer(448, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(400)
  })

  it('dragging fully left stops at 180px, and right stops at limit', () => {
    expect(widthFromPointer(0, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(SIDEBAR_MIN_PX)
    expect(widthFromPointer(9999, ACTIVITY_BAR_PX, 500)).toBe(500)
  })

  it('returns the default even if the coordinates are broken', () => {
    expect(widthFromPointer(Number.NaN, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
  })
})

describe('saving to localStorage', () => {
  it('round-trips (an integer px string)', () => {
    const storage = memoryStorage()
    saveSidebarWidth(412, storage)
    expect(storage.data[SIDEBAR_WIDTH_KEY]).toBe('412')
    expect(loadSidebarWidth(storage)).toBe(412)
  })

  it('unsaved / broken / out-of-range values fall back to the default', () => {
    expect(loadSidebarWidth(memoryStorage())).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: 'nope' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: '0' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: '5000' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
  })

  it('out-of-range is not written', () => {
    const storage = memoryStorage()
    saveSidebarWidth(0, storage)
    saveSidebarWidth(5000, storage)
    saveSidebarWidth(Number.NaN, storage)
    expect(storage.data[SIDEBAR_WIDTH_KEY]).toBeUndefined()
  })

  it('does not leak an exception even if storage throws or is absent', () => {
    expect(loadSidebarWidth(throwingStorage)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300, throwingStorage)).not.toThrow()
    expect(loadSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300, undefined)).not.toThrow()
  })
})

describe('constants match the CSS (fails if styles.css is touched)', () => {
  it('icon bar 48px / divider 5px / sidebar minimum 180px', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(block('.activity-bar')).toContain(`width: ${ACTIVITY_BAR_PX}px`)
    expect(block('.pane-divider')).toContain(`flex: 0 0 ${DIVIDER_PX}px`)
    expect(block('.sidebar-panel')).toContain(`min-width: ${SIDEBAR_MIN_PX}px`)
    expect(block('.sidebar-panel')).toContain(`var(--sidebar-width, ${DEFAULT_SIDEBAR_WIDTH}px)`)
    expect(block('.thread-pane')).toContain(`min-width: ${MIN_PANE_PX}px`)
  })
})
