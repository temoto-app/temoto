/**
 * Reads earlier pages (item 88) until that message is loaded (TODO 496 -> 498).
 *
 * When a thread is opened, only the newest 2,000 items (`TIMELINE_LIMIT`) are read, and earlier messages are added to the head one page at a time by "read more" (`loadOlder`).
 * Both the hit in an earlier page from in-thread search (496, `ThreadFind.tsx`) and the jump from a conversation search result (Cmd+K)
 * (`threadStore.jumpToEvent`, 498) go through here.
 *
 * It does not import the store (threadStore also calls this, so importing would make a cycle). The caller passes `getState`.
 */
import type { AiosEvent } from '@shared/agent.js'

/** The cap on the number of pages read until it arrives (500 items per page). */
export const MAX_OLDER_PAGES = 40

/** The shape of the store that `loadUntil` reads (part of `useThreads`). */
export interface OlderPageSource {
  getState(): {
    readonly events: Readonly<Record<string, readonly AiosEvent[]>>
    readonly childEvents: Readonly<Record<string, Readonly<Record<string, readonly AiosEvent[]>>>>
    readonly older: Readonly<
      Record<string, { readonly before: number | null; readonly remaining: number; readonly loading: boolean }>
    >
    loadOlder(threadId: string): Promise<void>
  }
}

/** The ids of loaded messages (both the parent list and the child blocks). */
export function loadedEventIds(
  events: readonly AiosEvent[],
  buckets: Readonly<Record<string, readonly AiosEvent[]>> | undefined
): Set<string> {
  const ids = new Set<string>()
  for (const event of events) ids.add(event.id)
  if (buckets !== undefined) for (const list of Object.values(buckets)) for (const event of list) ids.add(event.id)
  return ids
}

/**
 * Reads earlier pages until that message is loaded. true if it arrived. false if it read to the start, could not read (failure, no progress),
 * reached the cap (`MAX_OLDER_PAGES`), or `keepGoing` returned false (jumped somewhere else again).
 */
export async function loadUntil(
  source: OlderPageSource,
  threadId: string,
  eventId: string,
  keepGoing: () => boolean = () => true
): Promise<boolean> {
  for (let page = 0; page < MAX_OLDER_PAGES; page += 1) {
    const state = source.getState()
    if (loadedEventIds(state.events[threadId] ?? [], state.childEvents[threadId]).has(eventId)) return true
    if (!keepGoing()) return false
    const older = state.older[threadId]
    if (older === undefined || older.remaining === 0 || older.before === null) return false
    await state.loadOlder(threadId)
    const after = source.getState().older[threadId]
    // Stop if it could not read (failure, no progress).
    if (after === undefined || after.loading || (after.before === older.before && after.remaining === older.remaining)) return false
  }
  // It may have arrived in the one page read after reaching the cap.
  const state = source.getState()
  return loadedEventIds(state.events[threadId] ?? [], state.childEvents[threadId]).has(eventId)
}
