/**
 * Two uses of the Composer draft (TODO 526, wave 26 bundle C).
 *
 * 1. **Provisional title**: a thread with no name and no response yet (working title = `UNTITLED_THREAD_TITLE`, `lastEventAt` null)
 *    shows the first line of any half-written text in the Composer as the list title. It is not written to the DB
 *    (owner answer 2026-10-08). Drafts live only in the renderer's memory (`drafts` in `threadStore.ts`)
 *    **per window**, so the provisional title is visible only in that window (not shared across windows).
 * 2. **Protection from auto-deletion**: main physically deletes "threads left 3 minutes with no input and no response".
 *    Drafts are not in main, so main is told only when the set of threads holding a draft (or attachment) changes,
 *    via `threads.reportComposerDrafts` (not on every keypress).
 */
import { UNTITLED_THREAD_TITLE, type Attachment, type Thread } from '@shared/thread.js'

/** Upper limit of the provisional title's length (in characters; a surrogate pair counts as one). */
export const PROVISIONAL_TITLE_MAX = 40

/** Returns the first non-empty line of the draft, cut at the limit. Null if empty. */
export function provisionalTitle(draft: string | undefined, max = PROVISIONAL_TITLE_MAX): string | null {
  if (draft === undefined) return null
  for (const raw of draft.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line === '') continue
    const chars = Array.from(line)
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : line
  }
  return null
}

/**
 * The provisional title shown in the list row. Only for a thread with a working title that has never had a send or response. Otherwise null
 * (show the usual title).
 */
export function provisionalTitleOf(
  thread: Pick<Thread, 'title' | 'lastEventAt'>,
  draft: string | undefined
): string | null {
  if (thread.title !== UNTITLED_THREAD_TITLE || thread.lastEventAt !== null) return null
  return provisionalTitle(draft)
}

/** Ids of threads holding a draft (whitespace alone does not count) or an attachment (ascending). */
export function draftThreadIds(
  drafts: Readonly<Record<string, string>>,
  attachments: Readonly<Record<string, readonly Attachment[]>>
): string[] {
  const ids = new Set<string>()
  for (const [id, text] of Object.entries(drafts)) if (text.trim() !== '') ids.add(id)
  for (const [id, list] of Object.entries(attachments)) if (list.length > 0) ids.add(id)
  return [...ids].sort()
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

interface DraftSource {
  readonly drafts: Readonly<Record<string, string>>
  readonly attachments: Readonly<Record<string, readonly Attachment[]>>
}

interface Subscribable<S> {
  getState(): S
  subscribe(listener: (state: S, previous: S) => void): () => void
}

/**
 * Calls `report` only when the set of threads holding drafts changes. The first time it sends unless empty
 * (a reloaded window has been forgotten on the main side: `closeView`). The return value unsubscribes.
 */
export function installComposerDraftReport<S extends DraftSource>(
  store: Subscribable<S>,
  report: (threadIds: readonly string[]) => Promise<void> | void
): () => void {
  let last: readonly string[] = []
  const send = (state: S): void => {
    const next = draftThreadIds(state.drafts, state.attachments)
    if (sameIds(next, last)) return
    last = next
    void Promise.resolve(report(next)).catch(() => undefined)
  }
  send(store.getState())
  return store.subscribe((state, previous) => {
    if (state.drafts === previous.drafts && state.attachments === previous.attachments) return
    send(state)
  })
}
