// @vitest-environment jsdom
/**
 * TODO 772 (wave 36 bundle B): keeps the viewer's '← →' history per conversation (renderer side).
 *
 * - pure functions: `toSnapshot` / `fromSnapshot` / `adoptStored` / `ViewerHistoryWriter` (writes are coalesced over 300 ms, and the same content is not sent).
 * - wiring: `hydrateViewerHistory` reads back from main and puts it into `useStore.viewerHistories`. Reading back opens neither a URL nor a file.
 *
 * `window.aios` is a fake. Neither the model nor main is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_HISTORY,
  VIEWER_HISTORY_WRITE_DEBOUNCE_MS,
  ViewerHistoryWriter,
  adoptStored,
  fromSnapshot,
  historySignature,
  recordVisit,
  stepHistory,
  toSnapshot,
  type ViewerHistory
} from '../src/renderer/src/viewer-history.js'
import type { ViewerHistorySnapshot } from '../src/shared/viewer-history.js'

const visit = (history: ViewerHistory, uri: string, highlight: string | null = null): ViewerHistory =>
  recordVisit(history, { uri, highlight, now: 0, byKeys: false })

const stored: ViewerHistorySnapshot = {
  entries: [
    { uri: 'file:///a', highlight: null },
    { uri: 'https://example.com/', highlight: null },
    { uri: 'file:///b', highlight: 'q' }
  ],
  index: 1
}

describe('toSnapshot / fromSnapshot', () => {
  it('round trip gives the same result; restored steps are not subject to the 1-second grouping', () => {
    const history = fromSnapshot(stored)
    expect(history.index).toBe(1)
    expect(history.entries.every((entry) => !entry.byKeys && entry.at === 0)).toBe(true)
    expect(toSnapshot(history)).toEqual(stored)
  })

  it('an empty save has index -1', () => {
    expect(fromSnapshot({ entries: [], index: 0 })).toEqual({ entries: [], index: -1 })
  })

  it('can go back / forward in the restored history (restoration after closing the app)', () => {
    const history = fromSnapshot(stored)
    expect(stepHistory(history, 'https://example.com/', 'back')?.entry.uri).toBe('file:///a')
    expect(stepHistory(history, 'https://example.com/', 'forward')?.entry.uri).toBe('file:///b')
  })
})

describe('adoptStored', () => {
  it('returns null when there is no saved data (keeps the current state)', () => {
    expect(adoptStored(EMPTY_HISTORY, null)).toBeNull()
    expect(adoptStored(EMPTY_HISTORY, { entries: [], index: -1 })).toBeNull()
  })

  it('adopts the saved data as is when the current history is empty', () => {
    expect(toSnapshot(adoptStored(EMPTY_HISTORY, stored) as ViewerHistory)).toEqual(stored)
  })

  it('when the one step pushed by memory restoration has the same URI as the saved current step, no step is added and the position is kept', () => {
    const current = visit(EMPTY_HISTORY, 'https://example.com/')
    expect(toSnapshot(adoptStored(current, stored) as ViewerHistory)).toEqual(stored)
  })

  it('when the one step has a different URI from the saved current step, pushes it as newly opened (later steps are discarded)', () => {
    const current = visit(EMPTY_HISTORY, 'file:///c')
    const out = adoptStored(current, stored) as ViewerHistory
    expect(out.entries.map((entry) => entry.uri)).toEqual(['file:///a', 'https://example.com/', 'file:///c'])
    expect(out.index).toBe(2)
  })

  it('when two or more steps moved while waiting for the readback, the current one wins (null)', () => {
    const current = visit(visit(EMPTY_HISTORY, 'file:///x'), 'file:///y')
    expect(adoptStored(current, stored)).toBeNull()
  })
})

describe('ViewerHistoryWriter', () => {
  let timers: Map<number, () => void>
  let next: number
  let sent: { threadId: string; snapshot: ViewerHistorySnapshot }[]
  let writer: ViewerHistoryWriter

  beforeEach(() => {
    timers = new Map()
    next = 1
    sent = []
    writer = new ViewerHistoryWriter({
      send: async (threadId, snapshot) => {
        sent.push({ threadId, snapshot })
      },
      setTimer: (fn, ms) => {
        expect(ms).toBe(VIEWER_HISTORY_WRITE_DEBOUNCE_MS)
        const id = next++
        timers.set(id, fn)
        return id
      },
      clearTimer: (handle) => {
        timers.delete(handle as number)
      }
    })
  })

  const fire = (): void => {
    const pending = [...timers.values()]
    timers.clear()
    for (const fn of pending) fn()
  }

  it('sends only the last of consecutive changes', () => {
    let history = visit(EMPTY_HISTORY, 'file:///a')
    writer.schedule('t1', () => history)
    history = visit(history, 'file:///b')
    writer.schedule('t1', () => history)
    history = visit(history, 'file:///c')
    writer.schedule('t1', () => history)
    expect(timers.size).toBe(1)
    fire()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.snapshot.entries.map((entry) => entry.uri)).toEqual(['file:///a', 'file:///b', 'file:///c'])
  })

  it('does not send when equal to the read-back content (markSynced); sends when it changes', () => {
    const history = fromSnapshot(stored)
    writer.markSynced('t1', history)
    writer.schedule('t1', () => history)
    fire()
    expect(sent).toEqual([])
    const moved = { entries: history.entries, index: 0 }
    writer.schedule('t1', () => moved)
    fire()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.snapshot.index).toBe(0)
  })

  it('flushAll sends everything without waiting for throttling, separately per conversation', () => {
    writer.schedule('t1', () => visit(EMPTY_HISTORY, 'file:///a'))
    writer.schedule('t2', () => visit(EMPTY_HISTORY, 'file:///b'))
    writer.flushAll()
    expect(sent.map((entry) => entry.threadId).sort()).toEqual(['t1', 't2'])
    expect(timers.size).toBe(0)
  })

  it('on a send failure clears the mark and resends on the next change even with the same content', async () => {
    let fail = true
    const calls: string[] = []
    const flaky = new ViewerHistoryWriter({
      send: async (threadId) => {
        calls.push(threadId)
        if (fail) throw new Error('ipc')
      },
      setTimer: () => 0,
      clearTimer: () => undefined
    })
    const history = visit(EMPTY_HISTORY, 'file:///a')
    flaky.schedule('t1', () => history)
    flaky.flush('t1')
    await Promise.resolve()
    await Promise.resolve()
    fail = false
    flaky.schedule('t1', () => history)
    flaky.flush('t1')
    expect(calls).toEqual(['t1', 't1'])
  })

  it('historySignature ignores at / byKeys', () => {
    const a: ViewerHistory = { entries: [{ uri: 'file:///a', highlight: null, at: 1, byKeys: true }], index: 0 }
    const b: ViewerHistory = { entries: [{ uri: 'file:///a', highlight: null, at: 9, byKeys: false }], index: 0 }
    expect(historySignature(a)).toBe(historySignature(b))
  })
})

describe('hydrateViewerHistory', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function setup(response: ViewerHistorySnapshot | null | 'reject'): Promise<{
    mod: typeof import('../src/renderer/src/viewerHistory.js')
    store: typeof import('../src/renderer/src/store.js')
    viewerHistory: ReturnType<typeof vi.fn>
    setViewerHistory: ReturnType<typeof vi.fn>
    select: ReturnType<typeof vi.fn>
  }> {
    const viewerHistory = vi.fn(async () => {
      if (response === 'reject') throw new Error('boom')
      return response
    })
    const setViewerHistory = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = { threads: { viewerHistory, setViewerHistory } }
    const store = await import('../src/renderer/src/store.js')
    const mod = await import('../src/renderer/src/viewerHistory.js')
    const select = vi.fn()
    store.useStore.setState({ viewerHistories: {}, select } as never)
    return { mod, store, viewerHistory, setViewerHistory, select }
  }

  it('reads the saved data back into the store; opens neither file nor URL (no select)', async () => {
    const { mod, store, viewerHistory, select } = await setup(stored)
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledWith('t1')
    expect(toSnapshot(store.useStore.getState().viewerHistories['t1'] as ViewerHistory)).toEqual(stored)
    expect(select).not.toHaveBeenCalled()
  })

  it('reads the same conversation only once', async () => {
    const { mod, viewerHistory } = await setup(stored)
    await mod.hydrateViewerHistory('t1')
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledTimes(1)
  })

  it('when the readback fails, reads again on the next open and adopts the saved data (does not mark a failure as read)', async () => {
    const { mod, store, viewerHistory, setViewerHistory } = await setup('reject')
    await mod.hydrateViewerHistory('t1')
    expect(store.useStore.getState().viewerHistories['t1']).toBeUndefined()
    // If it fails, nothing is written back (no write that would destroy the saved history appears)
    expect(setViewerHistory).not.toHaveBeenCalled()
    viewerHistory.mockImplementation(async () => stored)
    await mod.hydrateViewerHistory('t1')
    expect(viewerHistory).toHaveBeenCalledTimes(2)
    expect(toSnapshot(store.useStore.getState().viewerHistories['t1'] as ViewerHistory)).toEqual(stored)
  })

  it('puts nothing in and does not throw when there is no saved data or it is unreadable (reject)', async () => {
    for (const response of [null, 'reject'] as const) {
      const { mod, store } = await setup(response)
      await expect(mod.hydrateViewerHistory('t1')).resolves.toBeUndefined()
      expect(store.useStore.getState().viewerHistories['t1']).toBeUndefined()
    }
  })
})
