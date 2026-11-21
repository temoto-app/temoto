/**
 * @vitest-environment jsdom
 *
 * TODO 943 (B): the renderer shows the sent message at once as a provisional utterance, and removes it in the same update in which main's `user_text` arrives.
 *
 * - Sending only text to a conversation that is not responding shows the provisional row in the same update that clears the field.
 * - It is removed in the update where `user_text` arrives (one render replaces it with the real one).
 * - It is removed when the message was queued in the reservations (`queued`) or the send failed (the text is put back into the field, TODO 750).
 * - It is not shown while responding, with reservations, for `!`, with attachments, or with a selected range (`optimisticText`).
 *
 * Neither a model nor Electron is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiosEvent, AiosEventBatch } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function summary(id: string, state = 'idle', reservations: readonly unknown[] = []): ThreadSummary {
  return {
    thread: { id, title: id, cwdUri: '', cwdName: '', backend: 'agent-cli', retention: 'forever' },
    runtime: { threadId: id, state, reservations, subtasks: [], todos: null },
    preview: null
  } as unknown as ThreadSummary
}

function userText(threadId: string, text: string): AiosEvent {
  return {
    id: `ev-${text}`,
    sessionId: 's',
    threadId,
    ts: 1,
    actor: 'main',
    kind: 'user_text',
    payload: { text }
  } as AiosEvent
}

let emit: (batch: AiosEventBatch) => void = () => undefined

function stubAios(threads: readonly ThreadSummary[], send: (...args: unknown[]) => Promise<unknown>): void {
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        list: vi.fn().mockResolvedValue(threads),
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
        onEvents: vi.fn((fn: (batch: AiosEventBatch) => void) => {
          emit = fn
          return () => {}
        }),
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
}

async function load(threads: readonly ThreadSummary[], send: (...args: unknown[]) => Promise<unknown>) {
  stubAios(threads, send)
  const store = await import('../src/renderer/src/threadStore.js')
  await store.useThreads.getState().init()
  return store
}

describe('optimisticText (TODO 943)', () => {
  it('応答していない会話への文だけの送信で出し、それ以外では出さない', async () => {
    const { optimisticText } = await import('../src/renderer/src/threadStore.js')
    const base = { text: 'こんにちは', shell: false, attachments: 0, selection: false, state: 'idle', reservations: 0 }
    expect(optimisticText(base)).toBe('こんにちは')
    expect(optimisticText({ ...base, state: 'starting' })).toBe('こんにちは')
    expect(optimisticText({ ...base, state: undefined })).toBe('こんにちは')
    expect(optimisticText({ ...base, state: 'running' })).toBeNull()
    expect(optimisticText({ ...base, state: 'awaiting-approval' })).toBeNull()
    expect(optimisticText({ ...base, reservations: 1 })).toBeNull()
    expect(optimisticText({ ...base, shell: true })).toBeNull()
    expect(optimisticText({ ...base, attachments: 1 })).toBeNull()
    expect(optimisticText({ ...base, selection: true })).toBeNull()
    expect(optimisticText({ ...base, text: '  ' })).toBeNull()
  })
})

describe('threadStore.send — 仮の発言 (TODO 943)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('押した同じ更新で仮の行が出て、user_text が届いた更新で外れる', async () => {
    const pending = deferred<{ kind: 'sent' }>()
    const { useThreads } = await load([summary('t1')], () => pending.promise)
    useThreads.setState({ drafts: { t1: '最初の質問' } })

    const sending = useThreads.getState().send('t1', undefined)
    const state = useThreads.getState()
    expect(state.drafts['t1']).toBe('')
    expect(state.pendingSends['t1']?.text).toBe('最初の質問')

    // Even if the real one arrives before the send round trip finishes, it is still removed.
    useThreads.setState({ loaded: new Set(['t1']), events: { t1: [] } })
    emit({ events: [userText('t1', '最初の質問')], at: 0 })
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
    expect(useThreads.getState().events['t1']?.some((e) => e.kind === 'user_text')).toBe(true)

    pending.resolve({ kind: 'sent' })
    await sending
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
  })

  it('sent が先に返っても、user_text が届くまで残す', async () => {
    const { useThreads } = await load([summary('t1')], async () => ({ kind: 'sent' }))
    useThreads.setState({ drafts: { t1: '質問' } })
    await useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().pendingSends['t1']?.text).toBe('質問')
    // A `user_text` of another thread does not remove it.
    emit({ events: [userText('t2', '別')], at: 0 })
    expect(useThreads.getState().pendingSends['t1']?.text).toBe('質問')
    emit({ events: [userText('t1', '質問')], at: 0 })
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
  })

  it('予約に積まれたら外す (チップで見せる)', async () => {
    const { useThreads } = await load([summary('t1')], async () => ({ kind: 'queued', reservationId: 'r1' }))
    useThreads.setState({ drafts: { t1: '質問' } })
    await useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
  })

  it('送信が失敗したら外し、欄に文を戻す (TODO 750)', async () => {
    const { useThreads } = await load([summary('t1')], async () => {
      throw new Error('agent-not-logged-in')
    })
    useThreads.setState({ drafts: { t1: '質問' } })
    await useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
    expect(useThreads.getState().drafts['t1']).toBe('質問')
  })

  it('応答中の会話への送信 (予約になる) では出さない', async () => {
    const pending = deferred<unknown>()
    const { useThreads } = await load([summary('t1', 'running')], () => pending.promise)
    useThreads.setState({ drafts: { t1: '次の質問' } })
    const sending = useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
    pending.resolve({ kind: 'queued', reservationId: 'r1' })
    await sending
  })

  it('`user_text` が届かないままなら、しばらくして外す', async () => {
    vi.useFakeTimers()
    try {
      const { useThreads } = await load([summary('t1')], async () => ({ kind: 'sent' }))
      useThreads.setState({ drafts: { t1: '質問' } })
      await useThreads.getState().send('t1', undefined)
      expect(useThreads.getState().pendingSends['t1']).toBeDefined()
      vi.advanceTimersByTime(15_000)
      expect(useThreads.getState().pendingSends['t1']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
