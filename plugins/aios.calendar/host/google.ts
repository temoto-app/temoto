/**
 * The Google Calendar API entry point (TODO 1264 stage 1). **The only Google-specific module** of `aios.calendar`: URLs, response keys, error
 * statuses and the conversion into the provider-neutral shapes of `event.ts`.
 *
 * Every request goes through `api.net.fetch` (CapabilityBroker) with the credential **name** `google:calendar.readonly`; the Broker attaches the
 * token only to `GET` / `HEAD` under `/calendar/v3/` on `www.googleapis.com` (7.7), and the scope itself is read-only. This module has no way to
 * send another method: `get` passes no `method` at all (the Broker's default is GET), and nothing here builds a request body.
 */
import type { PluginApi } from '@shared/plugin.js'
import {
  eventKey,
  isDateKey,
  plainText,
  type AttendeeResponse,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarInfo,
  type EventChange,
  type EventTime
} from './event.js'

export const CALENDAR_CREDENTIAL = 'google:calendar.readonly'
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/** Hit a rate limit of Google (`local: false`) or of the Broker (`local: true`). */
export class RateLimited extends Error {
  constructor(readonly local: boolean) {
    super(local ? 'rate-limited (aios)' : 'rate-limited (calendar)')
    this.name = 'RateLimited'
  }
}
/** No credentials, or they do not work any more (the user has to sign in again). */
export class NotSignedIn extends Error {
  constructor() {
    super('not signed in')
    this.name = 'NotSignedIn'
  }
}
/** `410 Gone`: the sync token is too old. Fetch the whole window again. */
export class SyncTokenExpired extends Error {
  constructor() {
    super('sync token expired')
    this.name = 'SyncTokenExpired'
  }
}
/**
 * Google refused this one request for good (400 / 403 that is not a rate limit / 404): one calendar the account cannot read, or (403 on every
 * calendar or on the calendar list) the Calendar API not enabled in the Cloud project. Only the status is kept (no body). A refresh skips the
 * calendar instead of failing as a whole (TODO 1264 review).
 */
export class Refused extends Error {
  constructor(readonly status: number) {
    super(`calendar ${status}`)
    this.name = 'Refused'
  }
}
/** The calendar or event does not exist (or is not visible to this account). */
export class NotFound extends Refused {
  constructor() {
    super(404)
    this.name = 'NotFound'
  }
}

/** The text for the model and the task result when the Calendar API refuses everything with 403 (no response body in it). */
export const API_REFUSED_MESSAGE =
  'Google Calendar refused the request (HTTP 403). Check that the Google Calendar API is enabled in the Google Cloud project of the OAuth client.'
/** A temporary failure on Google's side (5xx). */
export class Transient extends Error {
  constructor(readonly status: number) {
    super(`calendar ${status}`)
    this.name = 'Transient'
  }
}
/** The per-call request budget ran out (continue in the next call). */
export class OutOfBudget extends Error {
  constructor() {
    super('request budget used up')
    this.name = 'OutOfBudget'
  }
}

/** The number of requests one call may use (the Broker's own limit, 60 per minute per plugin, applies separately). */
export class Budget {
  used = 0
  constructor(readonly limit: number) {}
  get left(): number {
    return this.limit - this.used
  }
  take(): void {
    if (this.used >= this.limit) throw new OutOfBudget()
    this.used += 1
  }
}

const decoder = new TextDecoder('utf-8')

function isRateLimitBody(text: string): boolean {
  return /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|quotaExceeded/i.test(text)
}

function classify(status: number, text: string): Error | null {
  if (status >= 200 && status < 300) return null
  if (status === 429 || (status === 403 && isRateLimitBody(text))) return new RateLimited(false)
  if (status === 401) return new NotSignedIn()
  if (status === 404) return new NotFound()
  if (status === 410) return new SyncTokenExpired()
  if (status >= 500) return new Transient(status)
  // 400 / 403 (for example the Calendar API not enabled in the Cloud project). Only the status goes into the message (no body).
  if (status === 400 || status === 403) return new Refused(status)
  return new Error(`calendar ${status}`)
}

function brokerError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('rate-limited')) return new RateLimited(true)
  if (message.includes('no-credential') || message.includes('not-consented')) return new NotSignedIn()
  return err instanceof Error ? err : new Error(message)
}

/** GET and parse JSON. **The only request this plugin sends.** */
export async function getJson<T>(api: PluginApi, budget: Budget, url: string): Promise<T> {
  budget.take()
  let response
  try {
    response = await api.net.fetch(url, { auth: CALENDAR_CREDENTIAL })
  } catch (err) {
    throw brokerError(err)
  }
  const text = decoder.decode(response.body)
  const error = classify(response.status, text)
  if (error !== null) throw error
  if (response.truncated) throw new Error('calendar response too large')
  return JSON.parse(text) as T
}

/**
 * Whether a calendar or event id may be put into a URL path. It is percent-encoded anyway; this also refuses `.` / `..` (dot segments are
 * resolved even when encoded), `/`, `\` and control characters, so an id can never move the request out of its collection.
 */
export function isSafeId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return false
  if (id === '.' || id === '..') return false
  // eslint-disable-next-line no-control-regex
  return !/[/\\\u0000-\u001f\u007f]/.test(id)
}

function path(id: string): string {
  if (!isSafeId(id)) throw new Error('bad id')
  return encodeURIComponent(id)
}

export function calendarListUrl(pageToken: string | null): string {
  const url = new URL(`${CALENDAR_API}/users/me/calendarList`)
  url.searchParams.set('maxResults', '250')
  // `freeBusyReader` calendars show no details, so they are left out.
  url.searchParams.set('minAccessRole', 'reader')
  if (pageToken !== null) url.searchParams.set('pageToken', pageToken)
  return url.toString()
}

export interface EventsQuery {
  readonly pageToken?: string | null
  /** Incremental sync. When set, the range / order / search are left out (Google refuses them together). */
  readonly syncToken?: string | null
  readonly timeMin?: number
  readonly timeMax?: number
  readonly query?: string
  readonly orderByStart?: boolean
  readonly maxResults?: number
}

/** `events.list`. Recurring events are always expanded into single occurrences (`singleEvents=true`, also on incremental sync). */
export function eventsUrl(calendarId: string, query: EventsQuery): string {
  const url = new URL(`${CALENDAR_API}/calendars/${path(calendarId)}/events`)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('maxResults', String(query.maxResults ?? 250))
  if (query.syncToken !== undefined && query.syncToken !== null) {
    url.searchParams.set('syncToken', query.syncToken)
  } else {
    if (query.timeMin !== undefined) url.searchParams.set('timeMin', new Date(query.timeMin).toISOString())
    if (query.timeMax !== undefined) url.searchParams.set('timeMax', new Date(query.timeMax).toISOString())
    if (query.orderByStart === true) url.searchParams.set('orderBy', 'startTime')
    if (query.query !== undefined && query.query !== '') url.searchParams.set('q', query.query)
  }
  if (query.pageToken !== undefined && query.pageToken !== null) url.searchParams.set('pageToken', query.pageToken)
  return url.toString()
}

export function eventUrl(calendarId: string, eventId: string): string {
  return `${CALENDAR_API}/calendars/${path(calendarId)}/events/${path(eventId)}`
}

// ---- Response shapes (only the keys aios reads) ----

export interface GoogleCalendarListEntry {
  readonly id?: string
  readonly summary?: string
  readonly summaryOverride?: string
  readonly primary?: boolean
  readonly selected?: boolean
  readonly hidden?: boolean
  readonly deleted?: boolean
  readonly timeZone?: string
}

export interface GoogleCalendarList {
  readonly items?: readonly GoogleCalendarListEntry[]
  readonly nextPageToken?: string
}

interface GoogleTime {
  readonly date?: string
  readonly dateTime?: string
  readonly timeZone?: string
}

export interface GoogleEvent {
  readonly id?: string
  readonly status?: string
  readonly summary?: string
  readonly description?: string
  readonly location?: string
  readonly htmlLink?: string
  readonly hangoutLink?: string
  readonly recurringEventId?: string
  readonly start?: GoogleTime
  readonly end?: GoogleTime
  readonly organizer?: { readonly email?: string; readonly displayName?: string; readonly self?: boolean }
  readonly attendees?: readonly {
    readonly email?: string
    readonly displayName?: string
    readonly responseStatus?: string
    readonly self?: boolean
    readonly organizer?: boolean
    readonly optional?: boolean
    readonly resource?: boolean
  }[]
  readonly conferenceData?: { readonly entryPoints?: readonly { readonly entryPointType?: string; readonly uri?: string }[] }
}

export interface GoogleEventList {
  readonly items?: readonly GoogleEvent[]
  readonly nextPageToken?: string
  readonly nextSyncToken?: string
}

// ---- Conversion into the provider-neutral shapes ----

export function toCalendarInfo(entry: GoogleCalendarListEntry): CalendarInfo | null {
  if (!isSafeId(entry.id) || entry.deleted === true) return null
  return {
    id: entry.id,
    name: entry.summaryOverride ?? entry.summary ?? entry.id,
    primary: entry.primary === true,
    timeZone: typeof entry.timeZone === 'string' ? entry.timeZone : null
  }
}

/** The calendars aios reads: the ones the user shows in Google Calendar (`selected`), primary first, at most `max`. Hidden ones are left out. */
export function chooseCalendars(entries: readonly GoogleCalendarListEntry[], max: number): CalendarInfo[] {
  const chosen: CalendarInfo[] = []
  for (const entry of entries) {
    if (entry.hidden === true) continue
    if (entry.selected !== true && entry.primary !== true) continue
    const info = toCalendarInfo(entry)
    if (info !== null) chosen.push(info)
  }
  chosen.sort((a, b) => Number(b.primary) - Number(a.primary))
  return chosen.slice(0, max)
}

function toTime(raw: GoogleTime | undefined): EventTime | null {
  if (raw === undefined) return null
  if (typeof raw.dateTime === 'string') {
    const ms = Date.parse(raw.dateTime)
    if (!Number.isFinite(ms)) return null
    return { kind: 'instant', ms, timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : null }
  }
  if (typeof raw.date === 'string' && isDateKey(raw.date)) return { kind: 'date', date: raw.date }
  return null
}

const RESPONSES: Readonly<Record<string, AttendeeResponse>> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needs-action'
}

function httpsOrNull(value: string | undefined): string | null {
  return typeof value === 'string' && /^https:\/\//i.test(value) && value.length <= 2048 ? value : null
}

/**
 * One Google event -> an `EventChange`. A cancelled event (`status: cancelled`, which incremental sync sends for deletions and for removed
 * occurrences of a series) becomes `removed`. An event without a readable start / end is skipped (null).
 */
export function toChange(calendarId: string, raw: GoogleEvent): EventChange | null {
  if (!isSafeId(raw.id)) return null
  if (raw.status === 'cancelled') return { kind: 'removed', calendarId, eventId: raw.id }
  const start = toTime(raw.start)
  const end = toTime(raw.end)
  if (start === null || end === null) return null
  const attendees: CalendarAttendee[] = (raw.attendees ?? [])
    .filter((attendee) => attendee.resource !== true)
    .map((attendee) => ({
      name: typeof attendee.displayName === 'string' ? attendee.displayName : null,
      email: typeof attendee.email === 'string' ? attendee.email : null,
      response: typeof attendee.responseStatus === 'string' ? (RESPONSES[attendee.responseStatus] ?? null) : null,
      self: attendee.self === true,
      organizer: attendee.organizer === true,
      optional: attendee.optional === true
    }))
  const video = raw.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri
  const event: CalendarEvent = {
    key: eventKey(calendarId, raw.id),
    calendarId,
    eventId: raw.id,
    seriesId: isSafeId(raw.recurringEventId) ? raw.recurringEventId : null,
    title: typeof raw.summary === 'string' ? raw.summary : '',
    start,
    end,
    status: raw.status === 'tentative' ? 'tentative' : 'confirmed',
    location: typeof raw.location === 'string' ? raw.location : '',
    description: typeof raw.description === 'string' ? plainText(raw.description) : '',
    attendees,
    organizer:
      raw.organizer === undefined || raw.organizer.self === true
        ? null
        : (raw.organizer.displayName ?? raw.organizer.email ?? null),
    url: httpsOrNull(raw.htmlLink),
    conference: httpsOrNull(video) ?? httpsOrNull(raw.hangoutLink)
  }
  return { kind: 'upsert', event }
}

// ---- Calls ----

/** All calendar list entries (at most 4 pages). */
export async function fetchCalendarList(api: PluginApi, budget: Budget): Promise<GoogleCalendarListEntry[]> {
  const entries: GoogleCalendarListEntry[] = []
  let pageToken: string | null = null
  for (let page = 0; page < 4; page += 1) {
    const list: GoogleCalendarList = await getJson<GoogleCalendarList>(api, budget, calendarListUrl(pageToken))
    entries.push(...(list.items ?? []))
    if (list.nextPageToken === undefined) break
    pageToken = list.nextPageToken
  }
  return entries
}

export interface EventsPage {
  readonly changes: readonly EventChange[]
  readonly nextPageToken: string | null
  readonly nextSyncToken: string | null
}

export async function fetchEventsPage(api: PluginApi, budget: Budget, calendarId: string, query: EventsQuery): Promise<EventsPage> {
  const list = await getJson<GoogleEventList>(api, budget, eventsUrl(calendarId, query))
  const changes: EventChange[] = []
  for (const raw of list.items ?? []) {
    const change = toChange(calendarId, raw)
    if (change !== null) changes.push(change)
  }
  return {
    changes,
    nextPageToken: typeof list.nextPageToken === 'string' ? list.nextPageToken : null,
    nextSyncToken: typeof list.nextSyncToken === 'string' ? list.nextSyncToken : null
  }
}

export async function fetchEvent(api: PluginApi, budget: Budget, calendarId: string, eventId: string): Promise<EventChange | null> {
  return toChange(calendarId, await getJson<GoogleEvent>(api, budget, eventUrl(calendarId, eventId)))
}
