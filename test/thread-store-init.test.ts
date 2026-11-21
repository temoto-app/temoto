/**
 * @vitest-environment jsdom
 *
 * The renderer's `threadStore.init()` (item 80): just opening a window does not select a thread.
 * Regression for owner decision 3 of item 71, "the next time a window is opened, do not select a thread automatically".
 *
 * Stubs `window.aios` with the minimum that resembles the real thing and calls `init()` directly. The DOM is
 * not used, and Zustand's `create` behaves the same in every environment, so jsdom is not required —
 * but the renderer code follows the same shape as the other tests (`@vitest-environment jsdom`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadSummary } from '../src/shared/thread.js'

function summary(id: string): ThreadSummary {
  return {
    thread: {
      id,
      title: `スレッド ${id}`,
      cwdUri: null,
      cwdName: '',
      allowedDirUris: [],
      retention: 'forever',
      retentionDays: null,
      settingSources: ['project'],
      backend: 'agent-cli',
      modelId: null,
      thinking: null,
      approvalStrict: false,
      unread: false,
      lastViewerUri: null,
      lastViewerHighlight: null,
      forkedFrom: null,
      transcriptOrigin: null,
      updatedAt: 0
    },
    runtime: { state: 'idle' },
    pendingApprovals: 0
  } as unknown as ThreadSummary
}

/** Only what `init()` calls is provided. Anything that must not be called records the call. */
function stubAios(threads: readonly ThreadSummary[]): {
  open: ReturnType<typeof vi.fn>
  timeline: ReturnType<typeof vi.fn>
} {
  const open = vi.fn().mockResolvedValue(undefined)
  const timeline = vi.fn().mockResolvedValue({ events: [], notPersisted: false })
  ;(globalThis as { window: typeof window }).window = globalThis.window ?? ({} as typeof window)
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        list: vi.fn().mockResolvedValue(threads),
        open,
        timeline,
        // Item 98 (c): the Drop to the Dock's held item. init subscribes and fetches it once.
        takeOpenRequest: vi.fn().mockResolvedValue(null),
        onOpenRequest: vi.fn().mockReturnValue(() => {}),
        onChanged: vi.fn().mockReturnValue(() => {}),
        onItemChanged: vi.fn().mockReturnValue(() => {}),
        onDeletedChanged: vi.fn().mockReturnValue(() => {}),
        onEvents: vi.fn().mockReturnValue(() => {})
      },
      approvals: {
        list: vi.fn().mockResolvedValue([]),
        onChanged: vi.fn().mockReturnValue(() => {})
      },
      agent: {
        status: vi.fn().mockResolvedValue({ available: true, features: {}, source: 'cache' }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 5,
          maxConcurrentCap: 8,
          defaultRetention: 'forever'
        }),
        onStatus: vi.fn().mockReturnValue(() => {})
      }
    }
  })
  return { open, timeline }
}

describe('threadStore.init (項目 80)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('スレッドが 1 件以上あっても自動選択しない (先頭を開かない・既読にしない)', async () => {
    const threads = [summary('t1'), summary('t2')]
    const { open, timeline } = stubAios(threads)
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()

    expect(useThreads.getState().activeThreadId).toBeNull()
    // Item 75 split the list into `threadsById` + `threadOrder`.
    expect(useThreads.getState().threadOrder).toEqual(['t1', 't2'])
    expect(useThreads.getState().threadsById['t1']).toEqual(threads[0])
    // `selectThread` (-> `threads.open` -> main's `markRead`) is not called.
    expect(open).not.toHaveBeenCalled()
    expect(timeline).not.toHaveBeenCalled()
  })

  it('スレッドが 0 件でも空のまま (何も選ばず ThreadPane は空の案内を出す)', async () => {
    const { open } = stubAios([])
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()

    expect(useThreads.getState().activeThreadId).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('init 後も selectThread はユーザ操作として使え、そのときだけ threads.open を呼ぶ', async () => {
    const threads = [summary('t1')]
    const { open } = stubAios(threads)
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()
    expect(open).not.toHaveBeenCalled()

    await useThreads.getState().selectThread('t1')
    expect(open).toHaveBeenCalledWith('t1')
    expect(useThreads.getState().activeThreadId).toBe('t1')
  })
})

describe('threadStore.init — Dock への Drop の預け物 (項目 98 (c))', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('預けられたスレッドは init の後に開く (合図が購読より先でも取りこぼさない)', async () => {
    const { open, timeline } = stubAios([summary('t1')])
    const threads = (window.aios as unknown as { threads: Record<string, unknown> }).threads
    threads['takeOpenRequest'] = vi.fn().mockResolvedValueOnce({ threadId: 't9', created: true })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()
    await flush()

    expect(open).toHaveBeenCalledWith('t9')
    expect(useThreads.getState().activeThreadId).toBe('t9')
    // A conversation just created (`created`) is accepted as an empty timeline (it is not read).
    expect(timeline).not.toHaveBeenCalled()
  })

  it('復元した窓の既存のスレッド (項目 36) はタイムラインを読んで開く', async () => {
    const { open, timeline } = stubAios([summary('t1'), summary('t2')])
    const threads = (window.aios as unknown as { threads: Record<string, unknown> }).threads
    threads['takeOpenRequest'] = vi.fn().mockResolvedValueOnce({ threadId: 't2' })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()
    await flush()

    expect(open).toHaveBeenCalledWith('t2')
    expect(timeline).toHaveBeenCalledWith('t2')
    expect(useThreads.getState().activeThreadId).toBe('t2')
    expect(useThreads.getState().loaded.has('t2')).toBe(true)
  })

  it('aios://new の本文と添付 (TODO 976 段 3) は Composer に置くだけで送らない', async () => {
    const { open } = stubAios([])
    const threads = (window.aios as unknown as { threads: Record<string, unknown> }).threads
    const send = vi.fn()
    threads['send'] = send
    threads['resolveAttachment'] = vi.fn(async (_threadId: string, uri: string) =>
      uri.endsWith('gone.txt')
        ? { ok: false, reason: 'attach-unreadable' }
        : {
            ok: true,
            attachment: { uri, name: 'a.txt', kind: 'reference', mediaType: null, bytes: 1 },
            outsideAllowed: false,
            keepsThumbnail: false
          }
    )
    threads['takeOpenRequest'] = vi.fn().mockResolvedValueOnce({
      threadId: 't9',
      created: true,
      draft: 'こんにちは',
      attach: ['file:///tmp/a.txt', 'file:///tmp/gone.txt']
    })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { useDropNotices } = await import('../src/renderer/src/dropStore.js')

    await useThreads.getState().init()
    await flush()
    await flush()

    expect(open).toHaveBeenCalledWith('t9')
    const state = useThreads.getState()
    expect(state.activeThreadId).toBe('t9')
    expect(state.drafts['t9']).toBe('こんにちは')
    expect(state.attachments['t9']?.map((a) => a.uri)).toEqual(['file:///tmp/a.txt'])
    // A failed attachment appears in the band as with Drop (it is not silent).
    expect(useDropNotices.getState().failed['t9']).toEqual([{ uri: 'file:///tmp/gone.txt', reason: 'attach-unreadable' }])
    expect(send).not.toHaveBeenCalled()
  })

  it('作れなかった理由は error に出し、何も開かない。合図のたびに取りに行く', async () => {
    const { open } = stubAios([])
    const threads = (window.aios as unknown as { threads: Record<string, unknown> }).threads
    let poke: () => void = () => undefined
    // So that a failure of `refreshBackends` does not appear as an error (only the Drop reason is of interest here).
    threads['backends'] = vi.fn().mockResolvedValue([])
    threads['onOpenRequest'] = vi.fn((listener: () => void) => {
      poke = listener
      return () => {}
    })
    threads['takeOpenRequest'] = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ reason: 'aios-reason:drop-multiple-folders {"count":2}' })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()
    await flush()
    expect(useThreads.getState().error).toBeNull()

    poke()
    await flush()
    expect(useThreads.getState().error).toBe('aios-reason:drop-multiple-folders {"count":2}')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('threadStore.init — StrictMode の 2 回目の init (TODO 571)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /** Counts the onEvents subscriptions (made minus released). */
  function countEvents(): { live: () => number; push: (batch: unknown) => void } {
    const threads = (window.aios as unknown as { threads: Record<string, unknown> }).threads
    const listeners = new Set<(batch: unknown) => void>()
    threads['onEvents'] = vi.fn((listener: (batch: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    return {
      live: () => listeners.size,
      push: (batch) => {
        for (const listener of [...listeners]) listener(batch)
      }
    }
  }

  const event = (id: string) => ({
    id,
    threadId: 't1',
    kind: 'assistant_text',
    at: 1,
    payload: { text: 'x' }
  })

  it('init → dispose → init (effect の 2 回走り) でも購読は 1 組、push は 1 回だけ積む', async () => {
    stubAios([summary('t1')])
    const events = countEvents()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    // StrictMode: while the first init is awaiting, the cleanup and a second init arrive.
    const first = useThreads.getState().init()
    useThreads.getState().dispose()
    const second = useThreads.getState().init()
    await Promise.all([first, second])

    expect(events.live()).toBe(1)
    useThreads.setState({ loaded: new Set(['t1']), events: { t1: [] } })
    events.push({ events: [event('e1')] })
    expect(useThreads.getState().events['t1']?.map((e) => e.id)).toEqual(['e1'])
  })

  it('TODO 570: 開いていないスレッドの行は積まず、コマンドの一覧だけ取る。retention = none は積む', async () => {
    const quiet = summary('t1')
    const secret = { ...summary('t2'), thread: { ...summary('t2').thread, retention: 'none' } } as ThreadSummary
    stubAios([quiet, secret])
    const events = countEvents()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    await useThreads.getState().init()

    const started = {
      id: 's1',
      threadId: 't1',
      kind: 'session_started',
      ts: 1,
      actor: 'main',
      payload: { backendSessionId: 'b', tools: [], toolServers: [], resumed: false, commands: ['compact'] }
    }
    events.push({ events: [started, event('e1'), { ...event('e2'), threadId: 't2' }] })
    const state = useThreads.getState()
    expect(state.events['t1']).toBeUndefined()
    expect(state.threadCommands['t1']).toEqual(['compact'])
    expect(state.events['t2']?.map((e) => e.id)).toEqual(['e2'])
  })

  it('TODO 570: 開いている途中 (timeline の待ち) に届いた行は落とさず混ぜる', async () => {
    const { timeline } = stubAios([summary('t1')])
    const events = countEvents()
    let resolveTimeline: (value: unknown) => void = () => undefined
    timeline.mockReturnValueOnce(new Promise((resolve) => (resolveTimeline = resolve)))
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    await useThreads.getState().init()

    const opening = useThreads.getState().selectThread('t1')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    events.push({ events: [{ ...event('live'), ts: 5 }] })
    resolveTimeline({ events: [{ ...event('db'), ts: 1 }], notPersisted: false, oldestSeq: null, remaining: 0 })
    await opening

    expect(useThreads.getState().events['t1']?.map((e) => e.id)).toEqual(['db', 'live'])
    // After opening, batches are added as usual.
    events.push({ events: [{ ...event('after'), ts: 9 }] })
    expect(useThreads.getState().events['t1']?.map((e) => e.id)).toEqual(['db', 'live', 'after'])
  })

  it('dispose は張った購読を解く。dispose なしで 2 回呼んでも 1 組', async () => {
    stubAios([summary('t1')])
    const events = countEvents()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().init()
    await useThreads.getState().init()
    expect(events.live()).toBe(1)
    useThreads.getState().dispose()
    expect(events.live()).toBe(0)
  })
})

describe('threadStore.init — 購読の隙間に来た配信 (TODO 1138)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('購読を張った後にもう 1 回一覧と承認を引いて当てる', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const running = summary('t1')
    const done = { ...summary('t1'), runtime: { state: 'idle' } } as ThreadSummary
    stubAios([running])
    const aios = window.aios as unknown as {
      threads: { list: ReturnType<typeof vi.fn> }
      approvals: { list: ReturnType<typeof vi.fn> }
    }
    // The first read is the value before the gap; the second (after subscribing) includes the change that happened in the gap.
    aios.threads.list.mockReset().mockResolvedValueOnce([running]).mockResolvedValue([done])
    const request = { id: 'a1' }
    aios.approvals.list.mockReset().mockResolvedValueOnce([]).mockResolvedValue([request])

    await useThreads.getState().init()
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(aios.threads.list).toHaveBeenCalledTimes(2)
    expect(useThreads.getState().threadsById['t1']).toEqual(done)
    expect(useThreads.getState().approvals).toEqual([request])
  })
})
