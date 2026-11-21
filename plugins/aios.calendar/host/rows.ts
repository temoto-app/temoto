/**
 * The sidebar list of `aios.calendar` (TODO 1264 stage 1, the host-drawn list of TODO 1039).
 *
 *   Today / Tomorrow / This week (the 5 days after tomorrow)    <- headings, depth 1
 *     10:00–11:00 Title                    location              <- one event, depth 2 (expand for details)
 *       Where: … / Video call: … / Guests (n): … / Notes: …       <- details, depth 3
 *
 * No month grid. Rows carry no URI (there is no calendar viewer in stage 1): selecting an event only expands it. Every label is cut to fit the
 * Broker's limits (512 characters, 500 rows in total, depth 3); ids are short hashes so they stay under 256 characters and stable across refreshes.
 */
import type { PluginSidebarRow } from '@shared/plugin-surfaces.js'
import type { Locale } from '@shared/locale.js'
import {
  addDays,
  compareEvents,
  coversDay,
  dayKeyOf,
  noonUtc,
  oneLine,
  type CalendarEvent,
  type CalendarInfo,
  type EventTime
} from './event.js'
import { intlLocale, textFor, type CalendarText } from './text.js'

/** Upper limit of events in the list (each event is at most 1 + `MAX_DETAILS` rows; the Broker refuses more than 500 rows). */
export const MAX_LISTED_EVENTS = 60
const MAX_DETAILS = 6
const LABEL_MAX = 200
const NOTES_MAX = 300
const MAX_NAMES = 5

export type Connection = 'ok' | 'reauth' | 'none'

export interface RowsInput {
  readonly events: readonly CalendarEvent[]
  readonly calendars: readonly CalendarInfo[]
  readonly connection: Connection
  /** TODO 1264 review: the Calendar API refused everything with 403 (shown as a guidance row on top). */
  readonly apiRefused?: boolean
  readonly now: number
  readonly locale?: Locale
  /** IANA zone for tests; undefined = the machine's zone. */
  readonly timeZone?: string
}

/** FNV-1a (32 bits) as hex: a short, stable id for an event key. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function timeText(ms: number, locale: Locale | undefined, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(ms)
}

function dayText(day: string, locale: Locale | undefined): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(
    noonUtc(day)
  )
}

/** The local day a timed event ends on (an end at 00:00 belongs to the day before; a zero-length event ends on its start day). */
function lastDayOf(startMs: number, endMs: number, timeZone: string | undefined): string {
  return dayKeyOf(endMs > startMs ? endMs - 1 : startMs, timeZone)
}

/** The time part of an event's label on `day`: `All day`, `10:00–11:00`, or `10:00–` / `–11:00` for events that cross midnight. */
function spanOnDay(event: CalendarEvent, day: string, text: CalendarText, locale: Locale | undefined, timeZone: string | undefined): string {
  if (event.start.kind === 'date' || event.end.kind === 'date') return text.allDay
  const startDay = dayKeyOf(event.start.ms, timeZone)
  const endDay = lastDayOf(event.start.ms, event.end.ms, timeZone)
  const start = startDay === day ? timeText(event.start.ms, locale, timeZone) : ''
  const end = endDay === day ? timeText(event.end.ms, locale, timeZone) : ''
  if (start === '' && end === '') return text.allDay
  return `${start}–${end}`
}

/** The full time of an event for the details (dates included). */
export function whenText(start: EventTime, end: EventTime, locale: Locale | undefined, timeZone: string | undefined): string {
  if (start.kind === 'date') {
    const last = end.kind === 'date' ? addDays(end.date, -1) : start.date
    return last > start.date ? `${dayText(start.date, locale)} – ${dayText(last, locale)}` : dayText(start.date, locale)
  }
  const startDay = dayKeyOf(start.ms, timeZone)
  const startText = `${dayText(startDay, locale)} ${timeText(start.ms, locale, timeZone)}`
  if (end.kind !== 'instant') return startText
  const endDay = lastDayOf(start.ms, end.ms, timeZone)
  const endText = endDay === startDay ? timeText(end.ms, locale, timeZone) : `${dayText(endDay, locale)} ${timeText(end.ms, locale, timeZone)}`
  return `${startText} – ${endText}`
}

function details(event: CalendarEvent, id: string, input: RowsInput, text: CalendarText): PluginSidebarRow[] {
  const rows: PluginSidebarRow[] = []
  const add = (suffix: string, label: string): void => {
    if (rows.length < MAX_DETAILS) rows.push({ id: `${id}:${suffix}`, label: oneLine(label, LABEL_MAX) })
  }
  add('when', whenText(event.start, event.end, input.locale, input.timeZone))
  if (event.status === 'tentative') add('tentative', text.tentative)
  if (event.location !== '') add('where', text.where(event.location))
  if (event.conference !== null) add('video', text.video(event.conference))
  const guests = event.attendees.filter((attendee) => !attendee.self)
  if (guests.length > 0) {
    const names = guests.slice(0, MAX_NAMES).map((attendee) => attendee.name ?? attendee.email ?? '?')
    const rest = guests.length - names.length
    add('guests', text.attendees(guests.length, `${names.join(', ')}${rest > 0 ? ` +${rest}` : ''}`))
  }
  if (event.organizer !== null) add('organizer', text.organizer(event.organizer))
  if (event.description !== '') add('notes', text.notes(oneLine(event.description, NOTES_MAX)))
  const calendar = input.calendars.find((entry) => entry.id === event.calendarId)
  if (calendar !== undefined && !calendar.primary) add('calendar', text.calendar(calendar.name))
  return rows
}

function guidance(id: string, label: string, detail: string): PluginSidebarRow {
  return { id, label, children: [{ id: `${id}:how`, label: detail }] }
}

/** The whole list. */
export function buildRows(input: RowsInput): PluginSidebarRow[] {
  const text = textFor(input.locale)
  if (input.connection === 'none') return [guidance('connect', text.notConnected, text.howToConnect)]
  const rows: PluginSidebarRow[] = []
  if (input.connection === 'reauth') rows.push(guidance('reauth', text.reauth, text.howToReauth))
  if (input.apiRefused === true) rows.push(guidance('api-refused', text.apiRefused, text.howToApi))

  const today = dayKeyOf(input.now, input.timeZone)
  const groups: { id: string; label: string; days: string[] }[] = [
    { id: 'today', label: text.today, days: [today] },
    { id: 'tomorrow', label: text.tomorrow, days: [addDays(today, 1)] },
    { id: 'week', label: text.thisWeek, days: [2, 3, 4, 5, 6].map((n) => addDays(today, n)) }
  ]
  const sorted = [...input.events].sort(compareEvents)
  const placed = new Set<string>()
  const usedIds = new Set<string>()
  let listed = 0
  let hidden = 0
  for (const group of groups) {
    const children: PluginSidebarRow[] = []
    for (const day of group.days) {
      for (const event of sorted) {
        if (placed.has(event.key) || !coversDay(event, day, input.timeZone)) continue
        placed.add(event.key)
        if (listed >= MAX_LISTED_EVENTS) {
          hidden += 1
          continue
        }
        listed += 1
        let id = `e:${shortHash(event.key)}`
        while (usedIds.has(id)) id = `${id}x`
        usedIds.add(id)
        const span = spanOnDay(event, day, text, input.locale, input.timeZone)
        const prefix = group.id === 'week' ? `${dayText(day, input.locale)} ${span}` : span
        const title = event.title === '' ? text.noTitle : event.title
        children.push({
          id,
          label: oneLine(`${prefix} ${title}`, LABEL_MAX),
          ...(event.location === '' ? {} : { description: oneLine(event.location, 80) }),
          children: details(event, id, input, text)
        })
      }
    }
    if (children.length === 0) children.push({ id: `${group.id}:none`, label: text.noEvents })
    rows.push({ id: group.id, label: group.label, children })
  }
  if (hidden > 0) rows.push({ id: 'more', label: text.more(hidden) })
  return rows
}
