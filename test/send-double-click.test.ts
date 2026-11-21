/**
 * @vitest-environment jsdom
 *
 * TODO 1272: a double click on the primary button must not send twice. No code change was needed: `threadStore.send` empties the field
 * synchronously (TODO 750) and refuses while `sending` is set (review B-2), and the stop lock (TODO 1156) covers the second click
 * landing on the stop square. These tests pin that down. Neither a model nor Electron is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { composerStopLocked, STOP_LOCK_MS } from '../src/renderer/src/composer-button.js'
import type { ThreadSummary } from '../src/shared/thread.js'

function summary(id: string): ThreadSummary {
  return {
    thread: { id, title: id, cwdUri: '', cwdName: '', backend: 'agent-cli', retention: 'forever' },
    runtime: { threadId: id, state: 'idle', reservations: [], subtasks: [], todos: null },
    preview: null
  } as unknown as ThreadSummary
}

async function load(send: () => Promise<unknown>) {
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        list: vi.fn().mockResolvedValue([summary('t1')]),
        open: vi.fn().mockResolvedValue(undefined),
        timeline: vi.fn((threadId: string) =>
          Promise.resolve({ threadId, events: [], notPersisted: false, oldestSeq: null, remaining: 0 })
        ),
        backends: vi.fn().mockResolvedValue([]),
        takeOpenRequest: vi.fn().mockResolvedValue(null),
        onOpenRequest: vi.fn().mockReturnValue(() => {}),
        onChanged: vi.fn().mockReturnValue(() => {}),
        onItemChanged: vi.fn().mockReturnValue(() => {}),
        onDeletedChanged: vi.fn().mockReturnValue(() => {}),
        onEvents: vi.fn().mockReturnValue(() => {}),
        send: vi.fn(send),
        sendInterrupt: vi.fn(send)
      },
      approvals: { list: vi.fn().mockResolvedValue([]), onChanged: vi.fn().mockReturnValue(() => {}) },
      agent: {
        status: vi.fn().mockResolvedValue({ available: true, features: {}, source: 'cache' }),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 5, maxConcurrentCap: 8 }),
        onStatus: vi.fn().mockReturnValue(() => {})
      }
    }
  })
  const store = await import('../src/renderer/src/threadStore.js')
  await store.useThreads.getState().init()
  return store
}

describe('二重の送信 (TODO 1272)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('同じ tick の 2 回のクリックは 1 通だけ送る', async () => {
    const { useThreads } = await load(() => Promise.resolve({ kind: 'sent' }))
    useThreads.setState({ drafts: { t1: '質問' } })
    const first = useThreads.getState().send('t1', undefined)
    const second = useThreads.getState().send('t1', undefined)
    await Promise.all([first, second])
    expect(window.aios.threads.send).toHaveBeenCalledTimes(1)
  })

  it('送信が終わった後の遅れた 2 回目のクリックも (欄が空なので) 送らない', async () => {
    const { useThreads } = await load(() => Promise.resolve({ kind: 'sent' }))
    useThreads.setState({ drafts: { t1: '質問' } })
    await useThreads.getState().send('t1', undefined)
    await useThreads.getState().send('t1', undefined)
    expect(window.aios.threads.send).toHaveBeenCalledTimes(1)
  })

  it('送信の往復の途中のクリックは送らない', async () => {
    let release: (v: unknown) => void = () => undefined
    const { useThreads } = await load(() => new Promise((r) => (release = r)))
    useThreads.setState({ drafts: { t1: '質問' } })
    const first = useThreads.getState().send('t1', undefined)
    useThreads.setState((s) => ({ drafts: { ...s.drafts, t1: '次の文' } }))
    await useThreads.getState().send('t1', undefined)
    await new Promise((r) => setTimeout(r, 0))
    expect(window.aios.threads.send).toHaveBeenCalledTimes(1)
    release({ kind: 'sent' })
    await first
  })

  it('止めるつもりの 2 回目は 300 ms を過ぎれば効く', () => {
    expect(composerStopLocked(1000, 1000 + STOP_LOCK_MS - 1)).toBe(true)
    expect(composerStopLocked(1000, 1000 + STOP_LOCK_MS)).toBe(false)
    expect(composerStopLocked(null, 1000)).toBe(false)
  })
})
