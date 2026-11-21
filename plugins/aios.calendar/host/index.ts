/**
 * The plugin-host side of `aios.calendar` (TODO 1264 stage 1, ARCHITECTURE 7.5.4). **Read-only.**
 *
 * **This code does not run in main** (constraint 8). It reaches Google only through `api.net.fetch` (the Broker; the allowed host is
 * `www.googleapis.com`, and the Broker attaches the token of `google:calendar.readonly` only to GET / HEAD under `/calendar/v3/`).
 * The scheduled task `refresh` draws the sidebar list; the tools let the model read calendars and events. Nothing is written to Google,
 * and no event text is written to aios's database.
 */
import { LOCALES, type Locale } from '@shared/locale.js'
import type { PluginModule, PluginTaskArg } from '@shared/plugin.js'
import { runRefresh } from './sync.js'
import { getEvent, listCalendars, listEvents } from './tools.js'

export function readArg(arg: unknown): PluginTaskArg {
  const record = (typeof arg === 'object' && arg !== null ? arg : {}) as Record<string, unknown>
  const state = record['state']
  const reason = record['reason']
  const locale = record['locale']
  return {
    state: typeof state === 'object' && state !== null && !Array.isArray(state) ? (state as PluginTaskArg['state']) : null,
    reason: reason === 'idle' || reason === 'manual' ? reason : 'scheduled',
    ...((LOCALES as readonly unknown[]).includes(locale) ? { locale: locale as Locale } : {})
  }
}

const plugin: PluginModule = {
  tasks: {
    refresh: (arg, api) => runRefresh(readArg(arg), api)
  },
  mcp: {
    listCalendars: (arg, api) => listCalendars(arg, api),
    listEvents: (arg, api) => listEvents(arg, api),
    getEvent: (arg, api) => getEvent(arg, api)
  }
}

export default plugin
