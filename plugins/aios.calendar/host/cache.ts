/**
 * The events `aios.calendar` keeps **in the memory of its plugin-host process only** (TODO 1264 stage 1, ARCHITECTURE 7.5.4).
 *
 * Nothing here is written to disk or to aios's database: titles, places, descriptions and attendees are someone's text, and stage 1 needs them
 * only to draw the sidebar list. The plugin-host lives as long as aios runs, so incremental sync (`syncToken`) works within that time; after a
 * restart (or a sign-out) the cache is empty and the next refresh fetches the window again. Provider-neutral (it holds `event.ts` shapes).
 */
import { overlapsRange, type CalendarEvent, type CalendarInfo, type EventChange } from './event.js'

/** The window kept: from 7 days back to 60 days ahead (a little wider, so an event at the edge is not lost to time-zone rounding). */
export const WINDOW_BACK_MS = 8 * 24 * 3_600_000
export const WINDOW_AHEAD_MS = 61 * 24 * 3_600_000

export function windowOf(now: number): { readonly fromMs: number; readonly toMs: number } {
  return { fromMs: now - WINDOW_BACK_MS, toMs: now + WINDOW_AHEAD_MS }
}

/**
 * A full fetch of one calendar that has not reached its last page yet (TODO 1264 review). The next refresh continues from `pageToken` with the
 * same window instead of starting over, so a calendar with many pages finishes even when one call's request budget cannot hold it.
 */
export interface FullFetch {
  /** The local day and instant the fetch started; the window and the completion mark use these. */
  readonly day: string
  readonly startedAt: number
  readonly fromMs: number
  readonly toMs: number
  pageToken: string | null
  pages: number
  /** Everything read by this fetch so far (it replaces the calendar's events when the fetch completes). */
  readonly staged: Map<string, CalendarEvent>
}

export class EventCache {
  /** The id of the account the cache belongs to (Google: the primary calendar id). A different account clears everything. */
  account: string | null = null
  calendars: CalendarInfo[] = []
  /** Calendar id -> its events (key -> event). */
  private readonly events = new Map<string, Map<string, CalendarEvent>>()
  /** Calendar id -> the token for the next incremental sync. */
  private readonly tokens = new Map<string, string>()
  /**
   * The local day on which every calendar had completed a full fetch (`YYYY-MM-DD`), and when. Informational: whether a calendar is fetched
   * fully is decided per calendar (`fullDue`), so one calendar with many pages cannot keep the others starting over (TODO 1264 review).
   */
  fullDay: string | null = null
  fullAt: number | null = null
  /** Calendar id -> its full fetch in progress. */
  private readonly fulls = new Map<string, FullFetch>()
  /** Calendar id -> the day / instant its last full fetch started (set when it completes, or when the calendar was refused). */
  private readonly fullMarks = new Map<string, { readonly day: string; readonly at: number }>()
  /** Calendar id -> the HTTP status Google refused it with on the last try (TODO 1264 review). Cleared when it is read again. */
  private readonly refused = new Map<string, number>()
  /** The status the calendar list itself was refused with on the last try, null if it was read. */
  listRefused: number | null = null

  clear(): void {
    this.account = null
    this.calendars = []
    this.events.clear()
    this.tokens.clear()
    this.refused.clear()
    this.listRefused = null
    this.fulls.clear()
    this.fullMarks.clear()
    this.fullDay = null
    this.fullAt = null
  }

  /**
   * Whether this calendar needs a full fetch now: never fetched fully, fetched on another local day (the window moves), 6 hours ago or more,
   * or it has no sync token (incremental is impossible) and its last full fetch is older than `tokenlessEveryMs`. The last condition keeps the
   * short retries after a budget cut from fetching a tokenless calendar again and again.
   */
  fullDue(calendarId: string, now: number, day: string, fullEveryMs: number, tokenlessEveryMs: number): boolean {
    const mark = this.fullMarks.get(calendarId)
    if (mark === undefined || mark.day !== day || now - mark.at >= fullEveryMs) return true
    return !this.tokens.has(calendarId) && now - mark.at >= tokenlessEveryMs
  }

  fullInProgress(calendarId: string): FullFetch | null {
    return this.fulls.get(calendarId) ?? null
  }

  /** The full fetch to run for this calendar: the one in progress, or a new one over today's window (one from another day starts over). */
  startFull(calendarId: string, now: number, day: string): FullFetch {
    const current = this.fulls.get(calendarId)
    if (current !== undefined && current.day === day) return current
    const { fromMs, toMs } = windowOf(now)
    const started: FullFetch = { day, startedAt: now, fromMs, toMs, pageToken: null, pages: 0, staged: new Map() }
    this.fulls.set(calendarId, started)
    return started
  }

  /** One page of a full fetch. The events are shown at once (added to the calendar's current events); stale ones go when it completes. */
  addFullPage(calendarId: string, changes: readonly EventChange[], nextPageToken: string | null, timeZone?: string): void {
    const fetch = this.fulls.get(calendarId)
    if (fetch === undefined) return
    const live = this.events.get(calendarId) ?? new Map<string, CalendarEvent>()
    for (const change of changes) {
      if (change.kind !== 'upsert' || !overlapsRange(change.event, fetch.fromMs, fetch.toMs, timeZone)) continue
      fetch.staged.set(change.event.key, change.event)
      live.set(change.event.key, change.event)
    }
    this.events.set(calendarId, live)
    fetch.pageToken = nextPageToken
    fetch.pages += 1
  }

  /** The full fetch reached its end (or the page limit): its events replace the calendar's, and the calendar is marked done. */
  finishFull(calendarId: string, syncToken: string | null): void {
    const fetch = this.fulls.get(calendarId)
    if (fetch === undefined) return
    this.fulls.delete(calendarId)
    this.events.set(calendarId, fetch.staged)
    if (syncToken === null) this.tokens.delete(calendarId)
    else this.tokens.set(calendarId, syncToken)
    this.fullMarks.set(calendarId, { day: fetch.day, at: fetch.startedAt })
  }

  /** Whether every one of these calendars completed a full fetch (or was refused) on this local day. */
  allFullOn(day: string, calendars: readonly CalendarInfo[]): boolean {
    return calendars.every((calendar) => this.fullMarks.get(calendar.id)?.day === day)
  }

  /** A calendar Google refuses (400 / 403 / 404): its events and token go (they can no longer be read), the status is kept for the list. */
  markRefused(calendarId: string, status: number, now: number, day: string): void {
    this.events.delete(calendarId)
    this.tokens.delete(calendarId)
    this.fulls.delete(calendarId)
    // Counted as tried: the short retries after a budget cut do not ask for it again (it is tried with the next regular refresh).
    this.fullMarks.set(calendarId, { day, at: now })
    this.refused.set(calendarId, status)
  }

  clearRefused(calendarId: string): void {
    this.refused.delete(calendarId)
  }

  /**
   * Whether the Calendar API looks disabled (or otherwise closed) for the whole project: the calendar list, or every chosen calendar, was
   * refused with 403. A single unreadable calendar does not count.
   */
  apiRefused(): boolean {
    if (this.listRefused === 403) return true
    return this.calendars.length > 0 && this.calendars.every((calendar) => this.refused.get(calendar.id) === 403)
  }

  tokenOf(calendarId: string): string | null {
    return this.tokens.get(calendarId) ?? null
  }

  /** Keep only these calendars (one the user hid in Google Calendar drops its events). */
  setCalendars(calendars: readonly CalendarInfo[]): void {
    this.calendars = [...calendars]
    const keep = new Set(calendars.map((calendar) => calendar.id))
    for (const id of [...this.events.keys()]) if (!keep.has(id)) this.events.delete(id)
    for (const id of [...this.tokens.keys()]) if (!keep.has(id)) this.tokens.delete(id)
    for (const id of [...this.refused.keys()]) if (!keep.has(id)) this.refused.delete(id)
    for (const id of [...this.fulls.keys()]) if (!keep.has(id)) this.fulls.delete(id)
    for (const id of [...this.fullMarks.keys()]) if (!keep.has(id)) this.fullMarks.delete(id)
  }

  /** A full fetch of one calendar: replaces its events. `syncToken` null = no incremental sync for it next time (fetch fully again). */
  replace(calendarId: string, changes: readonly EventChange[], syncToken: string | null, now: number, timeZone?: string): void {
    const map = new Map<string, CalendarEvent>()
    const { fromMs, toMs } = windowOf(now)
    for (const change of changes) {
      if (change.kind === 'upsert' && overlapsRange(change.event, fromMs, toMs, timeZone)) map.set(change.event.key, change.event)
    }
    this.events.set(calendarId, map)
    if (syncToken === null) this.tokens.delete(calendarId)
    else this.tokens.set(calendarId, syncToken)
  }

  /**
   * Changes from an incremental sync. A removed event goes; so do the occurrences of a removed series (with single events, a deleted series
   * may arrive as the series id only). An event moved out of the window goes too.
   */
  apply(calendarId: string, changes: readonly EventChange[], syncToken: string | null, now: number, timeZone?: string): void {
    const map = this.events.get(calendarId) ?? new Map<string, CalendarEvent>()
    const { fromMs, toMs } = windowOf(now)
    for (const change of changes) {
      if (change.kind === 'removed') {
        for (const [key, event] of map) {
          if (event.eventId === change.eventId || event.seriesId === change.eventId) map.delete(key)
        }
        continue
      }
      if (overlapsRange(change.event, fromMs, toMs, timeZone)) map.set(change.event.key, change.event)
      else map.delete(change.event.key)
    }
    this.events.set(calendarId, map)
    if (syncToken === null) this.tokens.delete(calendarId)
    else this.tokens.set(calendarId, syncToken)
  }

  /** Forget the token of a calendar (`410 Gone`): the next fetch is full. */
  dropToken(calendarId: string): void {
    this.tokens.delete(calendarId)
  }

  all(): CalendarEvent[] {
    return [...this.events.values()].flatMap((map) => [...map.values()])
  }

  get size(): number {
    let count = 0
    for (const map of this.events.values()) count += map.size
    return count
  }

  get empty(): boolean {
    return this.events.size === 0
  }
}
