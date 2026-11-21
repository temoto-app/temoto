/**
 * @vitest-environment jsdom
 *
 * renderer re-rendering granularity (item 88), and the store behavior that goes with it.
 *
 * Zustand decides re-rendering by comparing the selector's return with `Object.is`, so 'no re-rendering on frequent pushes' is equivalent to 'the selector of that component returns the same value before and after the push'. Without drawing the DOM, it evaluates **the same expression that the component actually uses as its selector** before and after the push, and compares.
 *
 * - On a single delivery of `turn_usage` / `result` (`onItemChanged`), other rows, the ThreadPane heading, the Composer body (thread / live / backend / commands), and the BottomBar's cwd do not change.
 * - In an event batch (`onEvents`), the list and the Composer's options do not change.
 * - `backends()` is called only once at init. Switching threads does not refetch it. It is refetched only when `onStatus` and the command list arrive (item 68).
 * - 'Read more' adds the previous page to the head and advances the remaining count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, AiosEvent, AiosEventBatch } from '../src/shared/agent.js'
import { attentionOf, maxAttention } from '../src/renderer/src/thread-sort.js'
import type {
  BackendChoice,
  ContextUsage,
  RunningSubtask,
  ThreadSummary,
  Timeline,
  TodoList
} from '../src/shared/thread.js'

function summary(
  id: string,
  patch: {
    updatedAt?: number
    costUsd?: number
    state?: string
    usage?: ContextUsage | null
    live?: boolean
    subtasks?: readonly RunningSubtask[]
    todos?: TodoList | null
  } = {}
): ThreadSummary {
  return {
    thread: {
      id,
      title: `スレッド ${id}`,
      cwdUri: `file:///Users/tester/${id}`,
      cwdName: id,
      allowedDirUris: [],
      retention: 'forever',
      retentionDays: null,
      settingSources: ['project'],
      backend: 'agent-cli',
      modelId: null,
      thinking: null,
      approvalStrict: false,
      unread: false,
      archived: false,
      lastViewerUri: null,
      lastViewerHighlight: null,
      forkedFrom: null,
      transcriptOrigin: null,
      updatedAt: patch.updatedAt ?? 1
    },
    runtime: {
      threadId: id,
      state: patch.state ?? 'idle',
      backendSessionId: null,
      live: patch.live ?? false,
      pendingApprovals: 0,
      turns: 0,
      costUsd: patch.costUsd ?? 0,
      lastError: null,
      reservations: [],
      contextUsage: patch.usage ?? null,
      subtasks: patch.subtasks ?? [],
      todos: patch.todos ?? null
    },
    preview: null
  } as unknown as ThreadSummary
}

const USAGE: ContextUsage = {
  model: 'm',
  inputTokens: 10,
  outputTokens: 1,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  contextWindow: 1000,
  windowSource: 'table',
  at: 5
}

const BACKEND: BackendChoice = {
  id: 'agent-cli',
  label: 'agent',
  available: true,
  message: null,
  models: [],
  modelSelect: false,
  rewind: false,
  capabilities: { approval: true, subagents: true, rewind: false, mcp: true },
  thinkingLevel: false,
  degradations: [],
  commands: null
}

interface Listeners {
  events: (batch: AiosEventBatch) => void
  item: (summary: ThreadSummary) => void
  status: (status: AgentStatus) => void
}

function stubAios(threads: readonly ThreadSummary[], pages: Record<number, Timeline> = {}): {
  listeners: Listeners
  backends: ReturnType<typeof vi.fn>
  timelineBefore: ReturnType<typeof vi.fn>
} {
  const listeners = {} as Listeners
  const backends = vi.fn().mockResolvedValue([BACKEND])
  const timelineBefore = vi.fn((threadId: string, before: number) =>
    Promise.resolve(pages[before] ?? { threadId, events: [], notPersisted: false, oldestSeq: null, remaining: 0 })
  )
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        list: vi.fn().mockResolvedValue(threads),
        open: vi.fn().mockResolvedValue(undefined),
        timeline: vi.fn((threadId: string) =>
          Promise.resolve({ threadId, events: [], notPersisted: false, oldestSeq: 101, remaining: 250 })
        ),
        timelineBefore,
        backends,
        // Item 98 (c): the Drop to the Dock's held item. init subscribes and fetches it once.
        takeOpenRequest: vi.fn().mockResolvedValue(null),
        onOpenRequest: vi.fn().mockReturnValue(() => {}),
        onChanged: vi.fn().mockReturnValue(() => {}),
        onItemChanged: vi.fn((fn: Listeners['item']) => {
          listeners.item = fn
          return () => {}
        }),
        onDeletedChanged: vi.fn().mockReturnValue(() => {}),
        onEvents: vi.fn((fn: Listeners['events']) => {
          listeners.events = fn
          return () => {}
        })
      },
      approvals: { list: vi.fn().mockResolvedValue([]), onChanged: vi.fn().mockReturnValue(() => {}) },
      agent: {
        status: vi.fn().mockResolvedValue({ available: true, features: {}, source: 'cache' }),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 5, maxConcurrentCap: 8 }),
        onStatus: vi.fn((fn: Listeners['status']) => {
          listeners.status = fn
          return () => {}
        })
      }
    }
  })
  return { listeners, backends, timelineBefore }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function load(threads: readonly ThreadSummary[], pages?: Record<number, Timeline>) {
  const stub = stubAios(threads, pages)
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  await useThreads.getState().init()
  await flush()
  return { ...stub, useThreads }
}

type State = ReturnType<Awaited<ReturnType<typeof load>>['useThreads']['getState']>

/**
 * The same expressions as the components' selectors (Composer / ThreadPane / ThreadList / BottomBar).
 * If the component's expression changes, keep this in line too.
 */
const selectors = {
  row: (id: string) => (s: State) => s.threadsById[id],
  order: (s: State) => s.threadOrder,
  paneThread: (id: string) => (s: State) => s.threadsById[id]?.thread,
  composerThread: (id: string) => (s: State) => s.threadsById[id]?.thread,
  composerLive: (id: string) => (s: State) => s.threadsById[id]?.runtime.live === true,
  composerBackend: (id: string) => (s: State) =>
    s.backends?.find((choice) => choice.id === s.threadsById[id]?.thread.backend) ?? null,
  composerCommands: (id: string) => (s: State) => s.threadCommands[id],
  composerDraft: (id: string) => (s: State) => s.drafts[id] ?? '',
  donut: (id: string) => (s: State) => s.threadsById[id]?.runtime.contextUsage ?? null,
  /** SubtaskList (the way item 93 is shown). In the component it is `?? NO_SUBTASKS`. */
  subtasks: (id: string) => (s: State) => s.threadsById[id]?.runtime.subtasks,
  /** TodoList (item 118). The same expression as the component. */
  todos: (id: string) => (s: State) => s.threadsById[id]?.runtime.todos ?? null,
  /** The dot on the Sidebar's activity bar (wave 13 bundle B, item 151). Returns a number. */
  sidebarDot: (s: State) => maxAttention(s.threadOrder, s.threadsById),
  /** The strength of the mark on the selected row in ThreadList (the keeping mark of item 152). Returns a number. */
  listActiveAttention: (s: State) =>
    s.activeThreadId === null ? 0 : attentionOf(s.threadsById[s.activeThreadId]),
  bottomCwd: (s: State) => {
    const id = s.activeThreadId
    if (id === null) return null
    const row = s.threadsById[id]
    return row === undefined || row.thread.cwdUri === '' ? null : row.thread.cwdUri
  }
}

function snapshot(state: State, id: string, other: string): unknown[] {
  return [
    selectors.row(other)(state),
    selectors.order(state),
    selectors.paneThread(id)(state),
    selectors.composerThread(id)(state),
    selectors.composerLive(id)(state),
    selectors.composerBackend(id)(state),
    selectors.composerCommands(id)(state),
    selectors.composerDraft(id)(state),
    selectors.sidebarDot(state),
    selectors.listActiveAttention(state),
    selectors.bottomCwd(state)
  ]
}

function expectSame(before: unknown[], after: unknown[]): void {
  expect(after).toHaveLength(before.length)
  after.forEach((value, i) => expect(Object.is(value, before[i]), `selector #${i}`).toBe(true))
}

beforeEach(() => {
  vi.resetModules()
})

describe('再描画の粒度 (項目 88)', () => {
  it('turn_usage / result の 1 件配信で、他の行・見出し・Composer 本体・BottomBar は変わらない', async () => {
    const { listeners, useThreads } = await load([summary('a'), summary('b')])
    await useThreads.getState().selectThread('a')
    const before = snapshot(useThreads.getState(), 'a', 'b')

    // While responding: the state and usage change (turn_usage).
    listeners.item(summary('a', { state: 'running', usage: USAGE }))
    // End of the response: only the cost changes (result). The contents of the usage are the same.
    listeners.item(summary('a', { state: 'idle', usage: { ...USAGE }, costUsd: 0.01 }))

    const state = useThreads.getState()
    expectSame(before, snapshot(state, 'a', 'b'))
    // Only the donut (a child of the Composer) receives the usage. On a second time with the same contents, it reuses the value.
    const donut = selectors.donut('a')(state)
    expect(donut).toEqual(USAGE)
    listeners.item(summary('a', { state: 'idle', usage: { ...USAGE }, costUsd: 0.02 }))
    expect(selectors.donut('a')(useThreads.getState())).toBe(donut)
  })

  it('イベントのバッチでは一覧と Composer の選択肢が変わらない (変わるのは events だけ)', async () => {
    const { listeners, useThreads } = await load([summary('a'), summary('b')])
    await useThreads.getState().selectThread('a')
    const before = snapshot(useThreads.getState(), 'a', 'b')
    const event = {
      id: 'e1', sessionId: 's', threadId: 'a', ts: 1, actor: 'main',
      kind: 'assistant_delta', payload: { text: 'x' }
    } as AiosEvent
    listeners.events({ at: 0, events: [event] } as AiosEventBatch)
    expectSame(before, snapshot(useThreads.getState(), 'a', 'b'))
    expect(useThreads.getState().events['a']).toEqual([event])
  })
})

describe('子エージェントの一覧 (項目 93 の見せ方)', () => {
  const child = (tokens: number): RunningSubtask => ({
    taskId: 't1',
    toolUseId: 'tu1',
    description: '束 A',
    subagentType: 'general-purpose',
    status: 'running',
    startedAt: 1,
    usage: { totalTokens: tokens, toolUses: 1, durationMs: 100 },
    usageAt: 2,
    lastToolName: 'Read',
    activity: null,
    model: null
  })

  it('子の経過で一覧だけが変わり、Composer 本体・見出し・他の行は変わらない', async () => {
    const { listeners, useThreads } = await load([summary('a'), summary('b')])
    await useThreads.getState().selectThread('a')
    listeners.item(summary('a', { subtasks: [child(10)] }))
    const before = snapshot(useThreads.getState(), 'a', 'b')
    const list = selectors.subtasks('a')(useThreads.getState())
    expect(list).toHaveLength(1)

    listeners.item(summary('a', { subtasks: [child(20)] }))
    const state = useThreads.getState()
    expectSame(before, snapshot(state, 'a', 'b'))
    expect(selectors.subtasks('a')(state)).not.toBe(list)
    expect(selectors.subtasks('a')(state)?.[0]?.usage?.totalTokens).toBe(20)
  })

  it('turn_usage / result で子の中身が同じなら一覧の配列を使い回す', async () => {
    const { listeners, useThreads } = await load([summary('a')])
    listeners.item(summary('a', { subtasks: [child(10)] }))
    const list = selectors.subtasks('a')(useThreads.getState())
    listeners.item(summary('a', { state: 'running', usage: USAGE, subtasks: [child(10)] }))
    listeners.item(summary('a', { state: 'idle', usage: USAGE, costUsd: 0.5, subtasks: [child(10)] }))
    expect(selectors.subtasks('a')(useThreads.getState())).toBe(list)
  })
})

describe('バックエンドの控え (項目 88 / 68)', () => {
  it('backends() は init で 1 回だけ。スレッドを切り替えても取り直さない', async () => {
    const { backends, useThreads } = await load([summary('a'), summary('b')])
    expect(backends).toHaveBeenCalledTimes(1)
    await useThreads.getState().selectThread('a')
    await useThreads.getState().selectThread('b')
    expect(backends).toHaveBeenCalledTimes(1)
    expect(useThreads.getState().backends).toEqual([BACKEND])
  })

  it('Adapter の状態が変わったとき (onStatus) だけ取り直す', async () => {
    const { backends, listeners } = await load([summary('a')])
    listeners.status({ available: true } as AgentStatus)
    await flush()
    expect(backends).toHaveBeenCalledTimes(2)
  })

  it('session_started の一覧はスレッドの一覧になり、バックエンドの控えも取り直す', async () => {
    const { backends, listeners, useThreads } = await load([summary('a')])
    const started = {
      id: 'e1', sessionId: 's', threadId: 'a', ts: 1, actor: 'main', kind: 'session_started',
      payload: { backendSessionId: 'b', backendVersion: null, model: null, cwd: null,
        reportedPermissionMode: null, tools: [], toolServers: [], resumed: false, commands: ['compact'] }
    } as AiosEvent
    const before = useThreads.getState().threadCommands
    listeners.events({ at: 0, events: [started] } as AiosEventBatch)
    await flush()
    expect(useThreads.getState().threadCommands['a']).toEqual(['compact'])
    expect(backends).toHaveBeenCalledTimes(2)
    // In an ordinary batch without a list, threadCommands stays the same object.
    const after = useThreads.getState().threadCommands
    expect(after).not.toBe(before)
    listeners.events({
      at: 0,
      events: [{ ...started, id: 'e2', kind: 'assistant_delta', payload: { text: 'x' } } as AiosEvent]
    } as AiosEventBatch)
    expect(useThreads.getState().threadCommands).toBe(after)
  })
})

describe('「さらに読む」(項目 88)', () => {
  it('開いたときの位置を覚え、押すと前のページを頭に足して残りを進める', async () => {
    const older = (id: string): AiosEvent =>
      ({ id, sessionId: 's', threadId: 'a', ts: 0, actor: 'main', kind: 'user_text', payload: { text: id } }) as AiosEvent
    const { timelineBefore, useThreads } = await load([summary('a')], {
      101: { threadId: 'a', events: [older('o1'), older('o2')], notPersisted: false, oldestSeq: 99, remaining: 0 }
    })
    await useThreads.getState().selectThread('a')
    expect(useThreads.getState().older['a']).toEqual({ before: 101, remaining: 250, loading: false })

    await useThreads.getState().loadOlder('a')
    expect(timelineBefore).toHaveBeenCalledWith('a', 101)
    expect(useThreads.getState().events['a']?.map((e) => e.id)).toEqual(['o1', 'o2'])
    expect(useThreads.getState().older['a']).toEqual({ before: 99, remaining: 0, loading: false })

    // If none remain, do nothing.
    await useThreads.getState().loadOlder('a')
    expect(timelineBefore).toHaveBeenCalledTimes(1)
  })
})

describe('⌘K の結果から前のページの発言へ飛ぶ (TODO 498)', () => {
  const older = (id: string): AiosEvent =>
    ({ id, sessionId: 's', threadId: 'a', ts: 0, actor: 'main', kind: 'user_text', payload: { text: id } }) as AiosEvent

  it('読み込み済みでない発言なら、届くまで前のページを読む (届いたら止める)', async () => {
    const { timelineBefore, useThreads } = await load([summary('a')], {
      101: { threadId: 'a', events: [older('p1')], notPersisted: false, oldestSeq: 90, remaining: 200 },
      90: { threadId: 'a', events: [older('target'), older('p2')], notPersisted: false, oldestSeq: 80, remaining: 100 },
      80: { threadId: 'a', events: [older('p3')], notPersisted: false, oldestSeq: 70, remaining: 0 }
    })
    await useThreads.getState().jumpToEvent('a', 'target')
    expect(timelineBefore.mock.calls).toEqual([
      ['a', 101],
      ['a', 90]
    ])
    expect(useThreads.getState().events['a']?.map((e) => e.id)).toEqual(['target', 'p2', 'p1'])
    expect(useThreads.getState().highlightEventId).toBe('target')
  })

  it('会話の検索結果から飛んでも、サイドバーのモードを一瞬も threads にしない (SearchMode を unmount しない)', async () => {
    const { useThreads } = await load([summary('a')], {})
    useThreads.setState({ mode: 'search' })
    const seen: string[] = []
    const off = useThreads.subscribe((state) => seen.push(state.mode))
    await useThreads.getState().jumpToEvent('a', 'x')
    off()
    expect(seen).not.toContain('threads')
    expect(useThreads.getState().mode).toBe('search')
    expect(useThreads.getState().activeThreadId).toBe('a')
    // An ordinary selectThread, such as a click on the list, goes back to threads.
    await useThreads.getState().selectThread('a')
    expect(useThreads.getState().mode).toBe('threads')
  })

  it('飛んだ直後に別のスレッドを選ぶと強調を消す (TODO 1140)。同じスレッドの選び直しでは消さない', async () => {
    const { useThreads } = await load([summary('a'), summary('b')], {})
    await useThreads.getState().jumpToEvent('a', 'x')
    expect(useThreads.getState().highlightEventId).toBe('x')
    await useThreads.getState().selectThread('a')
    expect(useThreads.getState().highlightEventId).toBe('x')
    await useThreads.getState().selectThread('b')
    expect(useThreads.getState().highlightEventId).toBeNull()
  })

  it('読み込み済みの発言なら前のページを読まない', async () => {
    const { timelineBefore, useThreads } = await load([summary('a')], {
      101: { threadId: 'a', events: [older('p1')], notPersisted: false, oldestSeq: 90, remaining: 200 }
    })
    await useThreads.getState().selectThread('a')
    await useThreads.getState().loadOlder('a')
    timelineBefore.mockClear()
    await useThreads.getState().jumpToEvent('a', 'p1')
    expect(timelineBefore).not.toHaveBeenCalled()
  })

  it('届かなければ上限 (MAX_OLDER_PAGES) で止める', async () => {
    const { MAX_OLDER_PAGES } = await import('../src/renderer/src/thread/load-until.js')
    // Even reading to the end, the message in question is not there (a deleted message). It advances one step back at a time each round.
    const pages: Record<number, Timeline> = {}
    for (let seq = 101; seq > 0; seq -= 1) {
      pages[seq] = { threadId: 'a', events: [older(`x${seq}`)], notPersisted: false, oldestSeq: seq - 1, remaining: seq - 1 }
    }
    const { timelineBefore, useThreads } = await load([summary('a')], pages)
    await useThreads.getState().jumpToEvent('a', 'gone')
    expect(timelineBefore).toHaveBeenCalledTimes(MAX_OLDER_PAGES)
  })

  it('読んでいる間に別の所へ飛び直したら、前の飛び先のために読み続けない', async () => {
    let release: () => void = () => {}
    const { timelineBefore, useThreads } = await load([summary('a')], {
      90: { threadId: 'a', events: [older('p2')], notPersisted: false, oldestSeq: 80, remaining: 100 },
      80: { threadId: 'a', events: [older('p3')], notPersisted: false, oldestSeq: 70, remaining: 0 }
    })
    // Hold the loading of the first page, and jump again (to p1, which is on the first page) in the meantime. Without holding it, the first jump target 'far' would also read 90 / 80.
    timelineBefore.mockImplementationOnce(
      (threadId: string) =>
        new Promise<Timeline>((resolve) => {
          release = () => resolve({ threadId, events: [older('p1')], notPersisted: false, oldestSeq: 90, remaining: 200 })
        })
    )
    const first = useThreads.getState().jumpToEvent('a', 'far')
    await flush()
    const second = useThreads.getState().jumpToEvent('a', 'p1')
    release()
    await first
    await second
    expect(timelineBefore).toHaveBeenCalledTimes(1)
  })

  it('続けて押した 2 つ目のスレッドの読み込みが遅くても、1 つ目のために読み続けない (TODO 518-2)', async () => {
    // A store race found in run 30 of the proxy verification: the number was taken after `selectThread`, so if the second `timeline` was slow, the first held the newest number, read all the earlier pages, and moved the highlight back to itself.
    const { timelineBefore, useThreads } = await load([summary('a')], {
      101: { threadId: 'a', events: [older('p1')], notPersisted: false, oldestSeq: 90, remaining: 200 },
      90: { threadId: 'a', events: [older('p2')], notPersisted: false, oldestSeq: 80, remaining: 100 },
      80: { threadId: 'a', events: [older('far')], notPersisted: false, oldestSeq: 70, remaining: 0 }
    })
    const timeline = window.aios.threads.timeline as ReturnType<typeof vi.fn>
    let release: () => void = () => {}
    timeline.mockImplementationOnce((threadId: string) =>
      Promise.resolve({ threadId, events: [older('p0')], notPersisted: false, oldestSeq: 101, remaining: 250 })
    )
    timeline.mockImplementationOnce(
      (threadId: string) =>
        new Promise<Timeline>((resolve) => {
          release = () => resolve({ threadId, events: [older('p0')], notPersisted: false, oldestSeq: 101, remaining: 250 })
        })
    )
    const first = useThreads.getState().jumpToEvent('a', 'far')
    const second = useThreads.getState().jumpToEvent('a', 'p0')
    await first
    release()
    await second
    expect(timelineBefore).not.toHaveBeenCalled()
    expect(useThreads.getState().highlightEventId).toBe('p0')
  })

  it('読んでいる間に強調が 4 秒で解かれても読み続け、届いたら強調を付け直す (第 25 波の code-review)', async () => {
    let release: () => void = () => {}
    const { timelineBefore, useThreads } = await load([summary('a')], {
      90: { threadId: 'a', events: [older('target'), older('p2')], notPersisted: false, oldestSeq: 80, remaining: 100 }
    })
    timelineBefore.mockImplementationOnce(
      (threadId: string) =>
        new Promise<Timeline>((resolve) => {
          release = () => resolve({ threadId, events: [older('p1')], notPersisted: false, oldestSeq: 90, remaining: 200 })
        })
    )
    const jump = useThreads.getState().jumpToEvent('a', 'target')
    await flush()
    // Stands in for the 4-second timer of ThreadPane clearing the highlight.
    useThreads.setState({ highlightEventId: null })
    release()
    await jump
    expect(timelineBefore).toHaveBeenCalledTimes(2)
    expect(useThreads.getState().highlightEventId).toBe('target')
  })
})

describe('作業リストの固定表示 (項目 118、束 C)', () => {
  const list = (status: 'pending' | 'in_progress' | 'completed', toolUseId = 'tu1'): TodoList => ({
    toolUseId,
    items: [{ content: 'A', activeForm: 'Doing A', status }],
    at: 1
  })

  it('turn_usage / result で作業リストの中身が同じなら同じオブジェクトを使い回す', async () => {
    const { listeners, useThreads } = await load([summary('a')])
    listeners.item(summary('a', { todos: list('in_progress') }))
    const todos = selectors.todos('a')(useThreads.getState())
    expect(todos?.items[0]?.status).toBe('in_progress')
    listeners.item(summary('a', { state: 'running', usage: USAGE, todos: list('in_progress') }))
    listeners.item(summary('a', { state: 'idle', usage: USAGE, costUsd: 0.5, todos: list('in_progress') }))
    expect(selectors.todos('a')(useThreads.getState())).toBe(todos)
  })

  it('書き換えで固定表示だけが変わり、Composer 本体・見出し・他の行は変わらない', async () => {
    const { listeners, useThreads } = await load([summary('a'), summary('b')])
    await useThreads.getState().selectThread('a')
    listeners.item(summary('a', { todos: list('in_progress') }))
    const before = snapshot(useThreads.getState(), 'a', 'b')
    const todos = selectors.todos('a')(useThreads.getState())
    listeners.item(summary('a', { todos: list('completed', 'tu2') }))
    const state = useThreads.getState()
    expectSame(before, snapshot(state, 'a', 'b'))
    expect(selectors.todos('a')(state)).not.toBe(todos)
    expect(selectors.todos('a')(state)?.toolUseId).toBe('tu2')
  })
})

describe('子エージェントの塊 (項目 257、第 15 波 束 A)', () => {
  const ev = (id: string, patch: Partial<AiosEvent>): AiosEvent =>
    ({ id, sessionId: 's', threadId: 'a', ts: 1, actor: 'main', ...patch }) as AiosEvent
  const userText = (id: string): AiosEvent =>
    ev(id, { kind: 'user_text', payload: { text: 'q' } } as Partial<AiosEvent>)
  const childTool = (id: string, parent: string): AiosEvent =>
    ev(id, {
      actor: 'subagent',
      parentToolUseId: parent,
      kind: 'tool_use',
      payload: { toolUseId: `${id}-tu`, name: 'Read', summary: 'x.ts', input: {}, truncated: false }
    } as Partial<AiosEvent>)
  /** The same expression as the selectors of ThreadPane and SubagentBlock. */
  const pane = (s: State) => s.events['a']
  const block = (parent: string) => (s: State) => s.childEvents['a']?.[parent]

  it('子の行だけのバッチでは親の列 (ThreadPane) も他の塊も変わらず、その塊だけが伸びる', async () => {
    const { listeners, useThreads } = await load([summary('a'), summary('b')])
    await useThreads.getState().selectThread('a')
    listeners.events({ at: 0, events: [userText('m1')] } as AiosEventBatch)
    listeners.events({ at: 0, events: [childTool('c1', 'p1'), childTool('c2', 'p2')] } as AiosEventBatch)
    const before = snapshot(useThreads.getState(), 'a', 'b')
    const paneBefore = pane(useThreads.getState())
    const p2 = block('p2')(useThreads.getState())
    expect(paneBefore?.map((e) => e.id)).toEqual(['m1'])

    listeners.events({ at: 0, events: [childTool('c3', 'p1')] } as AiosEventBatch)
    const state = useThreads.getState()
    expectSame(before, snapshot(state, 'a', 'b'))
    expect(pane(state)).toBe(paneBefore)
    expect(block('p2')(state)).toBe(p2)
    expect(block('p1')(state)?.map((e) => e.id)).toEqual(['c1', 'c3'])
  })

  it('開いたときの読み込みでも子の行は塊へ入り、親の列には残らない', async () => {
    const { useThreads } = await load([summary('a')])
    const timeline = window.aios.threads.timeline as ReturnType<typeof vi.fn>
    timeline.mockResolvedValue({
      threadId: 'a',
      events: [userText('m1'), childTool('c1', 'p1')],
      notPersisted: false,
      oldestSeq: null,
      remaining: 0
    })
    await useThreads.getState().selectThread('a')
    const state = useThreads.getState()
    expect(pane(state)?.map((e) => e.id)).toEqual(['m1'])
    expect(block('p1')(state)?.map((e) => e.id)).toEqual(['c1'])
  })
})

describe('createThreadInFolder の focus (TODO 1142)', () => {
  it('open の間に別の行が選ばれても、focus は作ったスレッドへ渡す', async () => {
    const { useThreads } = await load([summary('a')], {})
    const aios = window.aios as unknown as {
      threads: { create: unknown; open: ReturnType<typeof vi.fn> }
    }
    aios.threads.create = vi.fn().mockResolvedValue({ id: 'n', title: 'n' })
    let release: () => void = () => {}
    aios.threads.open.mockImplementation((id: string) =>
      id === 'n' ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
    )
    useThreads.setState({ backends: [BACKEND] })
    const pending = useThreads.getState().createThreadInFolder(null)
    await flush()
    // Before the open of creation finished, the user pressed another row.
    await useThreads.getState().selectThread('a')
    release()
    await pending
    expect(useThreads.getState().activeThreadId).toBe('a')
    expect(useThreads.getState().composerFocus).toBe('n')
  })
})
