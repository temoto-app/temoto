/**
 * The common error notice (TODO 1281, ARCHITECTURE.md 7.4.4): turns what arrived from main (a reason code, an IPC rejection that
 * carries `aios-reason:<code> {json}`, or a raw sentence) into three layers:
 *
 *   1. `summary`  - what failed, in the user's language (always shown).
 *   2. `recovery` - what to try, only for codes listed in `RECOVERY_CODES` (a `error.recovery.<code>` entry in the dictionary).
 *   3. `rows`     - technical detail (reason code, operation, error type, time), shown only after "Show details".
 *
 * Nothing here holds a message body, a stack or an argument value: main sends only identifier-like params
 * (`internalErrorParams` in `src/main/ipc/handlers.ts`) and the full text stays in the log.
 *
 * **Adding a recovery step for a code**: add the code to `RECOVERY_CODES` and an `error.recovery.<code>` entry to both dictionaries.
 * **Adding a button for a code**: add an entry to `noticeActionsFor` in `components/ErrorNotice.tsx`.
 */
import { parseReason, type ReasonCode } from '@shared/reason.js'
import { describeReason, type MessageKey, type Translate } from './i18n/index.js'

/** Codes that have an `error.recovery.<code>` sentence. */
export const RECOVERY_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'internal-error',
  'agent-not-logged-in',
  'agent-unavailable',
  'agent-version-too-old',
  'index-restart-failed',
  'index-busy',
  'export-pdf-failed',
  'export-html-failed',
  'export-md-failed',
  // TODO 1282: the recovery from an expired login (started from the expired-login bar or the Sidebar badge)
  'login-timeout',
  'login-check-failed',
  'login-still-failing',
  'login-credential-invalid',
  'login-api-key'
])

/** Areas (`aios:<area>/<op>`) that have an `error.area.<area>` label. Anything else is shown as "something went wrong". */
const AREAS = [
  'thread',
  'fs',
  'viewer',
  'plugin',
  'schedule',
  'search',
  'agent',
  'update',
  'editor',
  'web',
  'settings',
  'approval',
  'app'
] as const
type Area = (typeof AREAS)[number]

export interface NoticeRow {
  readonly label: string
  readonly value: string
}

export interface NoticeView {
  /** The reason code when one could be picked out; null for a raw sentence. */
  readonly code: ReasonCode | null
  readonly summary: string
  readonly recovery: string | null
  readonly rows: readonly NoticeRow[]
  /** The time of the failure as main stamped it (ISO), for locating the log line. null when main did not send one. */
  readonly at: string | null
}

function areaOf(channel: string): Area | null {
  const match = /^aios:([a-z]+)\//.exec(channel)
  const area = match?.[1]
  return AREAS.find((a) => a === area) ?? null
}

/** `2026-11-21T10:00:00.123Z` -> local time for reading, with the ISO text kept in the row so it can be matched against the log. */
function timeRow(tr: Translate, at: string): NoticeRow {
  const date = new Date(at)
  const local = Number.isNaN(date.getTime()) ? at : `${date.toLocaleString()} (${at})`
  return { label: tr('error.details.time'), value: local }
}

export function buildNotice(tr: Translate, message: string): NoticeView {
  const reason = parseReason(message)
  if (reason === null) {
    return { code: null, summary: message, recovery: null, rows: [], at: null }
  }
  const { code, params } = reason
  const str = (key: string): string | null => {
    const value = params[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const rows: NoticeRow[] = [{ label: tr('error.details.reason'), value: code }]
  let summary = describeReason(tr, message)
  const channel = str('channel')
  if (code === 'internal-error' && channel !== null) {
    const area = areaOf(channel)
    summary =
      area === null
        ? tr('error.failedOp.generic')
        : tr('error.failedOp', { operation: tr(`error.area.${area}` as MessageKey) })
    rows.push({ label: tr('error.details.operation'), value: channel })
  }
  const kind = str('kind')
  if (kind !== null) rows.push({ label: tr('error.details.kind'), value: kind })
  const errCode = str('code')
  if (errCode !== null) rows.push({ label: tr('error.details.code'), value: errCode })
  const at = str('at')
  if (at !== null) rows.push(timeRow(tr, at))
  return {
    code,
    summary,
    recovery: RECOVERY_CODES.has(code) ? tr(`error.recovery.${code}` as MessageKey) : null,
    rows,
    at
  }
}
