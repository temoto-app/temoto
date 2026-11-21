/**
 * Batching of watch events (PHASE1_BRIEF 3.3 / ARCHITECTURE.md 5.1).
 * @parcel/watcher emits large numbers of events in bulk, so
 * main -> renderer does not send one message per event.
 */
import { describe, expect, it, vi } from 'vitest'
import { ChangeBatcher, FLUSH_INTERVAL_MS, type RawChange } from '../src/index-kernel/watcher.js'

describe('ChangeBatcher', () => {
  it('既定の間隔は 16 ms', () => {
    expect(FLUSH_INTERVAL_MS).toBe(16)
  })

  it('間隔内のイベントを 1 メッセージにまとめる', async () => {
    vi.useFakeTimers()
    const flushed: (readonly RawChange[])[] = []
    const batcher = new ChangeBatcher((changes) => flushed.push(changes), 16)

    for (let i = 0; i < 500; i += 1) {
      batcher.push({ type: 'create', path: `/Users/tester/f${i}.txt` })
    }
    expect(flushed).toHaveLength(0)

    vi.advanceTimersByTime(16)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toHaveLength(500)
    vi.useRealTimers()
  })

  it('同じパスは最後の 1 件だけ残す', () => {
    vi.useFakeTimers()
    const flushed: (readonly RawChange[])[] = []
    const batcher = new ChangeBatcher((changes) => flushed.push(changes), 16)

    batcher.push({ type: 'create', path: '/Users/tester/a.txt' })
    batcher.push({ type: 'update', path: '/Users/tester/a.txt' })
    batcher.push({ type: 'delete', path: '/Users/tester/a.txt' })
    vi.advanceTimersByTime(16)

    expect(flushed[0]).toEqual([{ type: 'delete', path: '/Users/tester/a.txt' }])
    vi.useRealTimers()
  })

  it('大文字小文字が違うパスを同一とみなす (APFS)', () => {
    vi.useFakeTimers()
    const flushed: (readonly RawChange[])[] = []
    const batcher = new ChangeBatcher((changes) => flushed.push(changes), 16)

    batcher.push({ type: 'create', path: '/Users/tester/A.txt' })
    batcher.push({ type: 'update', path: '/Users/tester/a.TXT' })
    vi.advanceTimersByTime(16)

    expect(flushed[0]).toHaveLength(1)
    vi.useRealTimers()
  })

  it('空のときは flush しない', () => {
    const flushed: unknown[] = []
    const batcher = new ChangeBatcher((changes) => flushed.push(changes), 16)
    batcher.flushNow()
    expect(flushed).toHaveLength(0)
  })

  it('dispose で保留分を捨てる', () => {
    vi.useFakeTimers()
    const flushed: unknown[] = []
    const batcher = new ChangeBatcher((changes) => flushed.push(changes), 16)
    batcher.push({ type: 'create', path: '/Users/tester/a.txt' })
    batcher.dispose()
    vi.advanceTimersByTime(100)
    expect(flushed).toHaveLength(0)
    vi.useRealTimers()
  })
})
