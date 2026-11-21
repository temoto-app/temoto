/**
 * The provider-neutral shape of calendars and events (TODO 1264 stage 1, ARCHITECTURE 7.5.4).
 *
 * Everything after the API layer (the cache, the sidebar rows, the model's tools) reads only these types. The Google-specific parts (URLs,
 * response keys, error codes) live in `google.ts` alone, so another provider (Outlook, …) adds one more module that produces the same shapes.
 * There is no provider interface yet: one implementation does not need one (the owner asked not to add empty abstractions).
 */

/** One calendar the user reads. */
export interface CalendarInfo {
  readonly id: string
  readonly name: string
  readonly primary: boolean
  /** IANA name (`Asia/Tokyo`), null if unknown. */
  readonly timeZone: string | null
}

/**
 * The start or end of an event. All-day events carry a date (`YYYY-MM-DD`; the end date is exclusive, as in iCalendar), timed events an instant.
 * The time zone is the one the organizer chose (display only; aios shows times in the local zone of the machine).
 */
export type EventTime =
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'instant'; readonly ms: number; readonly timeZone: string | null }

export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needs-action'

export interface CalendarAttendee {
  readonly name: string | null
  readonly email: string | null
  readonly response: AttendeeResponse | null
  /** This attendee is the signed-in user. */
  readonly self: boolean
  readonly organizer: boolean
  readonly optional: boolean
}

export interface CalendarEvent {
  /** Unique across calendars (`calendarId` + `eventId`). */
  readonly key: string
  readonly calendarId: string
  readonly eventId: string
  /** The series this occurrence belongs to (a recurring event expanded into single occurrences). null for a one-off event. */
  readonly seriesId: string | null
  readonly title: string
  readonly start: EventTime
  readonly end: EventTime
  readonly status: 'confirmed' | 'tentative'
  readonly location: string
  /** Plain text (markup removed). Written by other people: untrusted. */
  readonly description: string
  readonly attendees: readonly CalendarAttendee[]
  readonly organizer: string | null
  /** The event's page at the provider (shown as text only; nothing opens it automatically). */
  readonly url: string | null
  /** A video call link, if any. */
  readonly conference: string | null
}

/** A change from an incremental sync: an event that is now as given, or an event that is gone. */
export type EventChange =
  | { readonly kind: 'upsert'; readonly event: CalendarEvent }
  | { readonly kind: 'removed'; readonly calendarId: string; readonly eventId: string }

export function eventKey(calendarId: string, eventId: string): string {
  return `${calendarId}\n${eventId}`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDateKey(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (match === null) return false
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
}

/** `YYYY-MM-DD` of an instant in a time zone (undefined = the machine's zone). */
export function dayKeyOf(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Add days to a `YYYY-MM-DD` key (calendar arithmetic, no time zone involved). */
export function addDays(key: string, days: number): string {
  const match = DATE_RE.exec(key)
  if (match === null) return key
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return date.toISOString().slice(0, 10)
}

/** Noon UTC of a date key (a safe instant for formatting the date itself with `timeZone: 'UTC'`). */
export function noonUtc(key: string): number {
  const match = DATE_RE.exec(key)
  if (match === null) return 0
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
}

/** Whether the event covers (any part of) that local day. */
export function coversDay(event: CalendarEvent, day: string, timeZone?: string): boolean {
  if (event.start.kind === 'date' && event.end.kind === 'date') {
    // The end date is exclusive. A broken event whose end is not after its start still covers its start day.
    return event.start.date <= day && (day < event.end.date || day === event.start.date)
  }
  const { startDay, endDay } = daysOf(event, timeZone)
  return startDay <= day && day <= endDay
}

/** The local day of a start / end. An end at exactly midnight belongs to the day before (10:00-24:00 is one day). */
function timeOf(time: EventTime, timeZone: string | undefined, side: 'start' | 'end'): string {
  if (time.kind === 'date') return side === 'end' ? addDays(time.date, -1) : time.date
  return dayKeyOf(side === 'end' ? time.ms - 1 : time.ms, timeZone)
}

/**
 * The first and last local day an event covers. An event whose end is not after its start (zero length, or broken) covers its start day:
 * without this a zero-length event at 00:00 would end "the day before" (`end - 1 ms`) and fall on no day at all (TODO 1264 review).
 */
function daysOf(event: CalendarEvent, timeZone: string | undefined): { startDay: string; endDay: string } {
  const startDay = timeOf(event.start, timeZone, 'start')
  const endDay = timeOf(event.end, timeZone, 'end')
  return { startDay, endDay: endDay < startDay ? startDay : endDay }
}

/** For sorting: all-day events first on a day, then by start. */
export function sortKey(event: CalendarEvent): number {
  return event.start.kind === 'date' ? noonUtc(event.start.date) - 12 * 3_600_000 - 1 : event.start.ms
}

export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const allDayA = a.start.kind === 'date' ? 0 : 1
  const allDayB = b.start.kind === 'date' ? 0 : 1
  if (allDayA !== allDayB) return allDayA - allDayB
  return sortKey(a) - sortKey(b) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
}

/** Whether an event overlaps the instant range `[fromMs, toMs)`. All-day dates are read as local days. */
export function overlapsRange(event: CalendarEvent, fromMs: number, toMs: number, timeZone?: string): boolean {
  if (event.start.kind === 'instant' && event.end.kind === 'instant') {
    // A zero-length event is the instant of its start (it overlaps a range that contains that instant).
    return event.start.ms < toMs && Math.max(event.end.ms, event.start.ms + 1) > fromMs
  }
  const fromDay = dayKeyOf(fromMs, timeZone)
  const lastDay = dayKeyOf(toMs - 1, timeZone)
  const { startDay, endDay } = daysOf(event, timeZone)
  return startDay <= lastDay && endDay >= fromDay
}

/** Markup in descriptions (Google stores HTML) reduced to plain text. The result is only ever shown as text. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One line, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}
