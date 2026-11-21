/**
 * @vitest-environment jsdom
 *
 * Whether to fetch the timeline when opening a created thread (item 139, ARCHITECTURE.md 4.5.9).
 *
 * A thread continued from a transcript (item 111) holds its past messages from the moment it is created (main's `threads.timeline` reads them from the transcript). Previously, the shared `adoptCreated` used by creation, Drop, and rewind marked it 'loaded and empty', so `selectThread` did not fetch it, and it stayed empty after switching to another thread and back (proxy verification 138).
 * There are three entry points (the list in the create dialog, 'this folder's CLI conversations' (item 122), and 'continue this conversation' in conversation search), and all of them go through `createThread({ transcript })`. Continuing with the same id or branching behaves the same way.
 *
 * An ordinary new thread, a Drop, or a rewind branch starts empty, so it does not fetch extra (as before).
 * `window.aios` is stubbed only for the entry points used (the same approach as `thread-store-init.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import type { Thread, TranscriptOrigin } from '../src/shared/thread.js'

function thread(id: string, transcriptOrigin: TranscriptOrigin | null): Thread {
  return {
    id,
    title: id,
    cwdUri: 'file:///Users/tester/work',
    cwdName: 'work',
    allowedDirUris: [],
    retention: 'forever',
    retentionDays: null,
    settingSources: ['project'],
    backend: 'agent-cli',
    modelId: 'opus',
    thinking: null,
    approvalStrict: false,
    unread: false,
    lastViewerUri: null,
    lastViewerHighlight: null,
    forkedFrom: null,
    transcriptOrigin,
    createdAt: 0,
    updatedAt: 0,
    lastEventAt: null,
    rainbow: null
  } as unknown as Thread
}

/** Past parts read from the transcript (negative positions). */
const HISTORY = [
  {
    id: 'transcript:u1:0',
    threadId: 'x',
    sessionId: 's',
    ts: 1,
    actor: 'main',
    kind: 'user_text',
    payload: { text: 'ターミナルで書いた質問' }
  },
  {
    id: 'transcript:a1:0',
    threadId: 'x',
    sessionId: 's',
    ts: 2,
    actor: 'main',
    kind: 'assistant_text',
    payload: { text: '回答' }
  }
] as unknown as AiosEvent[]

function stubAios(created: Thread): {
  open: ReturnType<typeof vi.fn>
  timeline: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
} {
  const open = vi.fn().mockResolvedValue(undefined)
  const timeline = vi.fn(async (id: string) =>
    id === created.id && created.transcriptOrigin !== null
      ? { events: HISTORY.map((e) => ({ ...e, threadId: id })), notPersisted: false, oldestSeq: -2, remaining: 0 }
      : { events: [], notPersisted: false, oldestSeq: null, remaining: 0 }
  )
  const create = vi.fn().mockResolvedValue(created)
  ;(globalThis as { window: typeof window }).window = globalThis.window ?? ({} as typeof window)
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        open,
        timeline,
        create,
        createFromDrop: vi.fn().mockResolvedValue(created),
        rewind: vi.fn().mockResolvedValue(created)
      }
    }
  })
  return { open, timeline, create }
}

describe('作ったスレッドを開く (項目 139)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('createdWithHistory: 転写から続けたスレッドだけが真 (同じ id でも分岐でも)。欄の無い値は偽', async () => {
    stubAios(thread('t', null))
    const { createdWithHistory } = await import('../src/renderer/src/threadStore.js')
    expect(createdWithHistory({ transcriptOrigin: { fork: false } })).toBe(true)
    expect(createdWithHistory({ transcriptOrigin: { fork: true } })).toBe(true)
    expect(createdWithHistory({ transcriptOrigin: { fork: false, modelFallback: true } })).toBe(true)
    expect(createdWithHistory({ transcriptOrigin: null })).toBe(false)
    expect(createdWithHistory({} as Pick<Thread, 'transcriptOrigin'>)).toBe(false)
  })

  for (const fork of [false, true]) {
    it(`転写から続けた直後に過去分が出る (fork: ${fork})`, async () => {
      const created = thread('t-transcript', { fork })
      const { open, timeline, create } = stubAios(created)
      const { useThreads } = await import('../src/renderer/src/threadStore.js')

      const ok = await useThreads.getState().createThread({ transcript: { sessionId: 'sid', fork } })

      expect(ok).toBe(true)
      expect(create).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith('t-transcript')
      expect(timeline).toHaveBeenCalledWith('t-transcript')
      const state = useThreads.getState()
      expect(state.activeThreadId).toBe('t-transcript')
      expect(state.events['t-transcript']?.map((e) => e.id)).toEqual(['transcript:u1:0', 'transcript:a1:0'])
      expect(state.older['t-transcript']).toEqual({ before: -2, remaining: 0, loading: false })
      expect(state.loaded.has('t-transcript')).toBe(true)
    })
  }

  it('別のスレッドへ移って戻っても過去分は残り、取り直さない', async () => {
    const created = thread('t-transcript', { fork: false })
    const { timeline } = stubAios(created)
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().createThread({ transcript: { sessionId: 'sid', fork: false } })
    await useThreads.getState().selectThread('t-other')
    await useThreads.getState().selectThread('t-transcript')

    expect(useThreads.getState().events['t-transcript']).toHaveLength(2)
    expect(timeline.mock.calls.filter(([id]) => id === 't-transcript')).toHaveLength(1)
  })

  it('普通の新規スレッドはタイムラインを取りに行かない (空で始まる)', async () => {
    const created = thread('t-new', null)
    const { open, timeline } = stubAios(created)
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().createThread({ scratch: true })

    expect(open).toHaveBeenCalledWith('t-new')
    expect(timeline).not.toHaveBeenCalled()
    expect(useThreads.getState().events['t-new']).toEqual([])
    expect(useThreads.getState().loaded.has('t-new')).toBe(true)
  })

  it('Drop と巻き戻しの分岐も空で始まる (取りに行かない)', async () => {
    const created = thread('t-plain', null)
    const { timeline } = stubAios(created)
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().createThreadFromDrop(['file:///Users/tester/work'])
    await useThreads.getState().rewind('t-src', 'e1', false)

    expect(timeline).not.toHaveBeenCalled()
    expect(useThreads.getState().activeThreadId).toBe('t-plain')
  })
})
