/**
 * How the renderer holds the thread list (item 75, ARCHITECTURE.md 4.3 "thread list delivery").
 * Pure functions that touch neither the DOM nor the store, so `test/thread-index.test.ts` checks them directly.
 *
 * main delivers the list in two ways: the whole list (`threadsChanged`: launch, create, delete, rename) and
 * a single row (`threadChanged`: `turn_usage` / `result` / approval / read, etc.). The renderer keeps it split into
 * `byId` (id -> row) and `order` (the order), and **reuses the same object for rows and order that did not change**.
 * A Zustand selector decides re-rendering by reference identity, so this removes "one row changing re-renders every row and ThreadPane".
 */
import { threadRecency, type ThreadSummary } from '@shared/thread.js'

export interface ThreadIndex {
  readonly byId: Readonly<Record<string, ThreadSummary>>
  /** Same order as main's list (newest last event first: `threadRecency`, item 83). */
  readonly order: readonly string[]
}

export const EMPTY_THREAD_INDEX: ThreadIndex = { byId: {}, order: [] }

/** Values arriving over IPC are new objects every time, so compare by contents (rows are small). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Aligns an arrived row with the previous one. Parts with the same contents (`thread` / `runtime`) reuse the previous
 * object, and if everything is the same the previous row itself is returned. A selector that pulls only `thread`
 * (the ThreadPane heading) does not re-render when only `runtime` changes on `turn_usage`.
 */
function reuse(previous: ThreadSummary | undefined, next: ThreadSummary): ThreadSummary {
  if (previous === undefined) return next
  const thread = same(previous.thread, next.thread) ? previous.thread : next.thread
  const runtime = same(previous.runtime, next.runtime)
    ? previous.runtime
    : reuseUsage(previous.runtime, next.runtime)
  if (thread === previous.thread && runtime === previous.runtime && previous.preview === next.preview) {
    return previous
  }
  return { thread, runtime, preview: next.preview }
}

/**
 * Even when `runtime` changes (state, cost, etc.), if the contents of `contextUsage` are the same the previous object is
 * reused (item 88). The Composer donut pulls only `runtime.contextUsage`, so it is not redrawn when
 * only the cost moves on `result`.
 */
function reuseUsage(
  previous: ThreadSummary['runtime'],
  next: ThreadSummary['runtime']
): ThreadSummary['runtime'] {
  // Reservations (item 94) work the same way: the chip pulls only `runtime.reservations`, so do not
  // rebuild them on every `turn_usage`.
  const reservations = same(previous.reservations, next.reservations)
    ? previous.reservations
    : next.reservations
  const usage =
    previous.contextUsage !== null &&
    next.contextUsage !== null &&
    previous.contextUsage !== next.contextUsage &&
    same(previous.contextUsage, next.contextUsage)
      ? previous.contextUsage
      : next.contextUsage
  // Running children (how item 93 shows them) are the same: the list component pulls only `runtime.subtasks`, so do not
  // rebuild them on every `turn_usage`.
  const subtasks = same(previous.subtasks, next.subtasks) ? previous.subtasks : next.subtasks
  // The task list (item 118) is the same: the pinned display pulls only `runtime.todos`, so do not rebuild it on every
  // `turn_usage`. Two nulls have the same reference, so there is no need to compare.
  const todos =
    previous.todos !== null &&
    next.todos !== null &&
    previous.todos !== next.todos &&
    same(previous.todos, next.todos)
      ? previous.todos
      : next.todos
  if (
    reservations === next.reservations &&
    usage === next.contextUsage &&
    subtasks === next.subtasks &&
    todos === next.todos
  ) {
    return next
  }
  return { ...next, reservations, contextUsage: usage, subtasks, todos }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Received the whole list. If there is a previous index, rows and order that did not change are reused. */
export function indexFromList(
  list: readonly ThreadSummary[],
  previous: ThreadIndex = EMPTY_THREAD_INDEX
): ThreadIndex {
  const byId: Record<string, ThreadSummary> = {}
  const order: string[] = []
  let changed = list.length !== previous.order.length
  for (const summary of list) {
    const id = summary.thread.id
    const row = reuse(previous.byId[id], summary)
    if (row !== previous.byId[id]) changed = true
    byId[id] = row
    order.push(id)
  }
  if (!changed && sameOrder(order, previous.order)) return previous
  return {
    byId,
    order: sameOrder(order, previous.order) ? previous.order : order
  }
}

/**
 * Received one row. Replaces the row, and if the ordering key (`threadRecency` = the last event, item 83) has moved,
 * fixes the order (newest first; for equal times the row that moved goes first). Marking read or changing settings
 * (only `updatedAt` moves) does not change the order. Deletion arrives via the whole-list delivery.
 * If nothing changes, returns `index` as is.
 */
export function applyThreadChange(index: ThreadIndex, summary: ThreadSummary): ThreadIndex {
  const id = summary.thread.id
  const previous = index.byId[id]

  const row = reuse(previous, summary)
  if (row === previous) return index
  const byId = { ...index.byId, [id]: row }

  const recency = threadRecency(row.thread)
  if (previous !== undefined && threadRecency(previous.thread) === recency) {
    return { byId, order: index.order }
  }
  const rest = index.order.filter((other) => other !== id)
  let at = rest.findIndex((other) => {
    const thread = byId[other]?.thread
    return (thread === undefined ? 0 : threadRecency(thread)) <= recency
  })
  if (at === -1) at = rest.length
  const order = [...rest.slice(0, at), id, ...rest.slice(at)]
  return { byId, order: sameOrder(order, index.order) ? index.order : order }
}
