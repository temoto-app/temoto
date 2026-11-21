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

describe('attentionOf (item 151)', () => {
  it('awaiting approval (either the count or the state) beats unread', () => {
    expect(attentionOf(summary('a', 1, { pending: 2 }))).toBe(2)
    expect(attentionOf(summary('a', 1, { state: 'awaiting-approval' }))).toBe(2)
    expect(attentionOf(summary('a', 1, { pending: 1, unread: true }))).toBe(2)
    expect(attentionOf(summary('a', 1, { unread: true }))).toBe(1)
    expect(attentionOf(summary('a', 1))).toBe(0)
    expect(attentionOf(undefined)).toBe(0)
  })

  it('the strongest mark in the whole list (the dot of the activity bar)', () => {
    const index = indexFromList([summary('a', 3), summary('b', 2, { unread: true }), summary('c', 1)])
    expect(maxAttention(index.order, index.byId)).toBe(1)
    const withApproval = applyThreadChange(index, summary('c', 1, { pending: 1 }))
    expect(maxAttention(withApproval.order, withApproval.byId)).toBe(2)
    expect(maxAttention([], {})).toBe(0)
  })
})

describe('anyThreadRunning (TODO 528)', () => {
  it('true if even one is running', () => {
    const index = indexFromList([
      summary('a', 3, { state: 'idle' }),
      summary('b', 2, { state: 'running' }),
      summary('c', 1, { state: 'awaiting-approval' })
    ])
    expect(anyThreadRunning(index.order, index.byId)).toBe(true)
  })

  it('false when none is running, and false when empty (awaiting approval is false too)', () => {
    const index = indexFromList([summary('a', 3, { state: 'idle' }), summary('c', 1, { state: 'awaiting-approval' })])
    expect(anyThreadRunning(index.order, index.byId)).toBe(false)
    expect(anyThreadRunning([], {})).toBe(false)
  })

  it('starting / stopping are true too (same judgment as a list row, TODO 1097)', () => {
    for (const state of ['starting', 'stopping']) {
      const index = indexFromList([summary('a', 1, { state })])
      expect(anyThreadRunning(index.order, index.byId)).toBe(true)
    }
  })

  it('true when a child agent is running even if idle, and false when all are done (TODO 1097)', () => {
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

  it('recent order is left as is', () => {
    expect(ids(arrangeThreads('recent', rows))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('unread order: awaiting approval → unread → others, and recent order within a group', () => {
    expect(ids(arrangeThreads('unread', rows))).toEqual(['c', 'b', 'e', 'a', 'd'])
  })

  it('unread order: the selected row stays in the group it was in when selected', () => {
    // b was selected (it was unread) -> even after opening it and marking it read, it stays in the unread group.
    const pin = nextPin(null, 'b', 1, 'unread')
    const afterRead = rows.map((r) => (r.id === 'b' ? { ...r, attention: 0 as const } : r))
    expect(ids(arrangeThreads('unread', afterRead, pin))).toEqual(['c', 'b', 'e', 'a', 'd'])
    // Selecting another thread (a) re-takes the mark, and b is re-sorted into its original group (others).
    const moved = nextPin(pin, 'a', 0, 'unread')
    expect(ids(arrangeThreads('unread', afterRead, moved))).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('unread order: does not jump even if it becomes awaiting approval while selected', () => {
    const pin = nextPin(null, 'a', 0, 'unread')
    const approval = rows.map((r) => (r.id === 'a' ? { ...r, attention: 2 as const } : r))
    expect(ids(arrangeThreads('unread', approval, pin))).toEqual(['c', 'b', 'e', 'a', 'd'])
  })

  it('cwd order: folders by latest update, no affiliation last, with a subheading per group', () => {
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

  it('cwd order: the same name in a different place is a different group', () => {
    const items = arrangeThreads('cwd', [
      row('a', { folderKey: 'file:///p/app', folderName: 'app', folderUri: 'file:///p/app' }),
      row('b', { folderKey: 'file:///q/app', folderName: 'app', folderUri: 'file:///q/app' })
    ])
    expect(items.filter((i) => i.kind === 'folder')).toHaveLength(2)
  })

  it('cwd order and recent order do not use the selection mark', () => {
    const pin = nextPin(null, 'b', 2, 'unread')
    expect(ids(arrangeThreads('recent', rows, pin))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('arrangeThreads: collapse (TODO 659)', () => {
  it('recent / unread: collapsible rows go to the trailing 「さらに表示」 keeping their order, and when expanded they follow it', () => {
    const collapsibleRows = [
      row('a'),
      row('b', { collapsible: true }),
      row('c'),
      row('d', { collapsible: true })
    ]
    expect(ids(arrangeThreads('recent', collapsibleRows))).toEqual(['a', 'c', '(more:2)'])
    expect(ids(arrangeThreads('recent', collapsibleRows, null, true))).toEqual(['a', 'c', '(more:2)', 'b', 'd'])
  })

  it('「さらに表示」 does not appear when there is no collapsible row', () => {
    expect(ids(arrangeThreads('recent', [row('a'), row('b')]))).toEqual(['a', 'b'])
  })

  it('unread: the collapse applies after grouping (a row that gets a mark is expected to arrive as not collapsible)', () => {
    const rowsU = [
      row('a', { attention: 1 }),
      row('b', { collapsible: true }),
      row('c', { attention: 2 })
    ]
    expect(ids(arrangeThreads('unread', rowsU))).toEqual(['c', 'a', '(more:1)'])
  })

  it('cwd: when all rows of a group are collapsible, collapses it with its heading, and when even one row is not collapsed the group stays as is', () => {
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

  it('TODO 956: the group of the selected folder is not collapsed even when only old rows remain, and the order does not change', () => {
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
  it('the same rows and the same conditions give the same object (not re-fetched on every redraw)', () => {
    const pin = nextPin(null, 'a', 1, 'unread')
    expect(nextPin(pin, 'a', 0, 'unread')).toBe(pin)
  })
  it('when the condition is switched, re-fetched with the strength at that time', () => {
    const pin = nextPin(null, 'a', 1, 'recent')
    expect(nextPin(pin, 'a', 0, 'unread')).toEqual({ id: 'a', attention: 0, key: 'unread' })
  })
  it('no selection means no mark', () => {
    expect(nextPin(nextPin(null, 'a', 1, 'unread'), null, 0, 'unread')).toBeNull()
  })
})

describe('re-sorting material (selector) and high-frequency push', () => {
  const list = [
    summary('a', 3, { cwd: 'proj', unread: true }),
    summary('b', 2, { cwd: '' }),
    summary('c', 1, { cwd: 'proj', pending: 1 })
  ]

  it('does not pull the material in recent order (an empty constant)', () => {
    const index = indexFromList(list)
    expect(selectAttention('recent', index.order, index.byId)).toBe(
      selectAttention('cwd', index.order, index.byId)
    )
    expect(selectFolderThreads('recent', index.order, index.byId)).toHaveLength(0)
  })

  it('a delivery of 1 item where only the cost moves (turn_usage / result) is shallow-equal', () => {
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

  it('when unread changes, the unread-order material changes (the cwd-order material changes per thread)', () => {
    const before = indexFromList(list)
    const after = applyThreadChange(before, summary('a', 3, { cwd: 'proj', unread: false }))
    expect(
      shallow(selectAttention('unread', before.order, before.byId), selectAttention('unread', after.order, after.byId))
    ).toBe(false)
  })

  it('builds and sorts rows from the material (from real ThreadSummary)', () => {
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

  it('an empty constant when collapseDays <= 0 (the no-collapse setting)', () => {
    const index = indexFromList([summary('a', OLD)])
    expect(selectCollapsible(0, NOW, null, false, index.order, index.byId)).toHaveLength(0)
    expect(selectCollapsible(-1, NOW, null, false, index.order, index.byId)).toHaveLength(0)
  })

  it('decided by age alone: before the cutoff is a collapse target, after it is not', () => {
    const index = indexFromList([summary('a', OLD), summary('b', RECENT)])
    expect(selectCollapsible(5, NOW, null, false, index.order, index.byId)).toEqual([true, false])
  })

  it('rows with a mark (awaiting approval, unread, interrupted) are not collapsed even when old', () => {
    const index = indexFromList([
      summary('a', OLD, { pending: 1 }),
      summary('b', OLD, { unread: true }),
      summary('c', OLD)
    ])
    expect(selectCollapsible(5, NOW, null, false, index.order, index.byId)).toEqual([false, false, true])
  })

  it('running and selected rows are not collapsed even when old (when not expanded)', () => {
    const index = indexFromList([summary('a', OLD, { state: 'running' }), summary('b', OLD)])
    expect(selectCollapsible(5, NOW, 'b', false, index.order, index.byId)).toEqual([false, false])
  })

  // code-review fix: not only `running`, but any state other than `idle` (starting, stopping, error) is also not folded. So an old row stopped by an error does not get hidden from the list.
  it('states other than idle (starting / stopping / error) are not collapsed even when old', () => {
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
  it('while expanded, the selected row is not exempt (does not jump)', () => {
    const index = indexFromList([summary('a', OLD), summary('b', OLD)])
    expect(selectCollapsible(5, NOW, 'b', false, index.order, index.byId)).toEqual([true, false])
    expect(selectCollapsible(5, NOW, 'b', true, index.order, index.byId)).toEqual([true, true])
  })
})

// code-review fix: material for setting one timer at the next time a boundary is crossed, instead of a clock every 30 seconds.
describe('nextCollapseBoundary (TODO 659, code-review fix)', () => {
  const NOW = 1_000_000 * DAY_MS

  it('no timer is needed when collapseDays <= 0 (null)', () => {
    const index = indexFromList([summary('a', NOW - 1 * DAY_MS)])
    expect(nextCollapseBoundary(0, NOW, index.order, index.byId)).toBeNull()
  })

  it('returns the smallest boundary among rows not yet collapsed', () => {
    const index = indexFromList([
      summary('a', NOW - 1 * DAY_MS), // The boundary is NOW + 4 days later.
      summary('b', NOW - 3 * DAY_MS) // The boundary is NOW + 2 days later (this one comes first).
    ])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBe(NOW - 3 * DAY_MS + 5 * DAY_MS)
  })

  it('does not count rows already past the cutoff (already collapse targets)', () => {
    const index = indexFromList([summary('a', NOW - 10 * DAY_MS)])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBeNull()
  })

  it('does not count rows with a mark or not idle, since they are not collapsed by time', () => {
    const index = indexFromList([
      summary('a', NOW - 1 * DAY_MS, { unread: true }),
      summary('b', NOW - 1 * DAY_MS, { state: 'running' })
    ])
    expect(nextCollapseBoundary(5, NOW, index.order, index.byId)).toBeNull()
  })
})

describe('where it is remembered (localStorage)', () => {
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

  it('saves and reads back', () => {
    const storage = memory()
    expect(loadThreadSort(storage)).toBe(DEFAULT_THREAD_SORT)
    saveThreadSort('cwd', storage)
    expect(storage.data[THREAD_SORT_KEY]).toBe('cwd')
    expect(loadThreadSort(storage)).toBe('cwd')
  })

  it('a broken value or an unreadable environment gives the default (recent order)', () => {
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

  it('a change from another window (storage event) takes only known values', () => {
    expect(parseThreadSort('unread')).toBe('unread')
    expect(parseThreadSort('created')).toBeNull()
    expect(parseThreadSort(null)).toBeNull()
  })
})
