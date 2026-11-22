/**
 * Of the OS layer (TODO 986), the menu bar icon's menu as plain data (TODO 1269). **Does not import electron**: the order of the items, their labels and
 * whether they are enabled are decided here, so tests can check them; `tray.ts` turns the result into an electron `Menu`.
 *
 * Four things (owner decision 2026-11-20): show the window (open one if there is none), a new conversation, the number of pending approvals (the same
 * source as the Dock badge; with none it is a greyed row, and pressing it shows the window), and quit.
 * TODO 1302 adds the summary row ("Running N / Unread N") and the icon state (a dot while something runs, the Dock badge's number next to the icon).
 * TODO 1303 names the conversations under it (waiting for an approval, running, unread); choosing one opens that conversation.
 * TODO 1305 shows the next scheduled runs (absolute times, so the menu is not rebuilt as time passes); choosing one opens the schedule screen.
 * TODO 1304 adds "New Thread with Dictation" (a new empty conversation with recording started; only where dictation works).
 * TODO 1301 puts the recent working folders on top (choosing one starts a new conversation there), "Choose Folder…", and a "Recent Conversations" submenu.
 *
 * **The menu holds conversation titles. Never log the model or its signature.**
 */
import type { Locale } from '@shared/locale.js'
import { nativeFormat, nativeText } from '../i18n-native.js'
import type { TrayThreadRow } from '../session/badge.js'

export type { TrayThreadRow }

export type TrayAction =
  | 'show'
  | 'newThread'
  /** A new empty conversation with dictation started (the dictation hotkey's entry). */
  | 'dictate'
  | 'quit'
  /** Open that conversation (the window is brought forward). */
  | { readonly kind: 'openThread'; readonly threadId: string }
  /** A new conversation in that folder (an absolute path; main re-checks it like `aios://new?cwd=`). */
  | { readonly kind: 'newInFolder'; readonly path: string }
  /** Open the schedule screen on that job. */
  | { readonly kind: 'openSchedule'; readonly jobId: string }
  /** Ask for a folder with the OS dialog, then a new conversation there. */
  | 'pickFolder'

export type TrayMenuEntry =
  | {
      readonly kind: 'item'
      readonly id: string
      readonly label: string
      readonly enabled: boolean
      readonly action: TrayAction | null
      /** Shown at the right of the row as a hint only (the menu does not register it). */
      readonly accelerator?: string
    }
  | { readonly kind: 'submenu'; readonly id: string; readonly label: string; readonly items: readonly TrayMenuEntry[] }
  | { readonly kind: 'separator' }

/** How many running / unread conversations are named before "N more" (approvals are all named). */
export const TRAY_LIST_LIMIT = 10
/** How many working folders are listed, and how many recent conversations the submenu holds. */
export const TRAY_FOLDER_LIMIT = 8
export const TRAY_RECENT_LIMIT = 10
/** The longest a title is shown, in characters. */
export const TRAY_TITLE_LIMIT = 40

/** One upcoming scheduled run. `atMs` is epoch ms; `today` says whether it falls on the same calendar day as the moment the rows were picked. */
export interface TrayScheduleRow {
  readonly jobId: string
  /** The job's name. Shown in the menu only; never logged. */
  readonly name: string
  readonly atMs: number
  readonly today: boolean
}

/** How many of today's remaining runs are listed. */
export const TRAY_SCHEDULE_LIMIT = 3

/** The part of a scheduled job this needs (the scheduler's overview row satisfies it). */
export interface TrayJobSource {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly nextRunAt: number | null
  /** A plugin's idle task has no clock time worth showing. */
  readonly kind: string
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/**
 * Picks what the menu shows: the remaining runs of today, nearest first (at most 3); with none today, the next single run, with its date. Disabled jobs,
 * jobs with no next time, and plugin tasks are left out. A run that is already due today (catching up) still counts as today. Pure in `nowMs`.
 */
export function selectUpcomingJobs(jobs: readonly TrayJobSource[], nowMs: number): readonly TrayScheduleRow[] {
  const rows = jobs
    .filter((job): job is TrayJobSource & { readonly nextRunAt: number } => job.enabled && job.nextRunAt !== null && job.kind !== 'plugin')
    .map((job) => ({ jobId: job.id, name: job.name, atMs: job.nextRunAt, today: sameDay(job.nextRunAt, nowMs) }))
    .sort((a, b) => a.atMs - b.atMs)
  const today = rows.filter((row) => row.today)
  if (today.length > 0) return today.slice(0, TRAY_SCHEDULE_LIMIT)
  const next = rows.find((row) => row.atMs > nowMs)
  return next === undefined ? [] : [next]
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `15:30`, or `11/23 15:30` for a run that is not today (local time). */
export function formatRunTime(row: Pick<TrayScheduleRow, 'atMs' | 'today'>): string {
  const d = new Date(row.atMs)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return row.today ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** What the menu is built from. Every count is sanitized (a non-integer or negative value counts as none). */
export interface TrayMenuInput {
  readonly locale: Locale
  /** Pending approvals (the Dock badge's approval count). */
  readonly pending: number
  /** The Dock badge's number: unread conversations + pending approvals. Shown next to the icon. */
  readonly badge: number
  /** Conversations waiting for an approval (one row each, oldest request first). */
  readonly approvals: readonly TrayThreadRow[]
  /** Conversations that are running (not the ones waiting for an approval). */
  readonly running: readonly TrayThreadRow[]
  /** Conversations finished and not yet read (not running, not waiting). */
  readonly unread: readonly TrayThreadRow[]
  /** TODO 1305: the upcoming scheduled runs (already picked by `selectUpcomingJobs`). */
  readonly schedule: readonly TrayScheduleRow[]
  /** TODO 1304: whether to offer the dictation row (macOS and the speech helper is present). */
  readonly dictate: boolean
  /** TODO 1316: the dictation hotkey (Electron accelerator) while it is registered, shown beside the dictation row. null / absent = no hint. */
  readonly dictateKey?: string | null
  /** TODO 1301: recent working folders (absolute paths, most recently used first; the caller already dropped the ones that are gone or not allowed). */
  readonly folders: readonly string[]
  /** The home folder's path (shown as `~`). */
  readonly home: string
  /** TODO 1301: the most recently active conversations (newest first), for the "Recent Conversations" submenu. */
  readonly recent: readonly TrayThreadRow[]
}

function count(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0
}

/** One line, cut to `TRAY_TITLE_LIMIT` characters (by code point, so a surrogate pair is not split). */
/**
 * A user's string (a conversation title, a folder name, a job name) as a menu label. Electron's menu treats a lone `&` in a label as an
 * accelerator marker and removes it (macOS included: the native menu controller strips it), and `&&` shows one `&`. So every `&` is doubled.
 * Apply it after `clipTitle` (clipping must not cut a doubled pair in half) and only to user strings, not to the fixed menu texts.
 */
export function menuLabelText(text: string): string {
  return text.replace(/&/g, '&&')
}

export function clipTitle(title: string): string {
  const chars = [...title.replace(/\s+/g, ' ').trim()]
  return chars.length > TRAY_TITLE_LIMIT ? `${chars.slice(0, TRAY_TITLE_LIMIT).join('')}…` : chars.join('')
}

function lastSegment(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** The folder's display name: its last segment, `~` for the home folder. */
function folderName(path: string, home: string): string {
  return path === home ? '~' : lastSegment(path)
}

/**
 * The labels of the folder rows: the folder name, and where two share a name the parent's name is added (`app (work)`). Pure; the order is kept.
 */
export function folderLabels(paths: readonly string[], home: string): readonly string[] {
  const names = paths.map((path) => folderName(path, home))
  return paths.map((path, index) => {
    const name = names[index] ?? ''
    if (names.filter((other) => other === name).length < 2) return name
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/'
    return `${name} (${folderName(parent, home)})`
  })
}

export function trayMenuModel(input: TrayMenuInput): readonly TrayMenuEntry[] {
  const { locale } = input
  const pending = count(input.pending)
  const label = (key: 'tray.rowApproval' | 'tray.rowRunning' | 'tray.rowUnread', row: TrayThreadRow): string =>
    nativeFormat(locale, key, { title: menuLabelText(clipTitle(row.title)) || nativeText(locale, 'tray.untitled') })
  const rows = (
    key: 'tray.rowApproval' | 'tray.rowRunning' | 'tray.rowUnread',
    list: readonly TrayThreadRow[],
    limit: number
  ): TrayMenuEntry[] => {
    const entries: TrayMenuEntry[] = list.slice(0, limit).map((row) => ({
      kind: 'item',
      id: `${key}:${row.threadId}`,
      label: label(key, row),
      enabled: true,
      action: { kind: 'openThread', threadId: row.threadId }
    }))
    if (list.length > limit) {
      entries.push({ kind: 'item', id: `${key}:more`, label: nativeFormat(locale, 'tray.more', { count: list.length - limit }), enabled: true, action: 'show' })
    }
    return entries
  }

  const folders = input.folders.slice(0, TRAY_FOLDER_LIMIT)
  const labels = folderLabels(folders, input.home)
  const entries: TrayMenuEntry[] = [
    ...folders.map((path, index): TrayMenuEntry => ({
      kind: 'item',
      id: `folder:${index}`,
      label: menuLabelText(labels[index] ?? path),
      enabled: true,
      action: { kind: 'newInFolder', path }
    })),
    { kind: 'item', id: 'pickFolder', label: nativeText(locale, 'tray.pickFolder'), enabled: true, action: 'pickFolder' },
    ...(input.recent.length === 0
      ? []
      : [
          {
            kind: 'submenu' as const,
            id: 'recent',
            label: nativeText(locale, 'tray.recent'),
            items: input.recent.slice(0, TRAY_RECENT_LIMIT).map((row): TrayMenuEntry => ({
              kind: 'item',
              id: `recent:${row.threadId}`,
              label: menuLabelText(clipTitle(row.title)) || nativeText(locale, 'tray.untitled'),
              enabled: true,
              action: { kind: 'openThread', threadId: row.threadId }
            }))
          }
        ]),
    { kind: 'separator' },
    { kind: 'item', id: 'show', label: nativeText(locale, 'tray.show'), enabled: true, action: 'show' },
    { kind: 'item', id: 'newThread', label: nativeText(locale, 'tray.newThread'), enabled: true, action: 'newThread' },
    ...(input.dictate
      ? [
          {
            kind: 'item' as const,
            id: 'dictate',
            label: nativeText(locale, 'tray.dictate'),
            enabled: true,
            action: 'dictate' as const,
            ...(input.dictateKey ? { accelerator: input.dictateKey } : {})
          }
        ]
      : []),
    { kind: 'separator' },
    pending > 0
      ? { kind: 'item', id: 'pending', label: nativeFormat(locale, 'tray.pending', { count: pending }), enabled: true, action: 'show' }
      : { kind: 'item', id: 'pending', label: nativeText(locale, 'tray.pendingNone'), enabled: false, action: null },
    ...rows('tray.rowApproval', input.approvals, Number.MAX_SAFE_INTEGER)
  ]
  const named = input.approvals.length + input.running.length + input.unread.length
  if (input.running.length + input.unread.length > 0) {
    // With exactly one conversation named in all, the summary row goes straight to it; otherwise it only shows the window and the rows below name them.
    const only = [...input.approvals, ...input.running, ...input.unread][0]
    entries.push({
      kind: 'item',
      id: 'summary',
      label: nativeFormat(locale, 'tray.summary', { running: input.running.length, unread: input.unread.length }),
      enabled: true,
      action: named === 1 && only !== undefined ? { kind: 'openThread', threadId: only.threadId } : 'show'
    })
    entries.push(...rows('tray.rowRunning', input.running, TRAY_LIST_LIMIT), ...rows('tray.rowUnread', input.unread, TRAY_LIST_LIMIT))
  }
  if (input.schedule.length > 0) {
    entries.push(
      { kind: 'separator' },
      { kind: 'item', id: 'scheduleHeader', label: nativeText(locale, 'tray.scheduleHeader'), enabled: false, action: null },
      ...input.schedule.map((row): TrayMenuEntry => ({
        kind: 'item',
        id: `schedule:${row.jobId}`,
        label: `${formatRunTime(row)}  ${menuLabelText(clipTitle(row.name)) || nativeText(locale, 'tray.untitled')}`,
        enabled: true,
        action: { kind: 'openSchedule', jobId: row.jobId }
      }))
    )
  }
  entries.push({ kind: 'separator' }, { kind: 'item', id: 'quit', label: nativeText(locale, 'menu.quit'), enabled: true, action: 'quit' })
  return entries
}

/** The icon's look: a dot while something runs, the number (unread + pending approvals, as in the Dock badge) next to it. */
export interface TrayIconState {
  readonly running: boolean
  /** 0 means no number. */
  readonly badge: number
}

export function trayIconState(input: Pick<TrayMenuInput, 'badge' | 'running'>): TrayIconState {
  return { running: input.running.length > 0, badge: count(input.badge) }
}

/** One string that changes whenever the built menu would differ (so the tray rebuilds only then). Never log it: it holds titles. */
export function trayMenuSignature(input: TrayMenuInput): string {
  return JSON.stringify(trayMenuModel(input))
}

/** A menu with nothing in it (what `sync` is handed while the icon is off; it is not built then). */
export function emptyTrayMenu(locale: Locale): TrayMenuInput {
  return { locale, pending: 0, badge: 0, approvals: [], running: [], unread: [], schedule: [], dictate: false, folders: [], home: '', recent: [] }
}
