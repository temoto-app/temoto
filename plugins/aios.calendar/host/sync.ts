/**
 * The scheduled task `refresh` of `aios.calendar` (TODO 1264 stage 1, ARCHITECTURE 7.5.4). aios's `JobScheduler` calls it every 15 minutes
 * while no conversation is running (`idle: true`), right after sign-in, and once when the list is opened before it has rows.
 *
 * One call:
 *   0. Credentials: none -> clear the cache and show "sign in"; present but expired (the Broker reports the bound host with `present: false`)
 *      -> keep the last list and show "sign in again" (it does not silently disappear).
 *   1. The calendar list (the calendars shown in Google Calendar, at most 10). A different primary calendar = another account: clear the cache.
 *   2. Each calendar: a full fetch of the window (7 days back to 60 days ahead) on the first call of the process, on a new local day, every 6 hours,
 *      or without a sync token; otherwise an incremental fetch with the sync token. `410 Gone` -> full fetch of that calendar. This is decided
 *      **per calendar**, and a full fetch cut by the request budget continues from its next page on the following call (TODO 1264 review).
 *   3. Pass the rows to the sidebar, report the state to the BottomBar badge.
 * The task keeps no state in aios's database (`state` is never returned): the events stay in the plugin-host's memory (`cache.ts`).
 * Logs carry counts only, never event text.
 */
import type { PluginApi, PluginTaskArg, PluginTaskResult } from '@shared/plugin.js'
import type { PluginSyncState } from '@shared/plugin-surfaces.js'
import { EventCache } from './cache.js'
import { dayKeyOf, type CalendarInfo, type EventChange } from './event.js'
import {
  Budget,
  CALENDAR_CREDENTIAL,
  chooseCalendars,
  fetchCalendarList,
  fetchEventsPage,
  NotSignedIn,
  OutOfBudget,
  RateLimited,
  Refused,
  API_REFUSED_MESSAGE,
  SyncTokenExpired,
  Transient
} from './google.js'
import { buildRows, type Connection } from './rows.js'

/** Requests per call (1 list + up to 10 calendars x a few pages). */
export const REQUEST_BUDGET = 40
export const MAX_CALENDARS = 10
/** Pages per calendar per fetch (250 events each). A calendar with more than this in the window keeps what was read and has no sync token. */
export const MAX_PAGES = 8
export const FULL_EVERY_MS = 6 * 3_600_000
/** A calendar Google gives no sync token for is fetched fully again after this long (shorter than the 15-minute task, longer than a retry). */
export const TOKENLESS_EVERY_MS = 10 * 60_000
export const RETRY_MS = 60_000

/** The one cache of this plugin-host process. */
export const cache = new EventCache()

/** One log line without values (plugin-host's stdout -> main makes it a `plugin:<id>` line). */
function logLine(event: string, fields: Record<string, number | string>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }))
}

export interface RefreshOptions {
  readonly now?: () => number
  readonly budget?: number
  /** IANA zone for tests; undefined = the machine's zone. */
  readonly timeZone?: string
}

async function publish(api: PluginApi, arg: PluginTaskArg, connection: Connection, now: number, timeZone: string | undefined): Promise<void> {
  await api.sidebar.setRows(
    buildRows({
      events: connection === 'none' ? [] : cache.all(),
      calendars: cache.calendars,
      connection,
      ...(connection !== 'none' && cache.apiRefused() ? { apiRefused: true } : {}),
      now,
      ...(arg.locale === undefined ? {} : { locale: arg.locale }),
      ...(timeZone === undefined ? {} : { timeZone })
    })
  )
}

async function report(api: PluginApi, state: PluginSyncState): Promise<void> {
  try {
    await api.status.report({ done: cache.size, total: null, state })
  } catch {
    // The badge is a courtesy; a refusal must not fail the refresh.
  }
}

/** All pages of an incremental fetch. Returns the changes and the next sync token (null if Google gave none or the pages ran out). */
async function fetchIncremental(
  api: PluginApi,
  budget: Budget,
  calendarId: string,
  syncToken: string
): Promise<{ changes: EventChange[]; syncToken: string | null }> {
  const changes: EventChange[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchEventsPage(api, budget, calendarId, { syncToken, pageToken })
    changes.push(...result.changes)
    if (result.nextPageToken === null) return { changes, syncToken: result.nextSyncToken }
    pageToken = result.nextPageToken
  }
  return { changes, syncToken: null }
}

/** What one calendar did in this call (for the log). */
type CalendarOutcome = 'full' | 'incremental' | 'none'

async function refreshCalendar(
  api: PluginApi,
  budget: Budget,
  calendar: CalendarInfo,
  now: number,
  today: string,
  timeZone?: string
): Promise<CalendarOutcome> {
  const id = calendar.id
  if (cache.fullInProgress(id) === null) {
    const due = cache.fullDue(id, now, today, FULL_EVERY_MS, TOKENLESS_EVERY_MS)
    const token = cache.tokenOf(id)
    if (!due && token === null) return 'none'
    if (!due && token !== null) {
      try {
        const { changes, syncToken } = await fetchIncremental(api, budget, id, token)
        cache.apply(id, changes, syncToken, now, timeZone)
        return 'incremental'
      } catch (err) {
        if (!(err instanceof SyncTokenExpired)) throw err
        // 410: the token is too old. Fetch this calendar again from the window.
        cache.dropToken(id)
      }
    }
  }
  // A full fetch, new or continued. Each page is kept as soon as it arrives, so a budget cut loses nothing and the next call goes on from here.
  const fetch = cache.startFull(id, now, today)
  while (fetch.pages < MAX_PAGES) {
    const page = await fetchEventsPage(api, budget, id, { timeMin: fetch.fromMs, timeMax: fetch.toMs, pageToken: fetch.pageToken })
    cache.addFullPage(id, page.changes, page.nextPageToken, timeZone)
    if (page.nextPageToken === null) {
      cache.finishFull(id, page.nextSyncToken)
      return 'full'
    }
  }
  // More pages than the limit: keep what was read, without a sync token.
  cache.finishFull(id, null)
  return 'full'
}

export async function runRefresh(arg: PluginTaskArg, api: PluginApi, options: RefreshOptions = {}): Promise<PluginTaskResult> {
  const now = (options.now ?? Date.now)()
  const timeZone = options.timeZone
  const credential = await api.credentials.status(CALENDAR_CREDENTIAL)
  if (!credential.present) {
    if (credential.host === null) {
      // Never signed in, or signed out: nothing from the account stays in memory.
      cache.clear()
      await publish(api, arg, 'none', now, timeZone)
      await report(api, 'done')
    } else {
      await publish(api, arg, 'reauth', now, timeZone)
      await report(api, 'needs-reauth')
    }
    return { more: false }
  }

  const budget = new Budget(options.budget ?? REQUEST_BUDGET)
  try {
    let entries
    try {
      entries = await fetchCalendarList(api, budget)
      cache.listRefused = null
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      // The list itself is refused (403: most likely the Calendar API is not enabled): nothing of the account can be read.
      cache.clear()
      cache.listRefused = err.status
      logLine('calendar.refresh.refused', { list: 1, status: err.status })
      await publish(api, arg, 'ok', now, timeZone)
      await report(api, 'done')
      throw new Error(err.status === 403 ? API_REFUSED_MESSAGE : `calendar list ${err.status}`)
    }
    const calendars = chooseCalendars(entries, MAX_CALENDARS)
    const account = calendars.find((calendar) => calendar.primary)?.id ?? null
    if (cache.account !== account) {
      cache.clear()
      cache.account = account
    }
    cache.setCalendars(calendars)
    const today = dayKeyOf(now, timeZone)
    let fetchedFully = 0
    const skipped: number[] = []
    for (const calendar of calendars) {
      try {
        const outcome = await refreshCalendar(api, budget, calendar, now, today, timeZone)
        if (outcome === 'full') fetchedFully += 1
        if (outcome !== 'none') cache.clearRefused(calendar.id)
      } catch (err) {
        // TODO 1264 review: one calendar Google refuses (404 / 403 / 400) is skipped; the others are still shown.
        if (!(err instanceof Refused)) throw err
        cache.markRefused(calendar.id, err.status, now, today)
        skipped.push(err.status)
      }
    }
    if (skipped.length > 0) logLine('calendar.refresh.skipped', { calendars: skipped.length, statuses: [...new Set(skipped)].sort().join(',') })
    if (cache.allFullOn(today, calendars) && cache.fullDay !== today) {
      cache.fullDay = today
      cache.fullAt = now
    }
    logLine('calendar.refresh', { calendars: calendars.length, events: cache.size, full: fetchedFully, requests: budget.used })
    if (cache.apiRefused()) {
      // Every calendar refused with 403: say why in the list and in the task's result (the scheduler keeps the error text).
      await publish(api, arg, 'ok', now, timeZone)
      await report(api, 'done')
      throw new Error(API_REFUSED_MESSAGE)
    }
  } catch (err) {
    if (err instanceof NotSignedIn) {
      // A 401 or a refused credential: keep the last list, say so (the account section shows "sign in again" once main marks it).
      await publish(api, arg, 'reauth', now, timeZone)
      await report(api, 'needs-reauth')
      return { more: false }
    }
    if (err instanceof RateLimited || err instanceof Transient || err instanceof OutOfBudget) {
      // What was read so far is shown; the next call continues (a cut full fetch goes on from its next page, finished calendars are not fetched again).
      await publish(api, arg, 'ok', now, timeZone)
      await report(api, err instanceof RateLimited ? 'rate-limited' : err instanceof Transient ? 'offline' : 'done')
      logLine('calendar.refresh.partial', { reason: err.name, requests: budget.used })
      return { more: true, retryAfterMs: RETRY_MS }
    }
    throw err
  }
  await publish(api, arg, 'ok', now, timeZone)
  await report(api, 'done')
  return { more: false }
}
