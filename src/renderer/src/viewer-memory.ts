/**
 * The pure part of ViewerPane's per-thread memory (item 63). It touches neither the DOM nor the store, so
 * `test/viewer-memory.test.ts` tests it directly. The wiring is in `viewerMemory.ts` (hook).
 */
import type { ThreadSummary, ViewerCommand } from '@shared/thread.js'
import { isWebViewerUrl } from '@shared/open-external.js'

export interface ViewerMemory {
  readonly uri: string | null
  readonly highlight: string | null
}

export const CLOSED_VIEWER: ViewerMemory = { uri: null, highlight: null }

/**
 * The write throttle. Moving through the file tree or search results with the keyboard changes the selection on every keystroke,
 * so only the last value is written. Independent per thread (switching to B while A's write is pending
 * does not drop A's).
 */
export const VIEWER_MEMORY_DEBOUNCE_MS = 300

/**
 * Looks up a thread's memory. **Writes that have not yet reached main take priority**: if the user goes back and forth between threads during the
 * 300 ms throttle, the row that arrived from main is still stale.
 */
export function recallViewer(
  threads: Readonly<Record<string, ThreadSummary>>,
  pending: ReadonlyMap<string, ViewerMemory>,
  threadId: string
): ViewerMemory {
  const local = pending.get(threadId)
  if (local !== undefined) return local
  const thread = threads[threadId]?.thread
  if (thread === undefined || thread.lastViewerUri === null) return CLOSED_VIEWER
  return { uri: thread.lastViewerUri, highlight: thread.lastViewerHighlight }
}

export interface ViewerMemoryWriterDeps {
  send(threadId: string, memory: ViewerMemory): Promise<void>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/**
 * Throttles writes to main per thread. `pending` is "a value main does not know yet", and is cleared when
 * the sent write returns (if it is still the same value). After writing, main redistributes the
 * thread list, and that notification arrives before the invoke's reply, so from the instant it is cleared
 * the `threads` row already has the new value. It is also cleared when main rejected the value (exclusion rules etc.) -
 * the memory goes back to the previous value held in main.
 */
export class ViewerMemoryWriter {
  readonly pending = new Map<string, ViewerMemory>()
  private readonly timers = new Map<string, unknown>()

  constructor(private readonly deps: ViewerMemoryWriterDeps) {}

  remember(threadId: string, memory: ViewerMemory): void {
    this.pending.set(threadId, memory)
    const previous = this.timers.get(threadId)
    if (previous !== undefined) this.deps.clearTimer(previous)
    this.timers.set(
      threadId,
      this.deps.setTimer(() => this.flush(threadId), VIEWER_MEMORY_DEBOUNCE_MS)
    )
  }

  private flush(threadId: string): void {
    this.timers.delete(threadId)
    const memory = this.pending.get(threadId)
    if (memory === undefined) return
    const done = (): void => {
      if (this.pending.get(threadId) === memory) this.pending.delete(threadId)
    }
    this.deps.send(threadId, memory).then(done, done)
  }
}

/**
 * How to handle an "open / close" coming from main (item 97, the gateway's `openFile` / `closeFile`).
 *
 * - `ignore`: this window is not showing that thread (a mismatch). Main's memory has been written, so it
 *   appears when that thread is opened.
 * - `select`: obey. The memory is written as usual by the `select` subscription (same value as main, so no diff).
 * - `keep`: do not obey (there are unsaved edits / the file told to close differs from the one shown). Main has already
 *   rewritten the memory, so the current display is written back as the memory.
 */
export type ViewerCommandPlan =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'keep' }
  | {
      readonly kind: 'select'
      readonly uri: string | null
      readonly highlight: string | null
      /** The line to jump to (item 273, `openFile`'s `line`). null when closing or when there is no line. */
      readonly line: number | null
      /** The page to jump to (TODO 1091 part 1, `openFile`'s `page`). null if none. */
      readonly page?: number | null
    }

export function planViewerCommand(
  command: Extract<ViewerCommand, { kind: 'open' | 'close' }>,
  state: {
    readonly activeThreadId: string | null
    readonly selectedUri: string | null
    readonly dirty: boolean
  }
): ViewerCommandPlan {
  if (state.activeThreadId !== command.threadId) return { kind: 'ignore' }
  if (command.kind === 'open') {
    // For the same file the draft is not lost (ViewerPane re-reads only when the URI changes).
    // A Web tab (openUrl, TODO 822) stays behind without breaking the file viewer (same as openDiff), so a draft is not a reason to stop.
    const web = command.uri !== null && isWebViewerUrl(command.uri)
    if (state.dirty && !web && command.uri !== state.selectedUri) return { kind: 'keep' }
    return { kind: 'select', uri: command.uri, highlight: command.highlight, line: command.line ?? null, ...(command.page === undefined ? {} : { page: command.page }) }
  }
  if (state.selectedUri === null) return { kind: 'ignore' }
  if (state.dirty) return { kind: 'keep' }
  if (command.uri !== null && command.uri !== state.selectedUri) return { kind: 'keep' }
  return { kind: 'select', uri: null, highlight: null, line: null }
}
