/**
 * TODO 1338: the diffs `openDiff` could not show because no window was showing that conversation.
 *
 * **Memory only** (constraints 9 / 10): the body is never written to the DB, `app_settings`, the per-conversation viewer memory
 * (`setViewerState`) or the log. One entry per conversation (a newer `openDiff` replaces the older one), and the total is capped:
 * past `MAX_PENDING_DIFFS` the oldest conversation's entry is dropped. An entry leaves when a window confirms it showed it
 * (`settle`), when a later `openFile` / `openUrl` / `closeFile` of the same conversation supersedes it, when the conversation is
 * deleted, and on shutdown.
 *
 * Review Y: delivery is a pull by the window once its viewer restore has settled, in two steps - `peek` hands the entry out without
 * removing it, `settle` removes it when the window reports it was shown. Every entry carries a generation (unique across all
 * conversations), so a confirmation for an older entry never removes a newer one that replaced it in between.
 */
import type { DiffPayload } from '@shared/plugin.js'
import { log } from '../../common/logger.js'

/** The most conversations that may have a diff waiting. Past it the oldest is dropped. */
export const MAX_PENDING_DIFFS = 8

export interface PendingDiffEntry {
  readonly generation: number
  readonly diff: DiffPayload
}

export class PendingDiffs {
  /** Insertion order = age (a replaced entry is re-inserted so it counts as the newest). */
  private readonly entries = new Map<string, PendingDiffEntry>()
  private lastGeneration = 0

  /** Waits `diff` for `threadId`, replacing that conversation's earlier one. Returns the new entry's generation. */
  put(threadId: string, diff: DiffPayload): number {
    this.lastGeneration += 1
    const generation = this.lastGeneration
    this.entries.delete(threadId)
    this.entries.set(threadId, { generation, diff })
    while (this.entries.size > MAX_PENDING_DIFFS) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
      log.info('gateway.viewer.diff.dropped', { threadId: oldest, reason: 'limit' })
    }
    return generation
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId)
  }

  /** The waiting entry, left in place (it leaves only through `settle`, `discard` or `clear`). */
  peek(threadId: string): PendingDiffEntry | undefined {
    return this.entries.get(threadId)
  }

  /** Removes the entry only if it is still the one of `generation` (it was shown). Returns whether it removed it. */
  settle(threadId: string, generation: number): boolean {
    if (this.entries.get(threadId)?.generation !== generation) return false
    return this.entries.delete(threadId)
  }

  /** Drops the waiting diff (superseded, conversation deleted). Returns whether there was one. */
  discard(threadId: string): boolean {
    return this.entries.delete(threadId)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
