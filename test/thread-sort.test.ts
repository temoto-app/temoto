/**
 * The display order of the thread list (item 152) and the strength of marks (item 151). Pure functions in `src/renderer/src/thread-sort.ts`.
 *
 * What is guarded:
 * - Update order (the default) is main's order as is.
 * - Unread order: awaiting approval -> unread -> others. Within a group, update order. A selected row stays in the group it was in when selected, and is re-sorted only when another thread is selected or the condition is switched.
 * - Cwd order: per-folder groups with subheadings. Folders are ordered by their most recent update; rows with no folder are last.
 * - The material for re-sorting (the selector's result) is shallowly the same when only `runtime` cost changes in a single delivery, like `turn_usage` (`useShallow` returns the previous array, so it does not re-sort).
 * - The condition is remembered in `localStorage`, and broken values fall back to the default.
 */
import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { Thread, ThreadRuntime, ThreadSummary } from '../src/shared/thread.js'
import { applyThreadChange, indexFromList } from '../src/renderer/src/thread-index.js'
import {
  DEFAULT_THREAD_SORT,
  THREAD_SORT_KEY,
  anyThreadRunning,
  arrangeThreads,
  attentionOf,
  loadThreadSort,
  maxAttention,
  nextCollapseBoundary,
  nextPin,
  parseThreadSort,
  saveThreadSort,
  selectAttention,
  selectCollapsible,
  selectFolderThreads,
  toSortRows,
  type SortRow,
  type ThreadListItem
} from '../src/renderer/src/thread-sort.js'
import { DAY_MS } from '../src/renderer/src/row-time.js'
import type { PrefStorage } from '../src/renderer/src/uiPrefs.js'

function summary(
  id: string,
  recency: number,
  patch: {
    unread?: boolean
    pending?: number
    state?: string
    cwd?: string
    rainbow?: number | null
    costUsd?: number
    subtasks?: number
  } = {}
): ThreadSummary {
  const cwd = patch.cwd ?? ''
  const thread = {
    id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    lastEventAt: recency,
    unread: patch.unread ?? false,
    cwdUri: cwd === '' ? `file:///Users/tester/aios/scratch/${id}` : `file:///Users/tester/${cwd}`,
    cwdName: cwd,
    rainbow: cwd === '' ? null : (patch.rainbow ?? 3),
    allowedDirUris: []
  } as unknown as Thread
  const runtime = {
    threadId: id,
    state: patch.state ?? 'idle',
    pendingApprovals: patch.pending ?? 0,
    costUsd: patch.costUsd ?? 0,
    subtasks: Array.from({ length: patch.subtasks ?? 0 }, (_, i) => ({ id: `sub${i}` }))
  } as unknown as ThreadRuntime
  return { thread, runtime, preview: null }
}

function row(id: string, patch: Partial<SortRow> = {}): SortRow {
  return {
    id,
    attention: 0,
    folderKey: '',
    folderName: '',
    folderUri: null,
    rainbow: null,
    collapsible: false,
    ...patch
  }
}

function ids(items: readonly ThreadListItem[]): string[] {
  return items.map((item) =>
    item.kind === 'thread' ? item.id : item.kind === 'folder' ? `[${item.name}]` : `(more:${item.count})`
  )
}

describe('attentionOf (項目 151)', () => {
  it('承認待ち (件数か状態のどちらか) は未読より強い', () => {
    expect(attentionOf(summary('a', 1, { pending: 2 }))).toBe(2)
    expect(attentionOf(summary('a', 1, { state: 'awaiting-approval' }))).toBe(2)
    expect(attentionOf(summary('a', 1, { pending: 1, unread: true }))).toBe(2)
    expect(attentionOf(summary('a', 1, { unread: true }))).toBe(1)
    expect(attentionOf(summary('a', 1))).toBe(0)
    expect(attentionOf(undefined)).toBe(0)
  })

  it('一覧全体でいちばん強い印 (アクティビティバーの点)', () => {
    const index = indexFromList([summary('a', 3), summary('b', 2, { unread: true }), summary('c', 1)])
    expect(maxAttention(index.order, index.byId)).toBe(1)
    const withApproval = applyThreadChange(index, summary('c', 1, { pending: 1 }))
    expect(maxAttention(withApproval.order, withApproval.byId)).toBe(2)
    expect(maxAttention([], {})).toBe(0)
  })
})

describe('anyThreadRunning (TODO 528)', () => {
  it('1 つでも running なら真', () => {
    const index = indexFromList([
      summary('a', 3, { state: 'idle' }),
      summary('b', 2, { state: 'running' }),
      summary('c', 1, { state: 'awaiting-approval' })
    ])
    expect(anyThreadRunning(index.order, index.byId)).toBe(true)
  })

  it('running が無ければ偽、空でも偽 (承認待ちも偽)', () => {
    const index = indexFromList([summary('a', 3, { state: 'idle' }), summary('c', 1, { state: 'awaiting-approval' })])
    expect(anyThreadRunning(index.order, index.byId)).toBe(false)
    expect(anyThreadRunning([], {})).toBe(false)
  })

  it('starting / stopping も真 (一覧の行と同じ判定、TODO 1097)', () => {
    for (const state of ['starting', 'stopping']) {
      const index = indexFromList([summary('a', 1, { state })])
      expect(anyThreadRunning(index.order, index.byId)).toBe(true)
    }
  })

  it('idle でも子エージェントが動いていれば真、全部終われば偽 (TODO 1097)', () => {
    const running = indexFromList([summary('a', 1, { state: 'idle', subtasks: 1 })])
    expect(anyThreadRunning(running.order, running.byId)).toBe(true)
    const done = indexFromList([summary('a', 1, { state: 'idle', subtasks: 0 })])
    expect(anyThreadRunning(done.order, done.byId)).toBe(false)
  })
})

describe('arrangeThreads', () => {
  const rows = [
    row('a'),
    row('b', { attention: 1 }),
    row('c', { attention: 2 }),
    row('d'),
    row('e', { attention: 1 })
  ]

  it('更新順はそのまま', () => {
    expect(ids(arrangeThreads('recent', rows))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('未読順: 承認待ち → 未読 → その他、組の中は更新順', () => {
    expect(ids(arrangeThreads('unread', rows))).toEqual(['c', 'b', 'e', 'a', 'd'])
  })

  it('未読順: 選んでいる行は選んだ時点の組に留まる', () => {
    // b was selected (it was unread) -> even after opening it and marking it read, it stays in the unread group.
    const pin = nextPin(null, 'b', 1, 'unread')
    const afterRead = rows.map((r) => (r.id === 'b' ? { ...r, attention: 0 as const } : r))
    expect(ids(arrangeThreads('unread', afterRead, pin))).toEqual(['c', 'b', 'e', 'a', 'd'])
    // Selecting another thread (a) re-takes the mark, and b is re-sorted into its original group (others).
    const moved = nextPin(pin, 'a', 0, 'unread')
    expect(ids(arrangeThreads('unread', afterRead, moved))).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('未読順: 選んでいる間に承認待ちになっても跳ねない', () => {
    const pin = nextPin(null, 'a', 0, 'unread')
    const approval = rows.map((r) => (r.id === 'a' ? { ...r, attention: 2 as const } : r))
    expect(ids(arrangeThreads('unread', approval, pin))).toEqual(['c', 'b', 'e', 'a', 'd'])
  })

  it('cwd 順: フォルダは最新の更新順、所属なしは最後、組ごとに小見出し', () => {
    const folderRows = [
      row('s1'), // No folder (the newest, but goes last).
      row('x1', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', rainbow: 1 }),
      row('y1', { folderKey: 'file:///y', folderName: 'y', folderUri: 'file:///y', rainbow: 2 }),
      row('x2', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', rainbow: 1 }),
      row('s2')
    ]
    const items = arrangeThreads('cwd', folderRows)
    expect(ids(items)).toEqual(['[x]', 'x1', 'x2', '[y]', 'y1', '[]', 's1', 's2'])
    const headings = items.filter((i) => i.kind === 'folder')
    expect(headings).toEqual([
      { kind: 'folder', key: 'file:///x', name: 'x', uri: 'file:///x', rainbow: 1, count: 2 },
      { kind: 'folder', key: 'file:///y', name: 'y', uri: 'file:///y', rainbow: 2, count: 1 },
      { kind: 'folder', key: '', name: '', uri: null, rainbow: null, count: 2 }
    ])
  })

  it('cwd 順: 同じ名前でも場所が違えば別の組', () => {
    const items = arrangeThreads('cwd', [
      row('a', { folderKey: 'file:///p/app', folderName: 'app', folderUri: 'file:///p/app' }),
      row('b', { folderKey: 'file:///q/app', folderName: 'app', folderUri: 'file:///q/app' })
    ])
    expect(items.filter((i) => i.kind === 'folder')).toHaveLength(2)
  })

  it('cwd 順と更新順では選択の印を使わない', () => {
    const pin = nextPin(null, 'b', 2, 'unread')
    expect(ids(arrangeThreads('recent', rows, pin))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('arrangeThreads: 畳み (TODO 659)', () => {
  it('recent / unread: collapsible な行は末尾の「さらに表示」へ、順は保つ。展開すればその後ろに並ぶ', () => {
    const collapsibleRows = [
      row('a'),
      row('b', { collapsible: true }),
      row('c'),
      row('d', { collapsible: true })
    ]
    expect(ids(arrangeThreads('recent', collapsibleRows))).toEqual(['a', 'c', '(more:2)'])
    expect(ids(arrangeThreads('recent', collapsibleRows, null, true))).toEqual(['a', 'c', '(more:2)', 'b', 'd'])
  })

  it('collapsible な行が無ければ「さらに表示」は出ない', () => {
    expect(ids(arrangeThreads('recent', [row('a'), row('b')]))).toEqual(['a', 'b'])
  })

  it('unread: 畳みは組分けの後に掛かる (印が付けば collapsible ではない行として届く想定)', () => {
    const rowsU = [
      row('a', { attention: 1 }),
      row('b', { collapsible: true }),
      row('c', { attention: 2 })
    ]
    expect(ids(arrangeThreads('unread', rowsU))).toEqual(['c', 'a', '(more:1)'])
  })

  it('cwd: 組の行が全部 collapsible なら見出しごと畳む。1 行でも畳まない行があれば組はそのまま', () => {
    const cwdRows = [
      row('x1', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', collapsible: true }),
      row('x2', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', collapsible: true }),
      row('y1', { folderKey: 'file:///y', folderName: 'y', folderUri: 'file:///y', collapsible: true }),
      row('y2', { folderKey: 'file:///y', folderName: 'y', folderUri: 'file:///y', collapsible: false })
    ]
    const collapsed = arrangeThreads('cwd', cwdRows)
    expect(ids(collapsed)).toEqual(['[y]', 'y1', 'y2', '(more:2)'])
    const expanded = arrangeThreads('cwd', cwdRows, null, true)
    expect(ids(expanded)).toEqual(['[y]', 'y1', 'y2', '(more:2)', '[x]', 'x1', 'x2'])
  })

  it('TODO 956: 選んでいるフォルダの組は古い行だけでも畳まない。並びは変えない', () => {
    const cwdRows = [
      row('y1', { folderKey: 'file:///y', folderName: 'y', folderUri: 'file:///y' }),
      row('x1', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', collapsible: true }),
      row('x2', { folderKey: 'file:///x', folderName: 'x', folderUri: 'file:///x', collapsible: true }),
      row('z1', { folderKey: 'file:///z', folderName: 'z', folderUri: 'file:///z', collapsible: true })
    ]
    expect(ids(arrangeThreads('cwd', cwdRows))).toEqual(['[y]', 'y1', '(more:3)'])
    expect(ids(arrangeThreads('cwd', cwdRows, null, false, 'file:///x'))).toEqual(['[y]', 'y1', '[x]', 'x1', 'x2', '(more:1)'])
  })
})

describe('nextPin', () => {
  it('同じ行・同じ条件なら同じオブジェクト (再描画のたびに取り直さない)', () => {
    const pin = nextPin(null, 'a', 1, 'unread')
    expect(nextPin(pin, 'a', 0, 'unread')).toBe(pin)
  })
  it('条件を切り替えたら、そのときの強さで取り直す', () => {
    const pin = nextPin(null, 'a', 1, 'recent')
    expect(nextPin(pin, 'a', 0, 'unread')).toEqual({ id: 'a', attention: 0, key: 'unread' })
  })
  it('選択が無ければ印も無い', () => {
    expect(nextPin(nextPin(null, 'a', 1, 'unread'), null, 0, 'unread')).toBeNull()
  })
})

describe('並べ直しの材料 (selector) と高頻度の push', () => {
  const list = [
    summary('a', 3, { cwd: 'proj', unread: true }),
    summary('b', 2, { cwd: '' }),
    summary('c', 1, { cwd: 'proj', pending: 1 })
  ]

  it('更新順では材料を引かない (空の定数)', () => {
    const index = indexFromList(list)
    expect(selectAttention('recent', index.order, index.byId)).toBe(
      selectAttention('cwd', index.order, index.byId)
    )
    expect(selectFolderThreads('recent', index.order, index.byId)).toHaveLength(0)
  })

  it('費用だけが動く 1 件の配信 (turn_usage / result) では浅く同じ', () => {
    const before = indexFromList(list)
    const after = applyThreadChange(before, summary('a', 3, { cwd: 'proj', unread: true, costUsd: 0.5 }))
    expect(after.byId['a']).not.toBe(before.byId['a'])
    for (const key of ['unread', 'cwd'] as const) {
      expect(
        shallow(selectAttention(key, before.order, before.byId), selectAttention(key, after.order, after.byId))
      ).toBe(true)
      expect(
        shallow(
          selectFolderThreads(key, before.order, before.byId),
          selectFolderThreads(key, after.order, after.byId)
        )
      ).toBe(true)
    }
  })

  it('未読が変われば未読順の材料は変わる (cwd 順の材料は thread ごと変わる)', () => {
    const before = indexFromList(list)
    const after = applyThreadChange(before, summary('a', 3, { cwd: 'proj', unread: false }))
    expect(
      shallow(selectAttention('unread', before.order, before.byId), selectAttention('unread', after.order, after.byId))
    ).toBe(false)
  })

  it('材料から行を組んで並べる (実物の ThreadSummary から)', () => {
    const index = indexFromList(list)
    const unread = toSortRows(
      index.order,
      selectAttention('unread', index.order, index.byId),
      selectFolderThreads('unread', index.order, index.byId)
    )
    expect(ids(arrangeThreads('unread', unread))).toEqual(['c', 'a', 'b'])
    const cwd = toSortRows(
      index.order,
      selectAttention('cwd', index.order, index.byId),
      selectFolderThreads('cwd', index.order, index.byId)
    )
    expect(ids(arrangeThreads('cwd', cwd))).toEqual(['[proj]', 'a', 'c', '[]', 'b'])
  })
})

describe('selectCollapsible (TODO 659)', () => {
  const NOW = 1_000_000 * DAY_MS
  const OLD = NOW - 10 * DAY_MS
  const RECENT = NOW - 1 * DAY_MS

  it('collapseDays <= 0 なら空の定数 (畳まない設定)', () => {
    const index = indexFromList([summary('a', OLD)])
    expect(selectCollapsible(0, NOW, null, false, index.order, index.byId)).toHaveLength(0)
    expect(selectCollapsible(-1, NOW, null, false, index.order, index.byId)).toHaveLength(0)
  })

  it('古さだけで決まる: cutoff より前は畳む対象、後は違う', () => {
    const index = indexFromList([summary('a', OLD), summary('b', RECENT)])
    expect(selectCollapsible(5, NOW, null, false, index.order, index.byId)).toEqual([true, false])
  })

  it('印のある行 (承認待ち・未読・中断) は古くても畳まない', () => {
    const index = indexFromList([
      summary('a', OLD, { pending: 1 }),
      summary('b', OLD, { unread: true }),
      summary('c', OLD)
    ])
    expect(selectCollapsible(5, NOW, null, false, index.order, index.byId)).toEqual([false, false, true])
  })

  it('実行中・選択中の行は古くても畳まない (展開していないとき)', () => {
    const index = indexFromList([summary('a', OLD, { state: 'running' }), summary('b', OLD)])
    expect(selectCollapsible(5, NOW, 'b', false, index.order, index.byId)).toEqual([false, false])
  })

  // code-review fix: not only `running`, but any state other than `idle` (starting, stopping, error) is also not folded. So an old row stopped by an error does not get hidden from the list.
  it('idle 以外の状態 (starting / stopping / error) は古くても畳まない', () => {
    const index = indexFromList([
      summary('a', OLD, { state: 'starting' }),
      summary('b', OLD, { state: 'stopping' }),
      summary('c', OLD, { state: 'error' }),
      summary('d', OLD, { state: 'idle' })
    ])
    expect(selectCollapsible(5, NOW, null, false, index.order, index.byId)).toEqual([
      false,
      false,
      false,
      true
    ])
  })

  // code-review fix: the exemption for an old selected row applies only when it is folded (not expanded). While expanded, even a selected row stays at its folded position (it does not jump).
  it('展開中は選択中でも免除しない (跳ねない)', () => {
    const index = indexFromList([summary('a', OLD), summary('b', OLD)])
    expect(selectCollapsible(5, NOW, 'b', false, index.order, index.byId)).toEqual([true, false])
    expect(selectCollapsible(5, NOW, 'b', true, index.order, index.byId)).toEqual([true, true])
  })
})

// code-review fix: material for setting one timer at the next time a boundary is crossed, instead of a clock every 30 seconds.
describe('nextCollapseBoundary (TODO 659、code-review の直し)', () => {
  const NOW = 1_000_000 * DAY_MS

  it('collapseDays <= 0 ならタイマーは要らない (null)', () => {
    const index = indexFromList([summary('a', NOW - 1 * DAY_MS)])
    expect(nextCollapseBoundary(0, NOW, index.order, index.byId)).toBeNull()
  })

  it('まだ畳まれていない行の中で最小の境界を返す', () => {
    const index = indexFromList([
      summary('a', NOW - 1 * DAY_MS), // The boundary is NOW + 4 days later.
      summary('b', NOW - 3 * DAY_MS) // The boundary is NOW + 2 days later (this one comes first).
    ])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBe(NOW - 3 * DAY_MS + 5 * DAY_MS)
  })

  it('既に cutoff を過ぎた行 (もう畳む対象) は数えない', () => {
    const index = indexFromList([summary('a', NOW - 10 * DAY_MS)])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBeNull()
  })

  it('印のある行・idle でない行は時間で畳まれないので数えない', () => {
    const index = indexFromList([
      summary('a', NOW - 1 * DAY_MS, { unread: true }),
      summary('b', NOW - 1 * DAY_MS, { state: 'running' })
    ])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBeNull()
  })
})

describe('覚える場所 (localStorage)', () => {
  function memory(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
    const data = { ...initial }
    return {
      data,
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value
      }
    }
  }

  it('保存して読み戻す', () => {
    const storage = memory()
    expect(loadThreadSort(storage)).toBe(DEFAULT_THREAD_SORT)
    saveThreadSort('cwd', storage)
    expect(storage.data[THREAD_SORT_KEY]).toBe('cwd')
    expect(loadThreadSort(storage)).toBe('cwd')
  })

  it('壊れた値・読めない環境は既定 (更新順)', () => {
    expect(loadThreadSort(memory({ [THREAD_SORT_KEY]: 'title' }))).toBe('recent')
    expect(loadThreadSort(undefined)).toBe('recent')
    const throwing: PrefStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(loadThreadSort(throwing)).toBe('recent')
    expect(() => saveThreadSort('unread', throwing)).not.toThrow()
  })

  it('別の窓からの変更 (storage イベント) は知っている値だけ採る', () => {
    expect(parseThreadSort('unread')).toBe('unread')
    expect(parseThreadSort('created')).toBeNull()
    expect(parseThreadSort(null)).toBeNull()
  })
})
