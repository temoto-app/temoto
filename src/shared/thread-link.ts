/**
 * A link to a conversation message, `thread://<threadId>/<eventId>` (TODO 1155, ARCHITECTURE.md 5.1.1).
 *
 * The index holds conversation messages under this URI (`indexConversationEvents`), and it also appears as is in the gateway's `search` results.
 * A `thread://` link in an AI answer and a conversation search (⌘K) result jump through the same path (`threads.jumpToEvent`).
 *
 * Pure functions independent of the DOM and Node (the renderer's dispatch and main's re-validation use the same judgment).
 */

export const THREAD_LINK_PREFIX = 'thread://'

/** The shape of thread / message ids. aios ids are UUIDs, but alphanumerics and `._:-` are allowed for imported rows and the like. */
const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function isThreadLinkId(value: unknown): value is string {
  return typeof value === 'string' && LINK_ID.test(value)
}

/** Where a link points. Without `eventId`, it only opens the thread. */
export interface ThreadLinkTarget {
  readonly threadId: string
  readonly eventId: string | null
}

/**
 * Reads `thread://<threadId>[/<eventId>]`. null if the shape is wrong (a different scheme, not an id shape, too many segments).
 * Each segment is decoded exactly once so that values percent-encoded by markdown-it can also be read. A trailing `/`, `?…` and `#…` are dropped.
 */
export function parseThreadLink(href: string | null | undefined): ThreadLinkTarget | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (trimmed.slice(0, THREAD_LINK_PREFIX.length).toLowerCase() !== THREAD_LINK_PREFIX) return null
  const rest = trimmed.slice(THREAD_LINK_PREFIX.length).split(/[?#]/, 1)[0] ?? ''
  const parts = rest.replace(/\/$/, '').split('/')
  if (parts.length < 1 || parts.length > 2) return null
  const decoded: string[] = []
  for (const part of parts) {
    let value: string
    try {
      value = decodeURIComponent(part)
    } catch {
      return null
    }
    if (!isThreadLinkId(value)) return null
    decoded.push(value)
  }
  const [threadId, eventId] = decoded
  if (threadId === undefined) return null
  return { threadId, eventId: eventId ?? null }
}

/** The inverse of `parseThreadLink`. */
export function threadLinkOf(threadId: string, eventId: string | null = null): string {
  return eventId === null ? `${THREAD_LINK_PREFIX}${threadId}` : `${THREAD_LINK_PREFIX}${threadId}/${eventId}`
}

/**
 * Where the link is, as confirmed by main (`threads.locateLink`).
 * - `live`: the thread exists and so does the message (if the link does not point at a message, `live` just means the thread exists)
 * - `live-no-event`: the thread exists but the message does not (deleted by the retention period, or a thread that is not saved by setting)
 * - `deleted`: the thread is logically deleted (it can be restored from the deleted list)
 * - `missing`: there is no such thread
 */
export type ThreadLinkLocation = 'live' | 'live-no-event' | 'deleted' | 'missing'

/** What the renderer does after the link is clicked. */
export type ThreadLinkStep =
  /** Select the thread and move to the message (`jumpToEvent`). */
  | { readonly kind: 'jump'; readonly threadId: string; readonly eventId: string }
  /** Only select the thread. If there is a `reason`, show it in the band (the message was not found). */
  | { readonly kind: 'open'; readonly threadId: string; readonly reason: 'thread-link-event-not-found' | null }
  /** Deleted. The band adds "restore and open". */
  | { readonly kind: 'deleted'; readonly target: ThreadLinkTarget }
  /** Not found. The band shows only the reason. */
  | { readonly kind: 'missing' }

export function threadLinkStep(target: ThreadLinkTarget, location: ThreadLinkLocation): ThreadLinkStep {
  switch (location) {
    case 'live':
      return target.eventId === null
        ? { kind: 'open', threadId: target.threadId, reason: null }
        : { kind: 'jump', threadId: target.threadId, eventId: target.eventId }
    case 'live-no-event':
      return { kind: 'open', threadId: target.threadId, reason: 'thread-link-event-not-found' }
    case 'deleted':
      return { kind: 'deleted', target }
    case 'missing':
      return { kind: 'missing' }
  }
}
