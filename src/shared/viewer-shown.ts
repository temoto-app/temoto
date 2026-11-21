/**
 * TODO 1061 (3): a report of **what the window's ViewerPane is showing in front right now** (renderer -> main, ARCHITECTURE 7.6.2).
 *
 * Material for the gateway's `listOpenFiles` to mark "shown" (`shown` / `inView`) so that "explain the page open on the right" can be solved with
 * `listOpenFiles` -> `getOpenUrlText`. The renderer sends it only when what is in front changes (not high frequency). Main only remembers the last one
 * per window (`webContents.id`), and **does not use it for choke point decisions** (whether a file may be read is checked separately by main with `FsAccess.assertAllowed`).
 * It is a value from the renderer, so its shape is re-validated with `parseViewerShownReport` (item 86).
 *
 * - `file`: a file viewer (`uri` is a URI such as `file://…`).
 * - `web`: Web view (`uri` is the current URL, `about:blank` for an empty tab). Which tab it is is decided by main's tab state (the previous tab).
 * - `entry` of `file` (TODO 1094): transient view of a file inside an archive (`aios.zip`). `uri` is the archive and `entry` is the path inside it (a file name is not body text, so no consent is needed).
 * - `diff`: a transient view (such as the diff of item 104) is on top of the file viewer. `uri` is null.
 * - `none`: the ViewerPane is closed.
 *
 * TODO 1061 part 2: only for `file`, optionally add "where the viewer says it is looking now". `page` (PDF, 1-based) and `selection`
 * (the selection in text and the like; the text is cut at `MAX_SHOWN_SELECTION_TEXT`). This is display state without body text, so the consent of 1052 is not needed.
 */
import { MAX_TRANSIENT_FILE_NAME } from './plugin.js'

export type ViewerShownKind = 'file' | 'web' | 'diff' | 'none'

/** The selection of "where it is looking now" (TODO 1061 part 2). The character count goes up to `MAX_SHOWN_SELECTION_TEXT`. */
export interface ViewerShownSelection {
  readonly text: string
  readonly fromLine: number | null
  readonly toLine: number | null
  readonly truncated: boolean
}

/** Upper bound (characters) on the selection text passed to the AI. Kept smaller than for attachments (`MAX_SELECTION_TEXT`). */
export const MAX_SHOWN_SELECTION_TEXT = 4000
/** Upper bound on the page (only clamps to a safe integer range). */
export const MAX_SHOWN_PAGE = 1_000_000
/** Upper bound on the length of a path inside an archive. The same constant as the renderer's `MAX_TRANSIENT_FILE_NAME` (if they diverge, main silently drops it). */
export const MAX_SHOWN_ENTRY = MAX_TRANSIENT_FILE_NAME

export interface ViewerShownReport {
  /** The conversation the window is showing now. If it disagrees with the window's displayed thread (`ThreadViews`), main treats the report as stale and does not use it. */
  readonly threadId: string
  readonly kind: ViewerShownKind
  readonly uri: string | null
  /** Transient view of a file inside an archive (TODO 1094). Only for `file`. `uri` is the archive and this is the path inside it. */
  readonly entry?: string
  /** The current PDF page (1-based). Only for `file`. */
  readonly page?: number
  /** The current selection. For `file` and `diff` (item 2 of TODO 1091, the selection in a transient diff). */
  readonly selection?: ViewerShownSelection
}

const KINDS: ReadonlySet<string> = new Set<ViewerShownKind>(['file', 'web', 'diff', 'none'])

/** Upper bound on the conversation id length (comfortably longer than a UUID). */
const MAX_THREAD_ID = 200
/** Upper bound on the URI length. */
export const MAX_VIEWER_SHOWN_URI = 8192

/** Validate a value from the renderer. null if the shape is wrong (treated the same as knowing nothing). */
export function parseViewerShownReport(raw: unknown): ViewerShownReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const threadId = record['threadId']
  const kind = record['kind']
  const uri = record['uri']
  if (typeof threadId !== 'string' || threadId === '' || threadId.length > MAX_THREAD_ID) return null
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  const shownKind = kind as ViewerShownKind
  if (shownKind === 'none') return { threadId, kind: shownKind, uri: null }
  if (shownKind === 'diff') {
    const diffSelection = parseShownSelection(record['selection'])
    return { threadId, kind: shownKind, uri: null, ...(diffSelection === null ? {} : { selection: diffSelection }) }
  }
  if (typeof uri !== 'string' || uri === '' || uri.length > MAX_VIEWER_SHOWN_URI || uri.includes('\0')) return null
  if (shownKind !== 'file') return { threadId, kind: shownKind, uri }
  const page = record['page']
  const entry = record['entry']
  if (typeof entry === 'string' && entry !== '' && entry.length <= MAX_SHOWN_ENTRY && !entry.includes('\0')) {
    // Transient view of a file inside an archive: the page and selection belong to the archive's viewer, so they are not included.
    return { threadId, kind: shownKind, uri, entry }
  }
  const selection = parseShownSelection(record['selection'])
  return {
    threadId,
    kind: shownKind,
    uri,
    ...(typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 && page <= MAX_SHOWN_PAGE ? { page } : {}),
    ...(selection === null ? {} : { selection })
  }
}

function isLineOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
}

/** Validate a selection (null = none if the shape is wrong). The text is cut again at the limit. */
export function parseShownSelection(raw: unknown): ViewerShownSelection | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const text = record['text']
  const fromLine = record['fromLine'] ?? null
  const toLine = record['toLine'] ?? null
  if (typeof text !== 'string' || text.trim() === '' || !isLineOrNull(fromLine) || !isLineOrNull(toLine)) return null
  if ((fromLine === null) !== (toLine === null) || (fromLine !== null && toLine !== null && toLine < fromLine)) return null
  return clipShownSelection({ text, fromLine, toLine, truncated: record['truncated'] === true })
}

/** Cut the text at the limit, and set `truncated` if it was cut. */
export function clipShownSelection(sel: ViewerShownSelection): ViewerShownSelection {
  const over = sel.text.length > MAX_SHOWN_SELECTION_TEXT
  return {
    text: over ? sel.text.slice(0, MAX_SHOWN_SELECTION_TEXT) : sel.text,
    fromLine: sel.fromLine,
    toLine: sel.toLine,
    truncated: sel.truncated || over
  }
}

/** Whether two reports are the same (so the renderer does not resend the same value). */
export function sameViewerShown(a: ViewerShownReport | null, b: ViewerShownReport | null): boolean {
  if (a === null || b === null) return a === b
  if (a.threadId !== b.threadId || a.kind !== b.kind || a.uri !== b.uri || a.page !== b.page || a.entry !== b.entry) return false
  const x = a.selection
  const y = b.selection
  if (x === undefined || y === undefined) return x === y
  return x.text === y.text && x.fromLine === y.fromLine && x.toLine === y.toLine && x.truncated === y.truncated
}
