/**
 * TODO 1297: ViewerPane is always shown and can only fold into a strip (`viewer-collapse.ts`).
 * Pure functions only; neither the model nor main is used.
 */
import { describe, expect, it } from 'vitest'
import {
  VIEWER_COLLAPSED_KEY,
  VIEWER_SNAP_PX,
  dragEndRatio,
  dragSplit,
  loadViewerCollapsed,
  saveViewerCollapsed,
  viewerFits,
  viewerFolded
} from '../src/renderer/src/viewer-collapse.js'
import { MIN_PANE_PX } from '../src/renderer/src/paneRatio.js'
import type { PrefStorage } from '../src/renderer/src/uiPrefs.js'

function memoryStorage(): PrefStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value)
  }
}

describe('dragSplit', () => {
  it('folds the viewer once it is dragged narrower than half its minimum width', () => {
    // Split area 1000px wide from x = 100.
    expect(dragSplit(1100 - VIEWER_SNAP_PX + 1, 100, 1000).collapsed).toBe(true)
    expect(dragSplit(1100 - VIEWER_SNAP_PX - 1, 100, 1000).collapsed).toBe(false)
  })

  it('keeps the ratio within the minimum widths while open', () => {
    const next = dragSplit(600, 100, 1000)
    expect(next).toEqual({ collapsed: false, ratio: 0.5 })
    expect(dragSplit(1000, 100, 1000).ratio).toBeCloseTo(1 - MIN_PANE_PX / 1000)
  })

  it('never folds on a broken measurement', () => {
    expect(dragSplit(Number.NaN, 100, 1000).collapsed).toBe(false)
    expect(dragSplit(500, 100, 0).collapsed).toBe(false)
  })
})

describe('dragEndRatio (TODO 1297 review)', () => {
  it('a drag that folds keeps the ratio from before it, not the limit it ran up to on the way', () => {
    // Split area 1000px from x = 100, starting at 0.4. Moving to the fold passes the minimum width first.
    const passing = dragSplit(1100 - MIN_PANE_PX + 10, 100, 1000)
    expect(passing.collapsed).toBe(false)
    expect(passing.ratio).toBeCloseTo(1 - MIN_PANE_PX / 1000)
    const folding = dragSplit(1100 - VIEWER_SNAP_PX + 1, 100, 1000)
    expect(folding.collapsed).toBe(true)
    expect(dragEndRatio(0.4, passing.ratio, folding.collapsed)).toBe(0.4)
  })

  it('a drag that ends open keeps where it was let go', () => {
    expect(dragEndRatio(0.4, 0.62, false)).toBe(0.62)
  })
})

describe('viewerFits', () => {
  it('fits both panes at the window minimum width (860px) with the sidebar open', () => {
    expect(viewerFits(860, true)).toBe(true)
  })

  it('folds when even a minimum sidebar leaves no room for both panes, and collapsing the sidebar makes room', () => {
    // 48 + 180 + 5 + 280 + 5 + 280 = 798
    expect(viewerFits(797, true)).toBe(false)
    expect(viewerFits(798, true)).toBe(true)
    expect(viewerFits(700, false)).toBe(true)
  })

  it('counts an unmeasured width as room', () => {
    expect(viewerFits(Number.NaN, true)).toBe(true)
    expect(viewerFits(0, true)).toBe(true)
  })
})

describe('viewerFolded / persistence', () => {
  it('is folded when the user folded it or the window is too narrow', () => {
    expect(viewerFolded(false, true)).toBe(false)
    expect(viewerFolded(true, true)).toBe(true)
    expect(viewerFolded(false, false)).toBe(true)
  })

  it('remembers the fold and falls back to open', () => {
    const storage = memoryStorage()
    expect(loadViewerCollapsed(storage)).toBe(false)
    saveViewerCollapsed(true, storage)
    expect(storage.data.get(VIEWER_COLLAPSED_KEY)).toBe('1')
    expect(loadViewerCollapsed(storage)).toBe(true)
    storage.data.set(VIEWER_COLLAPSED_KEY, 'yes')
    expect(loadViewerCollapsed(storage)).toBe(false)
    expect(loadViewerCollapsed(undefined)).toBe(false)
  })
})
