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
import type { ApprovalItem } from '../../shared/thread.js'

/** The minimum thread information counted in the badge. The whole `Thread` need not be passed. */
export interface BadgeThread {
  readonly unread: boolean
}

/** Unread thread count + pending approval count. If 0 it may be removed from the Dock (the caller converts it to `''`). */
export function countBadge(
  threads: readonly BadgeThread[],
  approvals: readonly ApprovalItem[]
): number {
  const unreadThreads = threads.reduce((n, thread) => (thread.unread ? n + 1 : n), 0)
  return unreadThreads + approvals.length
}
