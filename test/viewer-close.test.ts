/**
 * TODO 1297: the viewer's close button works like closing a browser tab (`viewer-close.ts`).
 * Pure functions only; neither the model nor main is used.
 */
import { describe, expect, it } from 'vitest'
import { planViewerClose } from '../src/renderer/src/viewer-close.js'
import type { HistoryEntry, ViewerHistory } from '../src/renderer/src/viewer-history.js'
import { EMPTY_WEB_TABS, WEB_BLANK_URL, type WebTabsState } from '../src/shared/web-tabs.js'

function entry(uri: string, highlight: string | null = null): HistoryEntry {
  return { uri, highlight, at: 0, byKeys: false }
}

function history(uris: readonly string[], index = uris.length - 1): ViewerHistory {
  return { entries: uris.map((uri) => entry(uri)), index }
}

const A = 'file:///p/a.md'
const B = 'file:///p/b.md'
const C = 'file:///p/c.md'
const WEB = 'https://example.com/'

function tabs(...urls: string[]): WebTabsState {
  return {
    tabs: urls.map((url, i) => ({ id: `t${i}`, url, title: '', favicon: null })),
    activeId: urls.length === 0 ? null : 't0'
  }
}

describe('planViewerClose', () => {
  it('moves to the view seen just before and drops the closed one from the history', () => {
    const plan = planViewerClose(history([A, B, C]), C, EMPTY_WEB_TABS)
    expect(plan.target).toEqual({ kind: 'file', uri: B, highlight: null, position: null })
    expect(plan.history.entries.map((e) => e.uri)).toEqual([A, B])
    expect(plan.history.index).toBe(1)
  })

  it('drops every step of the closed view, so closing again never returns to it', () => {
    const first = planViewerClose(history([A, B, A, C]), C, EMPTY_WEB_TABS)
    expect(first.target).toMatchObject({ kind: 'file', uri: A })
    const second = planViewerClose(first.history, A, EMPTY_WEB_TABS)
    expect(second.target).toMatchObject({ kind: 'file', uri: B })
    expect(second.history.entries.map((e) => e.uri)).toEqual([B])
    const third = planViewerClose(second.history, B, EMPTY_WEB_TABS)
    expect(third.target).toEqual({ kind: 'empty' })
    expect(third.history.entries).toEqual([])
    expect(third.history.index).toBe(-1)
  })

  it('goes to a later step when nothing earlier is left (closing at a position reached by going back)', () => {
    const plan = planViewerClose(history([A, B, C], 0), A, EMPTY_WEB_TABS)
    expect(plan.target).toMatchObject({ kind: 'file', uri: B })
    expect(plan.history.entries.map((e) => e.uri)).toEqual([B, C])
    expect(plan.history.index).toBe(0)
  })

  it('keeps the search term and the position seen in the destination', () => {
    const base: ViewerHistory = {
      entries: [entry(A, 'needle'), entry(B)],
      index: 1,
      positions: { [A]: { kind: 'line', value: 40 }, [B]: { kind: 'line', value: 3 } }
    }
    const plan = planViewerClose(base, B, EMPTY_WEB_TABS)
    expect(plan.target).toEqual({ kind: 'file', uri: A, highlight: 'needle', position: { kind: 'line', value: 40 } })
    expect({ ...plan.history.positions }).toEqual({ [A]: { kind: 'line', value: 40 } })
  })

  it('goes to a Web step only while its tab is still open, and never to a blank tab', () => {
    const open = planViewerClose(history([WEB, WEB_BLANK_URL, A]), A, tabs(WEB))
    expect(open.target).toMatchObject({ kind: 'tab', tab: { url: WEB } })
    const closed = planViewerClose(history([B, WEB, WEB_BLANK_URL, A]), A, EMPTY_WEB_TABS)
    expect(closed.target).toMatchObject({ kind: 'file', uri: B })
  })

  it('shows the empty state when there is nothing to go back to', () => {
    expect(planViewerClose(undefined, A, EMPTY_WEB_TABS).target).toEqual({ kind: 'empty' })
    expect(planViewerClose(history([A]), A, EMPTY_WEB_TABS).target).toEqual({ kind: 'empty' })
  })

  it('does not skip the step in front when the history is out of step with the view', () => {
    // The shown view (C) is not the current step (B): B is the view seen just before.
    const plan = planViewerClose(history([A, B]), C, EMPTY_WEB_TABS)
    expect(plan.target).toMatchObject({ kind: 'file', uri: B })
    expect(plan.history.entries.map((e) => e.uri)).toEqual([A, B])
  })
})

describe('planViewerClose: adjacent steps of one URI (TODO 1297 review)', () => {
  it('merges the two A steps left behind when B is dropped from [A, B, A], so forward has nowhere to go', () => {
    const plan = planViewerClose(history([A, B, A], 1), B, EMPTY_WEB_TABS)
    expect(plan.target).toMatchObject({ kind: 'file', uri: A })
    expect(plan.history.entries.map((e) => e.uri)).toEqual([A])
    expect(plan.history.index).toBe(0)
  })

  it('points the index at the merged step that holds the destination, and keeps its search term', () => {
    const base: ViewerHistory = {
      entries: [entry(C), entry(A, 'old'), entry(B), entry(A, 'new'), entry(B), entry(C)],
      index: 4
    }
    const plan = planViewerClose(base, B, EMPTY_WEB_TABS)
    // Nearest earlier step is the second A (index 3): its search term is the one the viewer goes back to.
    expect(plan.target).toEqual({ kind: 'file', uri: A, highlight: 'new', position: null })
    expect(plan.history.entries.map((e) => [e.uri, e.highlight])).toEqual([
      [C, null],
      [A, 'new'],
      [C, null]
    ])
    expect(plan.history.index).toBe(1)
  })

  it('merges in the history left for the empty state too', () => {
    const plan = planViewerClose(history([WEB, A, WEB], 1), A, EMPTY_WEB_TABS)
    expect(plan.target).toEqual({ kind: 'empty' })
    expect(plan.history.entries.map((e) => e.uri)).toEqual([WEB])
    expect(plan.history.index).toBe(0)
  })
})

describe('closeShownView (wiring)', () => {
  it('moves the viewer to the previous view, then to the empty state', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { closeShownView } = await import('../src/renderer/src/viewerHistory.js')
    useThreads.setState({ activeThreadId: 't1' })
    useStore.setState({ selectedUri: B, viewerHistories: { t1: history([A, B]) } })
    closeShownView()
    expect(useStore.getState().selectedUri).toBe(A)
    expect(useStore.getState().viewerHistories.t1?.entries.map((e) => e.uri)).toEqual([A])
    closeShownView()
    expect(useStore.getState().selectedUri).toBeNull()
    expect(useStore.getState().viewerHistories.t1?.entries).toEqual([])
  })
})
