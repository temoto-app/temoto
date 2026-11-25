/**
 * Physical deletion of abandoned threads (TODO 526, wave 26 bundle C).
 *
 * A thread that was "just created, nothing typed in the Composer, never sent, and N minutes have passed
 * (default 3)" is deleted outright, without going through the soft delete (item 64). The DB-side conditions
 * (placeholder title, no send and no response, not a branch / transcript / scheduled run) live in the SQL of
 * `ThreadStore.abandonedThreads` / `purgeAbandonedThread`. This file is a small box that only adds the
 * **conditions main cannot know from the DB**: open in some window, a draft in some window's Composer,
 * a running process or a queued message. It touches neither power management nor the DB.
 *
 * Composer drafts exist only in the renderer's memory (`drafts` in `threadStore.ts`, per window, never
 * written to the DB). The renderer reports "the set of threads that hold a draft (or attachment)" through
 * `threads.reportComposerDrafts` only when that set changes (not on every keystroke). When a window closes or
 * reloads, its share is dropped (`close`).
 */

/** Per window (`webContents.id`): the set of threads that have a draft in the Composer. */
export class ComposerDraftRegistry {
  private readonly byView = new Map<number, ReadonlySet<string>>()

  /** Replaces the whole set of threads with a draft for window `viewId`. An empty set means forget it. */
  report(viewId: number, threadIds: readonly string[]): void {
    if (threadIds.length === 0) this.byView.delete(viewId)
    else this.byView.set(viewId, new Set(threadIds))
  }

  /** The window was closed or reloaded. */
  close(viewId: number): void {
    this.byView.delete(viewId)
  }

  /** Whether any window's Composer holds a draft (this stops the idle restart of TODO 103). */
  hasAny(): boolean {
    return this.byView.size > 0
  }

  /** TODO 1333: the threads that window `viewId` reported (empty if none). */
  threadsOf(viewId: number): ReadonlySet<string> {
    return this.byView.get(viewId) ?? new Set()
  }

  has(threadId: string): boolean {
    for (const ids of this.byView.values()) if (ids.has(threadId)) return true
    return false
  }
}

/** Narrows a value that arrived over IPC to a "list of thread ids" (the item 86 shape: check only the type, drop unknown values). */
export function asThreadIdList(value: unknown, max = 1000): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 200) continue
    ids.push(item)
    if (ids.length >= max) break
  }
  return ids
}

/**
 * From the candidates (rows that satisfy the DB condition), picks the ids that are actually deleted. Nothing is
 * deleted when `ttlMs` is 0 or less. Rows where `isProtected` is true (open, holding a draft, running) are kept.
 */
export function pickAbandoned(
  candidates: readonly { readonly id: string; readonly createdAt: number }[],
  now: number,
  ttlMs: number,
  isProtected: (threadId: string) => boolean
): string[] {
  if (!(ttlMs > 0)) return []
  const cutoff = now - ttlMs
  return candidates.filter((c) => c.createdAt <= cutoff && !isProtected(c.id)).map((c) => c.id)
}
