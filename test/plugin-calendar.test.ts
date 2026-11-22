/**
 * TODO 1264 stage 1: the bundled `aios.calendar` (read-only Google Calendar) and the main-side guards it relies on.
 *
 * **The fixtures are synthetic**: this development machine does not connect to Google. The response shapes follow the keys of the public
 * Calendar API v3 reference (events.list / calendarList.list / events.get); differences from the real thing are fixed by the owner's check on a real
 * device after the Google Cloud setup. A fake `api` is passed in: the real API is never called.
 *
 * What it pins down:
 *  1. The manifest: one read-only credential, one host, the sidebar list, three tools without side effects; disabled by default.
 *  2. `refresh`: calendar choice, full fetch with paging, all-day / time zone / cancelled / recurring occurrences, incremental with the sync token,
 *     410 -> full again, a new day -> full again, account switch, sign-out / expired sign-in (guidance, the list does not silently vanish).
 *  3. Only GET: no request of the plugin carries a method or a body; event text never reaches the log.
 *  4. The sidebar rows: grouping (Today / Tomorrow / This week), EN / JA, limits of the Broker (rows, depth, ids).
 *  5. The tools: ranges, ids that could leave the collection are refused, the untrusted note, a clear "not signed in".
 *  6. Main: the Broker attaches the calendar token only to GET / HEAD under `/calendar/v3/`, and only for `aios.calendar`; sign-in refuses a token
 *     with extra scopes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { PluginApi, PluginTaskArg } from '../src/shared/plugin.js'
import type { PluginSidebarRow, PluginSyncReport } from '../src/shared/plugin-surfaces.js'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { credentialOwner } from '../src/main/capability/credential-owner.js'
import {
  CALENDAR_READONLY_CREDENTIAL,
  CALENDAR_READONLY_SCOPE,
  googleCredentialSpec,
  googleRequestAllowed,
  signInGoogle
} from '../src/main/capability/google-credentials.js'
import type { FetchFn, OAuthClient } from '../src/main/capability/google-oauth.js'
import type { NetTransport } from '../src/main/capability/network.js'
import { sidebarRowsWithinLimits } from '../src/main/capability/surface-schema.js'
import { DEFAULT_DISABLED_PLUGIN_IDS } from '../src/main/plugin/host.js'
import { parseManifest } from '../src/main/plugin/manifest.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import plugin, { readArg } from '../plugins/aios.calendar/host/index.js'
import { EventCache } from '../plugins/aios.calendar/host/cache.js'
import { coversDay, overlapsRange, plainText, type CalendarEvent } from '../plugins/aios.calendar/host/event.js'
import { CALENDAR_CREDENTIAL, eventUrl, eventsUrl, isSafeId, toChange } from '../plugins/aios.calendar/host/google.js'
import { buildRows, MAX_LISTED_EVENTS } from '../plugins/aios.calendar/host/rows.js'
import { cache, runRefresh } from '../plugins/aios.calendar/host/sync.js'
import { getEvent, instantText, listCalendars, listEvents, parseInstant, UNTRUSTED_NOTE } from '../plugins/aios.calendar/host/tools.js'
import { requestPluginRefresh, resetPluginRefreshForTest } from '../src/renderer/src/pluginView.js'
import type { ScheduleOverview, ScheduledJob } from '../src/shared/schedule.js'
import { testExclusions } from './helpers/tmp.js'

const repoRoot = join(__dirname, '..')
const TZ = 'Asia/Tokyo'
/** Friday 2026-11-20 12:00 in Tokyo. */
const NOW = Date.parse('2026-11-20T03:00:00Z')
const PRIMARY = 'me@example.com'
const TEAM = 'team@group.calendar.google.com'

// ---- Fixtures in the shape of the Calendar API v3 ----

const calendarList = (primary = PRIMARY) => ({
  items: [
    { id: TEAM, summary: 'Team', selected: true, timeZone: TZ },
    { id: primary, summary: primary, primary: true, selected: true, timeZone: TZ },
    { id: 'hidden@group.calendar.google.com', summary: 'Hidden', selected: true, hidden: true },
    { id: 'off@group.calendar.google.com', summary: 'Not shown', selected: false }
  ]
})

const standup = {
  id: 'standup1',
  status: 'confirmed',
  summary: 'Standup SECRET-TITLE',
  location: 'Room A',
  description: '<b>Agenda</b><br>Item &amp; more',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  start: { dateTime: '2026-11-20T10:00:00+09:00', timeZone: TZ },
  end: { dateTime: '2026-11-20T11:00:00+09:00', timeZone: TZ },
  organizer: { email: 'boss@example.com', displayName: 'Boss' },
  attendees: [
    { email: PRIMARY, self: true, responseStatus: 'accepted' },
    { email: 'a@example.com', displayName: 'Alice', responseStatus: 'tentative' },
    { email: 'room@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
    { email: 'b@example.com', responseStatus: 'needsAction', optional: true }
  ],
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] }
}
const trip = { id: 'trip1', status: 'confirmed', summary: 'Trip', start: { date: '2026-11-21' }, end: { date: '2026-11-22' } }
const goneInFull = { id: 'gone1', status: 'cancelled' }
const weekly = {
  id: 'weekly_20261124T010000Z',
  recurringEventId: 'weekly',
  status: 'confirmed',
  summary: 'Weekly sync',
  start: { dateTime: '2026-11-24T10:00:00+09:00' },
  end: { dateTime: '2026-11-24T10:30:00+09:00' }
}
const newYork = {
  id: 'ny1',
  status: 'tentative',
  summary: 'Call with NY',
  start: { dateTime: '2026-11-24T20:00:00-05:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-11-24T21:00:00-05:00', timeZone: 'America/New_York' }
}
const conference = { id: 'conf1', status: 'confirmed', summary: 'Conference', start: { date: '2026-11-26' }, end: { date: '2026-11-28' } }
const teamEvent = {
  id: 'team1',
  status: 'confirmed',
  summary: 'Team lunch',
  start: { dateTime: '2026-11-20T15:00:00+09:00' },
  end: { dateTime: '2026-11-20T16:00:00+09:00' }
}

type Route = (url: URL) => { status: number; body: unknown } | null

interface Fake {
  api: PluginApi
  calls: { url: string; init: Record<string, unknown> | undefined }[]
  rows: PluginSidebarRow[][]
  reports: PluginSyncReport[]
  credential: { present: boolean; host: string | null }
  route: Route
}

function fake(route: Route): Fake {
  const state: Fake = {
    calls: [],
    rows: [],
    reports: [],
    credential: { present: true, host: 'www.googleapis.com' },
    route,
    api: undefined as unknown as PluginApi
  }
  const unused = async (): Promise<never> => {
    throw new Error('not used by aios.calendar')
  }
  state.api = {
    fs: { read: unused },
    git: { status: unused, diff: unused, show: unused, log: unused },
    net: {
      fetch: async (url, init) => {
        state.calls.push({ url, init: init as Record<string, unknown> | undefined })
        const answer = state.route(new URL(url))
        if (answer === null) return { status: 404, headers: {}, body: new TextEncoder().encode('{}'), truncated: false }
        return { status: answer.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(answer.body)), truncated: false }
      }
    },
    credentials: { status: async () => state.credential },
    index: { put: unused, remove: unused },
    ui: { notify: unused },
    sidebar: {
      setRows: async (rows) => {
        state.rows.push([...rows])
      }
    },
    status: {
      report: async (report) => {
        state.reports.push(report)
      }
    },
    browser: { fetchPage: unused },
    triggers: { emit: unused },
    settings: { get: async () => ({}) }
  }
  return state
}

/** A route for the first full fetch: the primary calendar in 2 pages, the team calendar in 1. */
function fullRoute(): Route {
  return (url) => {
    if (url.pathname === '/calendar/v3/users/me/calendarList') return { status: 200, body: calendarList() }
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`) {
      if (url.searchParams.get('pageToken') === 'p2') return { status: 200, body: { items: [weekly, newYork, conference], nextSyncToken: 'sync-1' } }
      return { status: 200, body: { items: [standup, trip, goneInFull], nextPageToken: 'p2' } }
    }
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`) {
      return { status: 200, body: { items: [teamEvent], nextSyncToken: 'sync-team-1' } }
    }
    return null
  }
}

const arg = (locale?: 'en' | 'ja'): PluginTaskArg => ({ state: null, reason: 'manual', ...(locale === undefined ? {} : { locale }) })
const opts = (now = NOW) => ({ now: () => now, timeZone: TZ })

function labels(rows: readonly PluginSidebarRow[]): string[] {
  const out: string[] = []
  const walk = (list: readonly PluginSidebarRow[]): void => {
    for (const row of list) {
      out.push(row.label)
      walk(row.children ?? [])
    }
  }
  walk(rows)
  return out
}

function group(rows: readonly PluginSidebarRow[], id: string): string[] {
  return (rows.find((row) => row.id === id)?.children ?? []).map((row) => row.label)
}

beforeEach(() => cache.clear())

describe('manifest (TODO 1264)', () => {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'plugins/aios.calendar/manifest.json'), 'utf8'))
  const manifest = parseManifest(raw)

  it('1 read-only credential, 1 host, a list, 3 tools without side effects; disabled by default', () => {
    expect(manifest.capabilities.credentials).toEqual({ oauth: [CALENDAR_READONLY_CREDENTIAL] })
    expect(manifest.capabilities.network).toEqual({ hosts: ['www.googleapis.com'] })
    expect(manifest.capabilities.index).toBeUndefined()
    expect(manifest.capabilities.ui).toEqual({ sidebar: true, status: true })
    expect(manifest.sidebarView?.title).toBe('Calendar')
    expect(manifest.viewer).toBeUndefined()
    expect(manifest.scheduledTasks).toEqual([expect.objectContaining({ id: 'refresh', idle: true })])
    expect(manifest.mcp?.tools?.map((tool) => tool.name)).toEqual(['listCalendars', 'listEvents', 'getEvent'])
    for (const tool of manifest.mcp?.tools ?? []) expect(tool.sideEffect).toBeUndefined()
    expect(Object.keys(plugin.mcp ?? {})).toEqual(['listCalendars', 'listEvents', 'getEvent'])
    expect(Object.keys(plugin.tasks ?? {})).toEqual(['refresh'])
    expect(DEFAULT_DISABLED_PLUGIN_IDS.has('aios.calendar')).toBe(true)
    expect(CALENDAR_CREDENTIAL).toBe(CALENDAR_READONLY_CREDENTIAL)
  })

  it('credential row: the scope is only calendar.readonly, the owner is aios.calendar, read-only and only under /calendar/v3/', () => {
    expect(googleCredentialSpec(CALENDAR_READONLY_CREDENTIAL)).toEqual({
      name: CALENDAR_READONLY_CREDENTIAL,
      scopes: [CALENDAR_READONLY_SCOPE],
      host: 'www.googleapis.com',
      owner: 'aios.calendar',
      readOnly: true,
      pathPrefix: '/calendar/v3/'
    })
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly')
    expect(credentialOwner(CALENDAR_READONLY_CREDENTIAL)).toBe('aios.calendar')
  })

  it("does not load a manifest where a different id declared this name (cannot claim someone else's credential)", () => {
    expect(() => parseManifest({ ...raw, id: 'aios.gmail' })).toThrow()
    expect(() =>
      parseManifest({ id: 'evil.plugin', name: 'Evil', version: '1.0.0', capabilities: { credentials: { oauth: [CALENDAR_READONLY_CREDENTIAL] } } })
    ).toThrow()
  })

  it('reads the task argument locale (drops unknown values)', () => {
    expect(readArg({ state: null, reason: 'idle', locale: 'ja' })).toEqual({ state: null, reason: 'idle', locale: 'ja' })
    expect(readArg({ reason: 'manual', locale: 'fr' })).toEqual({ state: null, reason: 'manual' })
  })
})

describe('refresh: full, incremental, 410, day change, account', () => {
  it('full: only visible calendars, pagination, cancellations are not included, all-day, time ranges, one occurrence of a recurrence', async () => {
    const f = fake(fullRoute())
    expect(await runRefresh(arg('en'), f.api, opts())).toEqual({ more: false })
    const paths = f.calls.map((call) => new URL(call.url).pathname)
    expect(paths).toEqual([
      '/calendar/v3/users/me/calendarList',
      `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`,
      `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`,
      `/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`
    ])
    const first = new URL(f.calls[1]?.url ?? '')
    expect(first.searchParams.get('singleEvents')).toBe('true')
    expect(first.searchParams.get('timeMin')).not.toBeNull()
    expect(first.searchParams.get('timeMax')).not.toBeNull()
    expect(first.searchParams.get('syncToken')).toBeNull()
    expect(new URL(f.calls[2]?.url ?? '').searchParams.get('pageToken')).toBe('p2')
    expect(cache.calendars.map((calendar) => calendar.id)).toEqual([PRIMARY, TEAM])
    expect(cache.tokenOf(PRIMARY)).toBe('sync-1')
    expect(cache.tokenOf(TEAM)).toBe('sync-team-1')
    expect(cache.all().map((event) => event.eventId).sort()).toEqual(['conf1', 'ny1', 'standup1', 'team1', 'trip1', 'weekly_20261124T010000Z'])

    const rows = f.rows.at(-1) ?? []
    expect(sidebarRowsWithinLimits(rows)).toBe(true)
    expect(group(rows, 'today')).toEqual(['10:00–11:00 Standup SECRET-TITLE', '15:00–16:00 Team lunch'])
    expect(group(rows, 'tomorrow')).toEqual(['All day Trip'])
    const week = group(rows, 'week')
    expect(week).toHaveLength(3)
    expect(week[0]).toMatch(/11\/24.*10:00–10:30 Weekly sync/)
    // 20:00 in New York = 10:00 the next day in Tokyo.
    expect(week[1]).toMatch(/11\/25.*10:00–11:00 Call with NY/)
    expect(week[2]).toMatch(/11\/26.*All day Conference/)
    expect(f.reports.at(-1)).toEqual({ done: 6, total: null, state: 'done' })
  })

  it('details are in the child rows (time, place, video, guests, organizer, description, another calendar); markup in the description is removed', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg('en'), f.api, opts())
    const rows = f.rows.at(-1) ?? []
    const today = rows.find((row) => row.id === 'today')?.children ?? []
    const standupRow = today[0]
    expect(standupRow?.description).toBe('Room A')
    expect(standupRow?.uri).toBeUndefined()
    expect((standupRow?.children ?? []).map((row) => row.label)).toEqual([
      expect.stringMatching(/11\/20.*10:00 – 11:00/),
      'Where: Room A',
      'Video call: https://meet.google.com/abc-defg-hij',
      'Guests (2): Alice, b@example.com',
      'Organizer: Boss',
      'Notes: Agenda Item & more'
    ])
    const lunch = today[1]
    expect((lunch?.children ?? []).map((row) => row.label)).toContain('Calendar: Team')
  })

  it('incremental: fetches by syncToken and reflects updates, cancellations and series deletions; a 410 calendar goes back to full', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg('en'), f.api, opts())
    f.calls.length = 0
    f.route = (url) => {
      if (url.pathname === '/calendar/v3/users/me/calendarList') return { status: 200, body: calendarList() }
      if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`) {
        expect(url.searchParams.get('syncToken')).toBe('sync-1')
        return {
          status: 200,
          body: {
            items: [{ ...standup, summary: 'Standup moved' }, { id: 'weekly', status: 'cancelled' }, { id: 'trip1', status: 'cancelled' }],
            nextSyncToken: 'sync-2'
          }
        }
      }
      if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`) {
        if (url.searchParams.get('syncToken') !== null) return { status: 410, body: { error: { code: 410 } } }
        return { status: 200, body: { items: [], nextSyncToken: 'sync-team-2' } }
      }
      return null
    }
    await runRefresh(arg('en'), f.api, opts(NOW + 15 * 60_000))
    const incremental = new URL(f.calls[1]?.url ?? '')
    expect(incremental.searchParams.get('timeMin')).toBeNull()
    expect(incremental.searchParams.get('singleEvents')).toBe('true')
    // The team calendar: 410 on the token, then a full fetch with the window.
    expect(f.calls.slice(2).map((call) => new URL(call.url).searchParams.has('timeMin'))).toEqual([false, true])
    expect(cache.tokenOf(PRIMARY)).toBe('sync-2')
    expect(cache.tokenOf(TEAM)).toBe('sync-team-2')
    expect(cache.all().map((event) => event.title).sort()).toEqual(['Call with NY', 'Conference', 'Standup moved'])
    const rows = f.rows.at(-1) ?? []
    expect(group(rows, 'tomorrow')).toEqual(['No events'])
  })

  it('when the day changes (the window moves), re-fetches everything even with a syncToken', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg(), f.api, opts())
    f.calls.length = 0
    await runRefresh(arg(), f.api, opts(NOW + 24 * 3_600_000))
    const eventCalls = f.calls.filter((call) => call.url.includes('/events'))
    expect(eventCalls.every((call) => new URL(call.url).searchParams.get('syncToken') === null)).toBe(true)
  })

  it('discards the local events for a different account (different primary calendar)', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg(), f.api, opts())
    f.route = (url) => {
      if (url.pathname === '/calendar/v3/users/me/calendarList') return { status: 200, body: { items: [{ id: 'other@example.com', primary: true, selected: true }] } }
      return { status: 200, body: { items: [], nextSyncToken: 's' } }
    }
    await runRefresh(arg(), f.api, opts(NOW + 60_000))
    expect(cache.account).toBe('other@example.com')
    expect(cache.size).toBe(0)
    expect(f.calls.at(-1)?.url).toContain(encodeURIComponent('other@example.com'))
  })
})

describe('refresh: not connected, expired, 429, 5xx', () => {
  it('not connected discards the local copy and shows the connect guide (sends nothing to Google)', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg(), f.api, opts())
    f.calls.length = 0
    f.credential = { present: false, host: null }
    await runRefresh(arg('ja'), f.api, opts())
    expect(f.calls).toEqual([])
    expect(cache.size).toBe(0)
    expect(labels(f.rows.at(-1) ?? [])).toEqual([
      'Google カレンダーに接続していません',
      '拡張機能 → Google Calendar → アカウント からログインしてください。'
    ])
  })

  it('expired (the Broker returns the host with present: false) shows the reconnect guide and keeps the previous list (does not silently vanish)', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg('en'), f.api, opts())
    f.calls.length = 0
    f.credential = { present: false, host: 'www.googleapis.com' }
    expect(await runRefresh(arg('en'), f.api, opts())).toEqual({ more: false })
    expect(f.calls).toEqual([])
    const rows = f.rows.at(-1) ?? []
    expect(rows[0]?.label).toBe('Google Calendar sign-in has expired')
    expect(group(rows, 'today')).toHaveLength(2)
    expect(f.reports.at(-1)?.state).toBe('needs-reauth')
  })

  it('the same for 401 (reconnect guide, keeps the list)', async () => {
    const f = fake(fullRoute())
    await runRefresh(arg('en'), f.api, opts())
    f.route = () => ({ status: 401, body: { error: { code: 401 } } })
    expect(await runRefresh(arg('en'), f.api, opts(NOW + 60_000))).toEqual({ more: false })
    const rows = f.rows.at(-1) ?? []
    expect(rows[0]?.id).toBe('reauth')
    expect(group(rows, 'today')).toHaveLength(2)
    expect(f.reports.at(-1)?.state).toBe('needs-reauth')
  })

  it("the Broker's no-credential (a token that failed to refresh) also gives the reconnect guide", async () => {
    const f = fake(fullRoute())
    f.api = { ...f.api, net: { fetch: async () => Promise.reject(new Error('no-credential')) } }
    await runRefresh(arg('en'), f.api, opts())
    expect(f.rows.at(-1)?.[0]?.id).toBe('reauth')
  })

  it('429 / 5xx continue in the next round (more + wait) with the reason on the badge', async () => {
    const f = fake(() => ({ status: 429, body: {} }))
    expect(await runRefresh(arg(), f.api, opts())).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(f.reports.at(-1)?.state).toBe('rate-limited')
    f.route = () => ({ status: 503, body: {} })
    expect(await runRefresh(arg(), f.api, opts())).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(f.reports.at(-1)?.state).toBe('offline')
  })

  it('when the per-request limit is exceeded, outputs what was fetched and continues in the next round', async () => {
    const f = fake(fullRoute())
    expect(await runRefresh(arg(), f.api, { ...opts(), budget: 2 })).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(f.calls).toHaveLength(2)
  })
})

describe('review: a full fetch cut by the budget continues per calendar from where it stopped (does not start over)', () => {
  /** The primary calendar in 5 pages (one event each, today), the team calendar in 1. */
  const BIG_PAGES = 5
  const bigEvent = (i: number) => ({
    id: `big${i}`,
    status: 'confirmed',
    summary: `Big ${i}`,
    start: { dateTime: `2026-11-20T1${i}:00:00+09:00` },
    end: { dateTime: `2026-11-20T1${i}:30:00+09:00` }
  })
  const bigRoute = (options: { primaryToken?: string | null } = {}): Route => (url) => {
    if (url.pathname === '/calendar/v3/users/me/calendarList') return { status: 200, body: calendarList() }
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`) {
      if (url.searchParams.get('syncToken') !== null) return { status: 200, body: { items: [], nextSyncToken: 'sync-big-2' } }
      const at = Number((url.searchParams.get('pageToken') ?? 'p0').slice(1))
      const last = at === BIG_PAGES - 1
      const token = options.primaryToken === undefined ? 'sync-big' : options.primaryToken
      return {
        status: 200,
        body: { items: [bigEvent(at)], ...(last ? (token === null ? {} : { nextSyncToken: token }) : { nextPageToken: `p${at + 1}` }) }
      }
    }
    return fullRoute()(url)
  }
  const pageTokens = (f: Fake): (string | null)[] =>
    f.calls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname.includes(encodeURIComponent(PRIMARY)))
      .map((url) => url.searchParams.get('pageToken'))

  it('the first round is cut at 3 pages and output, the second continues from p3 and finishes, and the completion mark is set; the third is incremental', async () => {
    const f = fake(bigRoute())
    // 1 list + 3 pages.
    expect(await runRefresh(arg('en'), f.api, { ...opts(), budget: 4 })).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(pageTokens(f)).toEqual([null, 'p1', 'p2'])
    expect(group(f.rows.at(-1) ?? [], 'today')).toEqual(['10:00–10:30 Big 0', '11:00–11:30 Big 1', '12:00–12:30 Big 2'])
    expect(cache.fullDay).toBeNull()

    f.calls.length = 0
    // 1 list + pages 3, 4 + the team calendar.
    expect(await runRefresh(arg('en'), f.api, { ...opts(NOW + 60_000), budget: 4 })).toEqual({ more: false })
    expect(pageTokens(f)).toEqual(['p3', 'p4'])
    expect(f.calls).toHaveLength(4)
    expect(cache.tokenOf(PRIMARY)).toBe('sync-big')
    expect(cache.tokenOf(TEAM)).toBe('sync-team-1')
    expect(cache.all().filter((event) => event.calendarId === PRIMARY).map((event) => event.eventId).sort()).toEqual([
      'big0',
      'big1',
      'big2',
      'big3',
      'big4'
    ])
    expect(cache.fullDay).toBe('2026-11-20')

    f.calls.length = 0
    expect(await runRefresh(arg('en'), f.api, { ...opts(NOW + 120_000), budget: 4 })).toEqual({ more: false })
    const events = f.calls.filter((call) => call.url.includes('/events')).map((call) => new URL(call.url))
    expect(events.every((url) => url.searchParams.get('syncToken') !== null)).toBe(true)
  })

  it('calendars already done are not re-fetched in the continuing round; events that vanished mid-full-fetch are removed on completion', async () => {
    const f = fake(bigRoute())
    await runRefresh(arg('en'), f.api, opts())
    expect(cache.size).toBe(BIG_PAGES + 1)
    // The next day: a full fetch again. Event big4 is gone now; the budget cuts after the primary's 2nd page.
    const nextDay = NOW + 24 * 3_600_000
    f.route = (url) => {
      const answer = bigRoute()(url)
      if (answer !== null && url.searchParams.get('pageToken') === 'p4') return { status: 200, body: { items: [], nextSyncToken: 'sync-big-3' } }
      return answer
    }
    f.calls.length = 0
    expect(await runRefresh(arg('en'), f.api, { ...opts(nextDay), budget: 3 })).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(cache.all().some((event) => event.eventId === 'big4')).toBe(true)
    f.calls.length = 0
    expect(await runRefresh(arg('en'), f.api, { ...opts(nextDay + 60_000), budget: 40 })).toEqual({ more: false })
    expect(pageTokens(f)).toEqual(['p2', 'p3', 'p4'])
    expect(cache.all().some((event) => event.eventId === 'big4')).toBe(false)
    expect(cache.tokenOf(PRIMARY)).toBe('sync-big-3')
  })

  it('a calendar without a sync token is not re-fetched in the continuing round (1 minute later) and is re-fetched in the round 15 minutes later', async () => {
    const f = fake(bigRoute({ primaryToken: null }))
    await runRefresh(arg('en'), f.api, opts())
    expect(cache.tokenOf(PRIMARY)).toBeNull()
    f.calls.length = 0
    await runRefresh(arg('en'), f.api, opts(NOW + 60_000))
    expect(pageTokens(f)).toEqual([])
    f.calls.length = 0
    await runRefresh(arg('en'), f.api, opts(NOW + 15 * 60_000))
    expect(pageTokens(f)).toEqual([null, 'p1', 'p2', 'p3', 'p4'])
  })
})

describe('review: unreadable calendars (404 / 403 / 400) and the API being disabled (all 403)', () => {
  const teamRefused = (status: number): Route => (url) => {
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`) return { status, body: { error: { code: status } } }
    return fullRoute()(url)
  }

  it('even if one is refused, outputs the rest; drops the earlier events of that calendar; the log has only the count and status', async () => {
    for (const status of [404, 403, 400]) {
      cache.clear()
      const f = fake(fullRoute())
      await runRefresh(arg('en'), f.api, opts())
      expect(cache.all().some((event) => event.calendarId === TEAM)).toBe(true)
      f.route = teamRefused(status)
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        expect(await runRefresh(arg('en'), f.api, opts(NOW + 24 * 3_600_000))).toEqual({ more: false })
        const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n')
        expect(logged).toContain(`"event":"calendar.refresh.skipped","calendars":1,"statuses":"${status}"`)
        expect(logged).not.toContain(TEAM)
      } finally {
        spy.mockRestore()
      }
      expect(cache.all().some((event) => event.calendarId === TEAM)).toBe(false)
      expect(cache.all().some((event) => event.calendarId === PRIMARY)).toBe(true)
      const rows = f.rows.at(-1) ?? []
      expect(rows.map((row) => row.id)).toEqual(['today', 'tomorrow', 'week'])
      expect(f.reports.at(-1)?.state).toBe('done')
    }
  })

  it('when all calendars are 403, shows a reason row (EN / JA) in the list and makes the task a failure with a clear reason', async () => {
    const f = fake((url) => {
      if (url.pathname.endsWith('/events')) return { status: 403, body: { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } } }
      return fullRoute()(url)
    })
    await expect(runRefresh(arg('ja'), f.api, opts())).rejects.toThrow(/Google Calendar API is enabled/)
    const rows = f.rows.at(-1) ?? []
    expect(rows[0]?.id).toBe('api-refused')
    expect(labels(rows.slice(0, 1))).toEqual([
      'Google カレンダーが読み取りを断りました (403)',
      'OAuth クライアントの Google Cloud プロジェクトで Google Calendar API が有効か確かめてください。有効にしてから使えるまで数分かかることがあります。'
    ])
    // It is read again once enabled: the row goes.
    f.route = fullRoute()
    expect(await runRefresh(arg('en'), f.api, opts(NOW + 15 * 60_000))).toEqual({ more: false })
    expect(f.rows.at(-1)?.[0]?.id).toBe('today')
  })

  it('the same when the calendar list itself is 403 (an English row)', async () => {
    const f = fake(() => ({ status: 403, body: { error: { code: 403 } } }))
    await expect(runRefresh(arg('en'), f.api, opts())).rejects.toThrow(/Google Calendar API is enabled/)
    expect(f.calls).toHaveLength(1)
    expect(labels(f.rows.at(-1)?.slice(0, 1) ?? [])[0]).toBe('Google Calendar refused access (403)')
  })

  it('a 403 rate limit stays rate-limited as before (not treated as an unreadable calendar)', async () => {
    const f = fake((url) => {
      if (url.pathname.endsWith('/events')) return { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }
      return fullRoute()(url)
    })
    expect(await runRefresh(arg(), f.api, opts())).toEqual({ more: true, retryAfterMs: 60_000 })
    expect(f.reports.at(-1)?.state).toBe('rate-limited')
  })

  it('listEvents: returns the rest with the number of skipped calendars; a specified single one and all 403 are refused with a reason', async () => {
    const f = fake(teamRefused(404))
    const text = await listEvents({ from: '2026-11-20', to: '2026-11-21' }, f.api, { now: () => NOW, timeZone: TZ })
    expect(text).toContain('Standup SECRET-TITLE')
    expect(text).toContain('(1 calendar(s) could not be read and were skipped: HTTP 404)')
    await expect(listEvents({ calendarId: TEAM }, f.api, { now: () => NOW, timeZone: TZ })).rejects.toThrow(/Not found/)
    f.route = (url) => (url.pathname.endsWith('/events') ? { status: 403, body: {} } : fullRoute()(url))
    await expect(listEvents({}, f.api, { now: () => NOW, timeZone: TZ })).rejects.toThrow(/Google Calendar API is enabled/)
    f.route = () => ({ status: 403, body: {} })
    await expect(listCalendars({}, f.api)).rejects.toThrow(/Google Calendar API is enabled/)
  })
})

describe('GET only and no body in the log', () => {
  it('refresh and tool requests carry neither method nor body and attach only the credential name', async () => {
    const f = fake((url) => {
      if (url.pathname.endsWith('/events/standup1')) return { status: 200, body: standup }
      return fullRoute()(url)
    })
    await runRefresh(arg(), f.api, opts())
    await listCalendars({}, f.api)
    await listEvents({}, f.api, { now: () => NOW, timeZone: TZ })
    await getEvent({ calendarId: PRIMARY, eventId: 'standup1' }, f.api, { timeZone: TZ })
    expect(f.calls.length).toBeGreaterThan(5)
    for (const call of f.calls) {
      expect(call.init).toEqual({ auth: CALENDAR_READONLY_CREDENTIAL })
      expect(call.url.startsWith('https://www.googleapis.com/calendar/v3/')).toBe(true)
    }
  })

  it('event titles, places, descriptions and attendees do not appear in the log (counts only)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const f = fake(fullRoute())
      await runRefresh(arg(), f.api, opts())
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(logged).toContain('calendar.refresh')
      for (const secret of ['SECRET-TITLE', 'Room A', 'Agenda', 'a@example.com', PRIMARY]) expect(logged).not.toContain(secret)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('list rows', () => {
  function event(id: string, start: string, end: string, title = id): CalendarEvent {
    const change = toChange(PRIMARY, { id, status: 'confirmed', summary: title, start: { dateTime: start }, end: { dateTime: end } })
    if (change?.kind !== 'upsert') throw new Error('fixture')
    return change.event
  }

  it('Japanese: the heading and the all-day word', () => {
    const allDay = toChange(PRIMARY, trip)
    if (allDay?.kind !== 'upsert') throw new Error('fixture')
    const rows = buildRows({ events: [allDay.event], calendars: [], connection: 'ok', now: NOW, locale: 'ja', timeZone: TZ })
    expect(rows.map((row) => row.label)).toEqual(['今日', '明日', '今週'])
    expect(group(rows, 'today')).toEqual(['予定はありません'])
    expect(group(rows, 'tomorrow')).toEqual(['終日 Trip'])
  })

  it('an event crossing midnight appears only once on its start day (10:00-24:00 is 1 day)', () => {
    const late = event('late', '2026-11-20T22:00:00+09:00', '2026-11-21T02:00:00+09:00', 'Late')
    const toMidnight = event('mid', '2026-11-20T10:00:00+09:00', '2026-11-21T00:00:00+09:00', 'Long')
    expect(coversDay(toMidnight, '2026-11-21', TZ)).toBe(false)
    const rows = buildRows({ events: [late, toMidnight], calendars: [], connection: 'ok', now: NOW, locale: 'en', timeZone: TZ })
    expect(group(rows, 'today')).toEqual(['10:00–00:00 Long', '22:00– Late'])
    expect(group(rows, 'tomorrow')).toEqual(['No events'])
  })

  it('review: an event of length 0 goes on its start day (even at exactly 0:00); also pins the days of events that cross days and events ending at 0:00', () => {
    const midnightZero = event('z0', '2026-11-21T00:00:00+09:00', '2026-11-21T00:00:00+09:00', 'Zero at midnight')
    const noonZero = event('z12', '2026-11-20T12:00:00+09:00', '2026-11-20T12:00:00+09:00', 'Zero at noon')
    const across = event('across', '2026-11-20T23:00:00+09:00', '2026-11-22T01:00:00+09:00', 'Across')
    const toMidnight = event('mid', '2026-11-20T10:00:00+09:00', '2026-11-21T00:00:00+09:00', 'Long')
    expect(['2026-11-20', '2026-11-21', '2026-11-22'].map((day) => coversDay(midnightZero, day, TZ))).toEqual([false, true, false])
    expect(['2026-11-19', '2026-11-20', '2026-11-21'].map((day) => coversDay(noonZero, day, TZ))).toEqual([false, true, false])
    expect(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'].map((day) => coversDay(across, day, TZ))).toEqual([
      false,
      true,
      true,
      true,
      false
    ])
    expect(['2026-11-20', '2026-11-21'].map((day) => coversDay(toMidnight, day, TZ))).toEqual([true, false])
    // The instant range: a zero-length event at the very start of the range is in it; one at its end is not.
    const at = Date.parse('2026-11-21T00:00:00+09:00')
    expect(overlapsRange(midnightZero, at, at + 3_600_000, TZ)).toBe(true)
    expect(overlapsRange(midnightZero, at - 3_600_000, at, TZ)).toBe(false)
    const rows = buildRows({ events: [midnightZero, noonZero], calendars: [], connection: 'ok', now: NOW, locale: 'en', timeZone: TZ })
    expect(group(rows, 'today')).toEqual(['12:00–12:00 Zero at noon'])
    expect(group(rows, 'tomorrow')).toEqual(['00:00–00:00 Zero at midnight'])
  })

  it("too many events are cut at the limit and shown as 「ほか N 件」; the number of rows, depth and id fit the Broker's limits", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      toChange(PRIMARY, {
        ...standup,
        id: `e${i}`,
        summary: `${'x'.repeat(600)}${i}`,
        start: { dateTime: `2026-11-20T${String(13 + (i % 10)).padStart(2, '0')}:00:00+09:00` },
        end: { dateTime: `2026-11-20T${String(13 + (i % 10)).padStart(2, '0')}:30:00+09:00` }
      })
    ).flatMap((change) => (change?.kind === 'upsert' ? [change.event] : []))
    const rows = buildRows({ events: many, calendars: [], connection: 'reauth', now: NOW, locale: 'en', timeZone: TZ })
    expect(sidebarRowsWithinLimits(rows)).toBe(true)
    expect(group(rows, 'today')).toHaveLength(MAX_LISTED_EVENTS)
    expect(rows.at(-1)?.label).toBe(`… ${100 - MAX_LISTED_EVENTS} more`)
    for (const label of labels(rows)) expect(label.length).toBeLessThanOrEqual(512)
  })
})

describe('parts of the Google entry', () => {
  it('an id cannot leave the URL set (., .., /, \\ and control characters are refused)', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(1025), 3]) expect(isSafeId(bad)).toBe(false)
    expect(isSafeId('weekly_20261124T010000Z')).toBe(true)
    expect(() => eventUrl(PRIMARY, '..')).toThrow()
    expect(eventUrl('a b@example.com', 'id1')).toBe('https://www.googleapis.com/calendar/v3/calendars/a%20b%40example.com/events/id1')
  })

  it('an incremental URL has no range, order or search (Google does not accept them together)', () => {
    const url = new URL(eventsUrl(PRIMARY, { syncToken: 't', timeMin: NOW, timeMax: NOW + 1, query: 'q', orderByStart: true }))
    expect([...url.searchParams.keys()].sort()).toEqual(['maxResults', 'singleEvents', 'syncToken'])
  })

  it('the HTML of a description becomes text only', () => {
    expect(plainText('<p>Hello&nbsp;<a href="https://x">link</a></p><script>x</script>&lt;b&gt;')).toBe('Hello link\nx<b>')
  })

  it('EventCache: drops events that moved outside the window and cancellations by series id', () => {
    const store = new EventCache()
    const inWindow = toChange(PRIMARY, weekly)
    if (inWindow?.kind !== 'upsert') throw new Error('fixture')
    store.replace(PRIMARY, [inWindow], 't1', NOW)
    expect(store.size).toBe(1)
    const moved = toChange(PRIMARY, { ...weekly, start: { dateTime: '2027-06-01T10:00:00Z' }, end: { dateTime: '2027-06-01T11:00:00Z' } })
    store.apply(PRIMARY, moved === null ? [] : [moved], 't2', NOW)
    expect(store.size).toBe(0)
    store.replace(PRIMARY, [inWindow], 't3', NOW)
    store.apply(PRIMARY, [{ kind: 'removed', calendarId: PRIMARY, eventId: 'weekly' }], 't4', NOW)
    expect(store.size).toBe(0)
    expect(store.tokenOf(PRIMARY)).toBe('t4')
  })
})

describe('tools (the entry read by the AI)', () => {
  it('listCalendars: an untrusted note and the id', async () => {
    const f = fake(fullRoute())
    const text = await listCalendars({}, f.api)
    expect(text.startsWith(UNTRUSTED_NOTE)).toBe(true)
    expect(text).toContain(`id: ${PRIMARY}`)
    expect(text).not.toContain('Hidden')
  })

  it('listEvents: the default is 7 days from now, dates are the local midnight, with ids attached', async () => {
    const f = fake(fullRoute())
    const text = await listEvents({ calendarId: PRIMARY, from: '2026-11-20', to: '2026-11-21', query: 'stand' }, f.api, { now: () => NOW, timeZone: TZ })
    const url = new URL(f.calls.at(-1)?.url ?? '')
    expect(url.searchParams.get('timeMin')).toBe('2026-11-19T15:00:00.000Z')
    expect(url.searchParams.get('timeMax')).toBe('2026-11-20T15:00:00.000Z')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('q')).toBe('stand')
    expect(text.startsWith(UNTRUSTED_NOTE)).toBe(true)
    expect(text).toContain('2026-11-20 10:00 +09:00 – 2026-11-20 11:00 +09:00 | Standup SECRET-TITLE | at Room A')
    expect(text).toContain(`calendarId: ${PRIMARY} | eventId: standup1`)
    expect(text).not.toContain('Weekly sync')

    f.calls.length = 0
    await listEvents({}, f.api, { now: () => NOW, timeZone: TZ })
    const defaults = f.calls.filter((call) => call.url.includes('/events')).map((call) => new URL(call.url))
    expect(defaults.map((u) => u.searchParams.get('timeMin'))).toEqual([new Date(NOW).toISOString(), new Date(NOW).toISOString()])
    expect(defaults[0]?.searchParams.get('timeMax')).toBe(new Date(NOW + 7 * 24 * 3_600_000).toISOString())
  })

  it('listEvents: refuses malformed ranges, overlong ranges and ids outside the set before sending', async () => {
    const f = fake(fullRoute())
    await expect(listEvents({ from: '2026-11-20T10:00:00' }, f.api)).rejects.toThrow(/offset/)
    await expect(listEvents({ from: '2026-11-20', to: '2026-11-19' }, f.api)).rejects.toThrow(/after/)
    await expect(listEvents({ from: '2026-01-01', to: '2027-06-01' }, f.api)).rejects.toThrow(/366/)
    await expect(listEvents({ calendarId: '..' }, f.api)).rejects.toThrow(/calendar id/)
    await expect(getEvent({ calendarId: PRIMARY, eventId: '../../gmail' }, f.api)).rejects.toThrow(/event id/)
    expect(f.calls).toEqual([])
  })

  it('getEvent: the whole (the description as text only, guest responses, video, links); says so for cancelled ones', async () => {
    const f = fake((url) => {
      if (url.pathname.endsWith('/events/standup1')) return { status: 200, body: standup }
      if (url.pathname.endsWith('/events/gone1')) return { status: 200, body: goneInFull }
      return null
    })
    const text = await getEvent({ calendarId: PRIMARY, eventId: 'standup1' }, f.api, { timeZone: TZ })
    expect(text.startsWith(UNTRUSTED_NOTE)).toBe(true)
    expect(text).toContain('When: 2026-11-20 10:00 +09:00 – 2026-11-20 11:00 +09:00')
    expect(text).toContain('Alice <a@example.com> (tentative)')
    expect(text).toContain('b@example.com (needs-action, optional)')
    expect(text).toContain('(accepted, the user)')
    expect(text).not.toContain('room@resource')
    expect(text).toContain('Video call: https://meet.google.com/abc-defg-hij')
    expect(text).toContain('Agenda\nItem & more')
    expect(await getEvent({ calendarId: PRIMARY, eventId: 'gone1' }, f.api)).toContain('was cancelled')
    await expect(getEvent({ calendarId: PRIMARY, eventId: 'nope' }, f.api)).rejects.toThrow(/Not found/)
  })

  it('refuses with words that make clear 「ログインして」 when not connected', async () => {
    const f = fake(() => ({ status: 401, body: {} }))
    await expect(listEvents({}, f.api)).rejects.toThrow(/sign in under Extensions/)
  })

  it('the time text includes the offset', () => {
    expect(instantText(Date.parse('2026-11-20T01:00:00Z'), TZ)).toBe('2026-11-20 10:00 +09:00')
    expect(instantText(Date.parse('2026-11-20T01:00:00Z'), 'America/New_York')).toBe('2026-11-19 20:00 -05:00')
    expect(parseInstant('2026-11-20', 'from', 'America/New_York')).toBe(Date.parse('2026-11-20T05:00:00Z'))
  })
})

// ---- Main: the Broker and sign-in ----

interface Sent {
  url: string
  headers: Record<string, string>
}

function transport(sent: Sent[]): NetTransport {
  return {
    async resolve() {
      return [{ address: '142.250.0.1', family: 4 }]
    },
    async send(url, options) {
      sent.push({ url: url.href, headers: options.headers })
      return { status: 200, headers: {}, body: new TextEncoder().encode('{}'), truncated: false }
    }
  }
}

describe('Broker: the calendar credential only for GET / HEAD and only under /calendar/v3/, owner only', () => {
  const HOST = 'www.googleapis.com'
  let dbDir: string
  let db: Db
  let audit: AuditLog
  let store: CredentialStore
  let sent: Sent[]

  const policyFor = (id: string): PluginPolicy => ({
    id,
    declared: {
      credentials: [CALENDAR_READONLY_CREDENTIAL],
      networkHosts: [HOST],
      fsRead: [],
      fsWrite: [],
      indexSources: [],
      ui: false
    },
    consented: new Set<CapabilityName>(['network', 'credentials'])
  })

  const brokerFor = (): CapabilityBroker =>
    new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: store,
      policyOf: (id) => policyFor(id),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      transport: transport(sent)
    })

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'aios-calendar-broker-'))
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key = '${'d'.repeat(64)}'`)
    runMigrations(db)
    audit = new AuditLog(db)
    store = new CredentialStore(dbDir, { available: () => true, seal: (v) => Buffer.from(v, 'utf8'), open: (b) => b.toString('utf8') })
    store.putOAuth(CALENDAR_READONLY_CREDENTIAL, {
      host: HOST,
      accessToken: 'cal-token',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      scope: CALENDAR_READONLY_SCOPE
    })
    sent = []
  })

  afterEach(() => {
    audit.dispose()
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  const fetchReq = (url: string, method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') =>
    ({ capability: 'network', op: 'fetch', url, auth: CALENDAR_READONLY_CREDENTIAL, ...(method === undefined ? {} : { method }) }) as const

  it('sends GET to /calendar/v3/ with the token attached', async () => {
    await brokerFor().handle('aios.calendar', fetchReq(`https://${HOST}/calendar/v3/users/me/calendarList`))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.headers['authorization']).toBe('Bearer cal-token')
  })

  it('POST / PUT / PATCH / DELETE are refused before sending (no token is made either)', async () => {
    const broker = brokerFor()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await expect(broker.handle('aios.calendar', fetchReq(`https://${HOST}/calendar/v3/calendars/primary/events`, method))).rejects.toThrow(
        'read-only'
      )
    }
    expect(sent).toEqual([])
  })

  it('does not attach it to another API on the same host (gmail, drive) or to paths that climb up with .. or %2e%2e', async () => {
    const broker = brokerFor()
    for (const url of [
      `https://${HOST}/gmail/v1/users/me/messages`,
      `https://${HOST}/drive/v3/files`,
      `https://${HOST}/calendar/v3/../../gmail/v1/users/me/profile`,
      `https://${HOST}/calendar/v3/%2e%2e/%2E%2E/gmail/v1/users/me/profile`,
      `https://${HOST}/calendar/v30/x`
    ]) {
      await expect(broker.handle('aios.calendar', fetchReq(url))).rejects.toThrow('read-only')
    }
    expect(sent).toEqual([])
    expect(googleRequestAllowed(CALENDAR_READONLY_CREDENTIAL, 'head', `https://${HOST}/calendar/v3/x`)).toBe(true)
    expect(googleRequestAllowed(CALENDAR_READONLY_CREDENTIAL, 'GET', 'not a url')).toBe(false)
    // A row without the restriction is not affected (Gmail keeps its behavior).
    expect(googleRequestAllowed('google:gmail.modify', 'POST', 'https://gmail.googleapis.com/batch/gmail/v1')).toBe(true)
  })

  it('review: even for a redirect to the same host, reapplies GET / HEAD and /calendar/v3/ at each hop (drops the token if it leaves)', async () => {
    const hops: Sent[] = []
    const redirecting = (location: (url: URL) => string | null, status = 302): NetTransport => ({
      async resolve() {
        return [{ address: '142.250.0.1', family: 4 }]
      },
      async send(url, options) {
        hops.push({ url: url.href, headers: options.headers })
        const next = location(url)
        const headers: Record<string, string> = next === null ? {} : { location: next }
        return { status: next === null ? 200 : status, headers, body: new TextEncoder().encode('{}'), truncated: false }
      }
    })
    const brokerWith = (net: NetTransport, policyOf: (id: string) => PluginPolicy = policyFor): CapabilityBroker =>
      new CapabilityBroker({
        scope: { rules: testExclusions(homedir()) },
        audit,
        credentials: store,
        policyOf,
        index: { put: async () => undefined, remove: async () => undefined },
        notify: () => undefined,
        transport: net
      })

    // Out of the calendar API on the same host: the second hop goes without the token.
    for (const target of ['/drive/v3/files', '/calendar/v3/../../gmail/v1/users/me/profile', '/gmail/v1/users/me/messages']) {
      hops.length = 0
      await brokerWith(redirecting((url) => (url.pathname.startsWith('/calendar/v3/users') ? target : null))).handle(
        'aios.calendar',
        fetchReq(`https://${HOST}/calendar/v3/users/me/calendarList`)
      )
      expect(hops.map((hop) => hop.headers['authorization'] ?? null)).toEqual(['Bearer cal-token', null])
    }
    // Inside the calendar API: kept.
    hops.length = 0
    await brokerWith(redirecting((url) => (url.pathname.endsWith('/calendarList') ? '/calendar/v3/users/me/calendarList2' : null))).handle(
      'aios.calendar',
      fetchReq(`https://${HOST}/calendar/v3/users/me/calendarList`)
    )
    expect(hops.map((hop) => hop.headers['authorization'] ?? null)).toEqual(['Bearer cal-token', 'Bearer cal-token'])

    // aios.gmail keeps its behavior: its row has no method / path binding, so a same-host redirect of a POST (307) still carries the token.
    store.putOAuth('google:gmail.modify', {
      host: 'gmail.googleapis.com',
      accessToken: 'gmail-token',
      refreshToken: 'rt-g',
      expiresAt: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/gmail.modify'
    })
    const gmailPolicy = (id: string): PluginPolicy => ({
      id,
      declared: { credentials: ['google:gmail.modify'], networkHosts: ['gmail.googleapis.com'], fsRead: [], fsWrite: [], indexSources: [], ui: false },
      consented: new Set<CapabilityName>(['network', 'credentials'])
    })
    hops.length = 0
    await brokerWith(
      redirecting((url) => (url.pathname.startsWith('/gmail/') ? '/upload/elsewhere' : null), 307),
      gmailPolicy
    ).handle('aios.gmail', {
      capability: 'network',
      op: 'fetch',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      method: 'POST',
      body: '{}',
      auth: 'google:gmail.modify'
    })
    expect(hops.map((hop) => hop.headers['authorization'] ?? null)).toEqual(['Bearer gmail-token', 'Bearer gmail-token'])
  })

  it('another extension (including aios.gmail) cannot use it even if it declares this name', async () => {
    const broker = brokerFor()
    for (const id of ['aios.gmail', 'evil.plugin']) {
      await expect(broker.handle(id, fetchReq(`https://${HOST}/calendar/v3/users/me/calendarList`))).rejects.toThrow('not-owner')
      await expect(broker.handle(id, { capability: 'credentials', op: 'status', name: CALENDAR_READONLY_CREDENTIAL })).rejects.toThrow('not-owner')
    }
    expect(sent).toEqual([])
  })

  it('cannot go out to hosts that are not allowed (oauth2 / accounts)', async () => {
    const broker = brokerFor()
    await expect(
      broker.handle('aios.calendar', { capability: 'network', op: 'fetch', url: 'https://oauth2.googleapis.com/token', method: 'POST', body: 'x' })
    ).rejects.toThrow()
    expect(sent).toEqual([])
  })
})

describe('login: a read-only name holds no token with a broader scope than requested', () => {
  let dir: string
  let store: CredentialStore
  const client: OAuthClient = {
    clientId: 'id',
    clientSecret: 'cs',
    authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token'
  }
  /** Sends the redirect back to the local loopback server in place of the browser (nothing leaves the machine). */
  const browser = (authUrl: string): void => {
    const u = new URL(authUrl)
    const back = new URL(u.searchParams.get('redirect_uri') ?? '')
    back.searchParams.set('code', 'c')
    back.searchParams.set('state', u.searchParams.get('state') ?? '')
    void fetch(back).catch(() => undefined)
  }
  const tokenWith = (scope: string): FetchFn => async () => ({
    status: 200,
    text: async () => JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope })
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-calendar-cred-'))
    store = new CredentialStore(dir, { available: () => true, seal: (v) => Buffer.from(v), open: (b) => b.toString() })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const signIn = (fetchFn: FetchFn, exactScopes: boolean) =>
    signInGoogle({
      store,
      name: CALENDAR_READONLY_CREDENTIAL,
      host: 'www.googleapis.com',
      client,
      scopes: [CALENDAR_READONLY_SCOPE],
      exactScopes,
      openUrl: browser,
      fetchFn
    })

  it('does not save when an extra scope (gmail.modify) comes along', async () => {
    await expect(signIn(tokenWith(`${CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`), true)).rejects.toMatchObject({
      code: 'access-denied'
    })
    expect(store.names()).toEqual([])
  })

  it('saves when the scope is exact; a name without exactScopes (Gmail) is as before', async () => {
    await signIn(tokenWith(CALENDAR_READONLY_SCOPE), true)
    expect(store.status(CALENDAR_READONLY_CREDENTIAL).present).toBe(true)
    store.remove(CALENDAR_READONLY_CREDENTIAL)
    await signIn(tokenWith(`${CALENDAR_READONLY_SCOPE} other`), false)
    expect(store.status(CALENDAR_READONLY_CREDENTIAL).present).toBe(true)
  })
})

describe("when the list is opened (renderer): if there are no rows yet, 「今すぐ実行」 that extension's task just once", () => {
  const job = (id: string, pluginId: string, extra: Partial<ScheduledJob> = {}): ScheduledJob =>
    ({ id, action: { kind: 'plugin', pluginId, taskId: 'refresh' }, enabled: true, running: false, ...extra }) as unknown as ScheduledJob
  const overview = (jobs: ScheduledJob[], autoRun = true): ScheduleOverview =>
    ({ jobs, autoRun, resumeReservations: [], laterSends: [] }) as ScheduleOverview

  beforeEach(() => resetPluginRefreshForTest())

  it('only its own enabled task, once per window, and swallows failures', async () => {
    const ran: string[] = []
    const schedule = {
      list: async () =>
        overview([job('a', 'aios.calendar'), job('b', 'aios.gmail'), job('c', 'aios.calendar', { enabled: false }), job('d', 'aios.calendar', { running: true })]),
      runNow: async (id: string) => {
        ran.push(id)
        throw new Error('schedule-job-running')
      }
    }
    await requestPluginRefresh('aios.calendar', schedule)
    await requestPluginRefresh('aios.calendar', schedule)
    expect(ran).toEqual(['a'])
  })

  it('does not run in a verification build (not autoRun)', async () => {
    const ran: string[] = []
    await requestPluginRefresh('aios.calendar', { list: async () => overview([job('a', 'aios.calendar')], false), runNow: async (id) => ran.push(id) })
    expect(ran).toEqual([])
  })
})
