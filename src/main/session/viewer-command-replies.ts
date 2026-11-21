/**
 * The round trip of "what the window actually did" for the gateway's `openFile` (TODO 832 (1), ARCHITECTURE.md 7.6.2).
 *
 * If there is an unsaved draft, the renderer does not obey a request to open another file (`keep` of `planViewerCommand`).
 * main does not know the result at the time it sends the instruction, so until now it always returned `opened: true`, and the AI said "opened".
 * It sends with a `replyId` only to windows that hold a draft (notified by `DraftConflictTracker`) and waits for the reply here (a window that gives no reply is "could not be
 * confirmed" - not counted as shown). A window with no draft
 * cannot be `keep`, so it is not asked (it answers as fast as before - the same compromise as `viewer-drafts-close.ts`).
 *
 * A small box that only does the waiting; it touches neither power, the DB, nor windows. `test/gateway-open-file.test.ts` checks it.
 */
import { randomUUID } from 'node:crypto'
import type { ViewerCommandOutcome } from '@shared/thread.js'

/** The upper limit for waiting for a reply (ms). The renderer's decision is synchronous, so normally a few ms. A window past it is "unknown" (null). */
export const VIEWER_COMMAND_REPLY_TIMEOUT_MS = 2000

const OUTCOMES: ReadonlySet<string> = new Set<ViewerCommandOutcome>(['opened', 'kept', 'ignored'])

/** Whether it is a value from the renderer (item 86: main does not trust the renderer). */
export function isViewerCommandOutcome(value: unknown): value is ViewerCommandOutcome {
  return typeof value === 'string' && OUTCOMES.has(value)
}

interface Waiting {
  readonly views: ReadonlySet<number>
  readonly results: Map<number, ViewerCommandOutcome>
  readonly finish: () => void
}

export class ViewerCommandReplies {
  private readonly waiting = new Map<string, Waiting>()

  constructor(private readonly timeoutMs: number = VIEWER_COMMAND_REPLY_TIMEOUT_MS) {}

  /**
   * Registers a wait for replies and returns the id. Call it **before sending the instruction** (so that a reply arriving first is not dropped).
   * The result is received through `done` (it resolves when all windows have replied, or on timeout or `dispose`).
   */
  expect(viewIds: readonly number[]): { readonly id: string; readonly done: Promise<ReadonlyMap<number, ViewerCommandOutcome>> } {
    const id = randomUUID()
    const results = new Map<number, ViewerCommandOutcome>()
    const views = new Set(viewIds)
    let finish = (): void => undefined
    const done = new Promise<ReadonlyMap<number, ViewerCommandOutcome>>((resolve) => {
      const timer = setTimeout(() => finish(), this.timeoutMs)
      timer.unref?.()
      finish = () => {
        clearTimeout(timer)
        if (this.waiting.get(id)?.results !== results) return
        this.waiting.delete(id)
        resolve(results)
      }
    })
    this.waiting.set(id, { views, results, finish: () => finish() })
    if (views.size === 0) finish()
    return { id, done }
  }

  /** The reply from window `viewId`. An unknown id, a window that is not a destination, and a second reply are discarded. */
  reply(viewId: number, id: unknown, outcome: unknown): void {
    if (typeof id !== 'string' || !isViewerCommandOutcome(outcome)) return
    const entry = this.waiting.get(id)
    if (entry === undefined || !entry.views.has(viewId) || entry.results.has(viewId)) return
    entry.results.set(viewId, outcome)
    if (entry.results.size === entry.views.size) entry.finish()
  }

  /** The window closed: that window's reply will no longer come. */
  forgetView(viewId: number): void {
    for (const entry of [...this.waiting.values()]) {
      if (!entry.views.has(viewId) || entry.results.has(viewId)) continue
      entry.results.set(viewId, 'ignored')
      if (entry.results.size === entry.views.size) entry.finish()
    }
  }

  /** Shutdown: returns everything still waiting, with only what has arrived. */
  dispose(): void {
    for (const entry of [...this.waiting.values()]) entry.finish()
  }
}
