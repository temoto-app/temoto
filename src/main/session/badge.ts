/**
 * Dock badge count (TODO 73, ARCHITECTURE.md 3.1 / 4.3).
 *
 * Pure functions only. Does not touch electron (`app.dock.setBadge` is called by main/index.ts).
 *
 * How it counts (owner decision 2026-09-23): **the number of threads with an unread answer + the number of pending approvals**.
 * Even if one thread has both an unread answer and a pending approval, it is not double-counted (each is counted
 * as 1 separately): "number of threads" and "number of items" are different units being summed, so one thread
 * contributing 1 to each is not a duplicate.
 */
import { threadRecency, type ApprovalItem, type ThreadSummary } from '../../shared/thread.js'

/** The minimum thread information counted in the badge. The whole `Thread` need not be passed. */
export interface BadgeThread {
  readonly unread: boolean
  /** TODO 1302: a response is being generated (the session is starting or running; waiting for an approval is not "running"). */
  readonly running?: boolean
  /** TODO 1303: the title as stored (an empty string means "no name yet"). Shown in the menu bar menu only; never logged. */
  readonly title?: string
  /** TODO 1303: the last activity (`threadRecency`), to order the rows. */
  readonly recency?: number
}

/** The badge's view of a thread summary (the one place that maps a summary to `BadgeThread`; `index.ts` keeps the result per thread id). */
export function badgeThreadOf(summary: ThreadSummary): BadgeThread {
  const state = summary.runtime.state
  return {
    unread: summary.thread.unread,
    running: state === 'starting' || state === 'running',
    title: summary.thread.title,
    recency: threadRecency(summary.thread)
  }
}

/** Unread thread count + pending approval count. If 0 it may be removed from the Dock (the caller converts it to `''`). */
export function countBadge(
  threads: readonly BadgeThread[],
  approvals: readonly ApprovalItem[]
): number {
  const unreadThreads = threads.reduce((n, thread) => (thread.unread ? n + 1 : n), 0)
  return unreadThreads + approvals.length
}

/** One conversation in a menu bar list. `title` is as stored (empty = "no name yet"; the menu puts its own word there). */
export interface TrayThreadRow {
  readonly threadId: string
  readonly title: string
}

/** The lists the menu bar menu names (TODO 1303). A conversation is in at most one of the first three: waiting for an approval, then running, then unread. */
export interface TrayThreadLists {
  readonly approvals: readonly TrayThreadRow[]
  readonly running: readonly TrayThreadRow[]
  readonly unread: readonly TrayThreadRow[]
}

/**
 * Builds the lists from the same maps as the Dock badge (no second tally). Approvals come first, oldest request first, one row per conversation; running and
 * unread are newest activity first. A conversation that is not in `threads` any more (deleted) gets no row, even when an approval of it is still queued.
 */
export function trayThreadLists(
  threads: ReadonlyMap<string, BadgeThread>,
  approvals: readonly ApprovalItem[]
): TrayThreadLists {
  const seen = new Set<string>()
  const approvalRows: TrayThreadRow[] = []
  for (const item of [...approvals].sort((a, b) => a.requestedAt - b.requestedAt)) {
    const thread = threads.get(item.threadId)
    if (thread === undefined || seen.has(item.threadId)) continue
    seen.add(item.threadId)
    approvalRows.push({ threadId: item.threadId, title: thread.title ?? item.threadTitle })
  }
  const rest = [...threads.entries()]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => (b[1].recency ?? 0) - (a[1].recency ?? 0))
  const row = ([id, thread]: [string, BadgeThread]): TrayThreadRow => ({ threadId: id, title: thread.title ?? '' })
  return {
    approvals: approvalRows,
    running: rest.filter(([, thread]) => thread.running === true).map(row),
    unread: rest.filter(([, thread]) => thread.running !== true && thread.unread).map(row)
  }
}

/** TODO 1301: the most recently active conversations, newest first (deleted ones are not in the map). */
export function recentThreadRows(threads: ReadonlyMap<string, BadgeThread>, limit: number): readonly TrayThreadRow[] {
  return [...threads.entries()]
    .sort((a, b) => (b[1].recency ?? 0) - (a[1].recency ?? 0))
    .slice(0, limit)
    .map(([id, thread]) => ({ threadId: id, title: thread.title ?? '' }))
}
