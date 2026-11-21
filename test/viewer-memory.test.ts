/**
 * The renderer-side pure functions of the ViewerPane memory per thread (item 63). Neither DOM nor store is needed.
 *
 * What it guarantees:
 * - a thread with no memory, or a closed thread (item 70), goes back to 'closed'.
 * - a write that has not yet reached main takes precedence over the row that has arrived (you can go back and forth within 300 ms and return).
 * - writes are coalesced per thread and do not block other threads' waits.
 */
import { describe, expect, it } from 'vitest'
import type { Thread, ThreadSummary } from '../src/shared/thread.js'
import {
  CLOSED_VIEWER,
  recallViewer,
  VIEWER_MEMORY_DEBOUNCE_MS,
  ViewerMemoryWriter,
  type ViewerMemory
} from '../src/renderer/src/viewer-memory.js'

function summary(id: string, uri: string | null, highlight: string | null = null): ThreadSummary {
  const thread = { id, lastViewerUri: uri, lastViewerHighlight: highlight } as unknown as Thread
  return { thread, runtime: {} as ThreadSummary['runtime'], preview: null }
}

describe('recallViewer', () => {
  // Item 75: the renderer holds the thread list as id -> row
  const threads = { a: summary('a', 'file:///a.cpp', 'needle'), b: summary('b', null) }

  it("returns the thread's remembered line", () => {
    expect(recallViewer(threads, new Map(), 'a')).toEqual({ uri: 'file:///a.cpp', highlight: 'needle' })
  })

  it('closes for a thread with no memory, closed, or no line', () => {
    expect(recallViewer(threads, new Map(), 'b')).toBe(CLOSED_VIEWER)
    expect(recallViewer(threads, new Map(), 'missing')).toBe(CLOSED_VIEWER)
  })

  it('prefers writes that have not reached main (including closed)', () => {
    const pending = new Map<string, ViewerMemory>([['a', { uri: null, highlight: null }]])
    expect(recallViewer(threads, pending, 'a')).toEqual({ uri: null, highlight: null })
  })
})

describe('ViewerMemoryWriter', () => {
  function harness(): {
    writer: ViewerMemoryWriter
    sent: [string, ViewerMemory][]
    tick(): void
    resolveAll(): Promise<void>
  } {
    const sent: [string, ViewerMemory][] = []
    const resolvers: (() => void)[] = []
    let timers: { fn: () => void; ms: number; live: boolean }[] = []
    const writer = new ViewerMemoryWriter({
      send: (threadId, memory) => {
        sent.push([threadId, memory])
        return new Promise<void>((resolve) => resolvers.push(resolve))
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, live: true }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        ;(handle as { live: boolean }).live = false
      }
    })
    return {
      writer,
      sent,
      tick() {
        const due = timers.filter((t) => t.live)
        timers = []
        for (const t of due) {
          expect(t.ms).toBe(VIEWER_MEMORY_DEBOUNCE_MS)
          t.fn()
        }
      },
      async resolveAll() {
        for (const r of resolvers.splice(0)) r()
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }

  it('consecutive sends for the same thread send only the last', () => {
    const h = harness()
    h.writer.remember('a', { uri: 'file:///1', highlight: null })
    h.writer.remember('a', { uri: 'file:///2', highlight: null })
    h.writer.remember('a', { uri: 'file:///3', highlight: 'q' })
    h.tick()
    expect(h.sent).toEqual([['a', { uri: 'file:///3', highlight: 'q' }]])
  })

  it('does not squash the wait of another thread', () => {
    const h = harness()
    h.writer.remember('a', { uri: 'file:///a', highlight: null })
    h.writer.remember('b', { uri: 'file:///b', highlight: null })
    h.tick()
    expect(h.sent.map(([id]) => id).sort()).toEqual(['a', 'b'])
  })

  it('once sent, it is removed from pending; a new value that arrives while sending is kept', async () => {
    const h = harness()
    h.writer.remember('a', { uri: 'file:///1', highlight: null })
    h.tick()
    expect(h.writer.pending.has('a')).toBe(true)
    h.writer.remember('a', { uri: 'file:///2', highlight: null })
    await h.resolveAll()
    expect(h.writer.pending.get('a')).toEqual({ uri: 'file:///2', highlight: null })
    h.tick()
    await h.resolveAll()
    expect(h.writer.pending.has('a')).toBe(false)
  })
})
