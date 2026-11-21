/**
 * Turns files dropped onto the viewer into Markdown links (TODO 366, wave 20 bundle E, ARCHITECTURE 7.4.8).
 *
 * Path: the host (ViewerPane) receives the drop, turns it into URIs with the preload's `drop.uriFor`, and main's `drop.checkLinks` returns only
 * those that passed the choke point (`FsAccess.assertAllowed`, read). The host turns them into a string with `dropLinkText` here and passes it to the viewer
 * with `insert-text` of `ViewerHostMessage`. The viewer only inserts the string.
 *
 * The shape of the string (owner decision 2026-10-03): for an image, ![name](file:///absolute-path), otherwise [name](file:///absolute-path).
 * Several go one per line. The name is the file name with extension. **With TODO 407 (2026-10-04), everything except `aios.markdown` is a raw full path**
 * (`dropInsertFormat`).
 *
 * A pure function that depends on neither the DOM nor Node (the renderer, main and tests use the same one).
 */

/** Upper limit on the number of URIs `drop.checkLinks` accepts. The excess is not looked at (enough for the number dropped at once). */
export const MAX_DROP_LINKS = 64

/** One item that passed the choke point. `uri` is the `file://` URI main rebuilt from the logical path. */
export interface DropLinkTarget {
  readonly uri: string
  readonly isDirectory: boolean
}

/** One refused item. `reason` is a reason-code string (`shared/reason.ts`), which the renderer turns into wording with `describeReason`. */
export interface DropLinkDenial {
  readonly uri: string
  readonly reason: string
}

/** The result of `drop.checkLinks`. The order is the order passed in. */
export interface DropLinkCheck {
  readonly allowed: readonly DropLinkTarget[]
  readonly denied: readonly DropLinkDenial[]
}

/**
 * Extensions made into `![]()` as images. The extensions of the `aios.image` manifest plus the forms often used in Markdown previews
 * (`ico` / `heic` / `tif`). Lowercase, without a dot.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'ico',
  'heic',
  'heif',
  'tif',
  'tiff'
])

/** Whether the name's extension (lowercase) is an image one. A name that is only a leading dot, like `.png`, has no extension. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Turns an absolute path into a `file://` URL that can be put in a Markdown link destination. `encodeURI` encodes whitespace, non-ASCII and `%`,
 * and `#` `?` (which would act as URL separators) and `(` `)` (which would close the Markdown link destination), which it leaves, are encoded too.
 */
export function markdownFileUrl(path: string): string {
  const encoded = encodeURI(path).replace(/[#?()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `file://${encoded}`
}

/** Escapes `\` `[` `]`, which have meaning in link text (inside `[…]`). Newlines are folded into spaces (so that one line per item holds). */
export function escapeLinkText(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').replace(/[\\[\]]/g, (ch) => `\\${ch}`)
}

/** `file://` URI -> absolute path (decodes `%xx`). Null if it does not start with `file://`. */
export function filePathOfUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  const rest = uri.slice('file://'.length).split(/[?#]/, 1)[0] ?? ''
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

/** One link. Null for a URI with no obtainable path. A folder gets no `/` after its name (the destination alone makes it clear). */
export function markdownLinkFor(target: DropLinkTarget): string | null {
  const path = filePathOfUri(target.uri)
  if (path === null || !path.startsWith('/')) return null
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const name = trimmed === '/' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const image = !target.isDirectory && isImageName(name)
  return `${image ? '!' : ''}[${escapeLinkText(name)}](${markdownFileUrl(trimmed)})`
}

/** The string to insert. One item per line, with no newline after the last line. An empty string if empty. */
export function dropLinkText(targets: readonly DropLinkTarget[]): string {
  return dropInsertText(targets, 'markdown-link')
}

/**
 * The format of the inserted string (TODO 407, wave 21 bundle B, owner decision 2026-10-04).
 *  - `markdown-link`: the Source (`.md`) of `aios.markdown`. As in 366, ![name](file:///…) / [name](file:///…)
 *  - `path`: other viewers that accept editing (`aios.text` and so on). A **raw full path**, with neither quotes nor escaping
 */
export type DropInsertFormat = 'markdown-link' | 'path'

/**
 * The format per plugin (the host's table). Only `aios.markdown` gets a Markdown link, and an unknown plugin gets a
 * plain path (which can be put in any document, the most straightforward form).
 */
export function dropInsertFormat(pluginId: string): DropInsertFormat {
  return pluginId === 'aios.markdown' ? 'markdown-link' : 'path'
}

/**
 * One plain path. The logical path restored from the URI main rebuilt (not the renderer's spelling). A folder is also left as it is
 * (no trailing `/`). Null for a URI with no obtainable path.
 */
export function plainPathFor(target: DropLinkTarget): string | null {
  const path = filePathOfUri(target.uri)
  if (path === null || !path.startsWith('/')) return null
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** The string to insert, following the format. One item per line, with no newline after the last line. An empty string if empty. */
export function dropInsertText(targets: readonly DropLinkTarget[], format: DropInsertFormat): string {
  const lines: string[] = []
  for (const target of targets) {
    const line = format === 'path' ? plainPathFor(target) : markdownLinkFor(target)
    if (line !== null) lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Log of the viewer's drop path (TODO 407). To isolate the cause of "nothing happens" on a real drop from Finder (OOPIF hit-testing /
 * `drag-files` not arriving / `getPathForFile` returning empty), the renderer reports each stage to main, and main makes it a
 * `viewer.drop.<stage>` line. **Neither paths nor names are included**, only counts and success/failure.
 *  - `drag-seen`: the overlay was shown (`source` = the window's dragenter / the viewer's `drag-files`)
 *  - `overlay-dragover` (TODO 429): the host (the overlay or `.viewer-body`) received a dragover. Only the first time per drag.
 *    `target`, and the `dropEffect` / `effectAllowed` at that moment
 *  - `overlay-drop`: the host received a drop (`target` = the overlay / the `.viewer-body` after the overlay vanished, 429)
 *  - `guest-drop`: the overlay was not in time and the viewer (iframe) received the drop and sent the `File` back with `drop-files`
 *    (`cloneFailed` = the viewer could not structured-clone the `File` and sent only the count, 429)
 *  - `guest-drop-skipped` (TODO 429): `drop-files` was received but dropped. `reason` = `not-enabled` / `stale` / `not-array`
 *  - `end` (TODO 429): the overlay was removed. `reason` = the caller (`drop` / `dragend` / `leave` / `idle` / `pointer` /
 *    `guest-drop` / `disabled`). Only once while the overlay is shown (the watchdog while it is off is not written)
 *  - `insert`: `insert-text` was sent / could not be sent to the viewer
 *  - `pane-dragover` (TODO 489): the conversation pane (the attachment target, `pane-drop.ts`) received a dragover. Only the first time per drag.
 *    The `dropEffect` / `effectAllowed` at that moment. main makes it a `drop.pane-dragover` line without the `viewer.` prefix
 *  - `pane-drop` (TODO 489): the conversation pane received a drop (`files` / `uris` / `emptyPaths`). Whether the attachment succeeded is in main's `attach.*` lines
 * The result of `drop.checkLinks` (the number passed and the number refused) is written by main itself as `viewer.drop.check`.
 */
export type DropTraceStage =
  | 'drag-seen'
  | 'overlay-dragover'
  | 'overlay-drop'
  | 'guest-drop'
  | 'guest-drop-skipped'
  | 'end'
  | 'insert'
  | 'pane-dragover'
  | 'pane-drop'
export const DROP_TRACE_STAGES: readonly DropTraceStage[] = [
  'drag-seen',
  'overlay-dragover',
  'overlay-drop',
  'guest-drop',
  'guest-drop-skipped',
  'end',
  'insert',
  'pane-dragover',
  'pane-drop'
]

/**
 * Names of the log lines (TODO 489). A viewer stage is `viewer.drop.<stage>`, a conversation pane stage is `drop.<stage>`
 * (`drop.pane-dragover` / `drop.pane-drop`).
 */
export function dropTraceEventName(stage: DropTraceStage): string {
  return stage.startsWith('pane-') ? `drop.${stage}` : `viewer.drop.${stage}`
}

/** The caller that removed the overlay (TODO 429). */
export type DropEndReason = 'drop' | 'dragend' | 'leave' | 'idle' | 'pointer' | 'guest-drop' | 'disabled'
/** The reason a `drop-files` was dropped (TODO 429). */
export type DropSkipReason = 'not-enabled' | 'stale' | 'not-array'
export const DROP_TRACE_REASONS: readonly (DropEndReason | DropSkipReason)[] = [
  'drop',
  'dragend',
  'leave',
  'idle',
  'pointer',
  'guest-drop',
  'disabled',
  'not-enabled',
  'stale',
  'not-array'
]
/** The element on which the host received the drag (TODO 429). `body` is the `.viewer-body` at the moment the overlay was gone. */
export type DropTraceTarget = 'overlay' | 'body'
/** The possible values of `DataTransfer.dropEffect` / `effectAllowed` (the HTML spec). Anything else is not put in the log. */
export const DROP_EFFECTS: readonly string[] = ['none', 'copy', 'link', 'move']
export const EFFECTS_ALLOWED: readonly string[] = [
  'none',
  'copy',
  'copyLink',
  'copyMove',
  'link',
  'linkMove',
  'move',
  'all',
  'uninitialized'
]

export interface DropTrace {
  readonly stage: DropTraceStage
  readonly source?: 'window' | 'guest'
  /** The count of `dataTransfer.files`. */
  readonly files?: number
  /** The number that could be made into URIs (`uriFor` + `text/uri-list`). */
  readonly uris?: number
  /** The number of `File`s for which `uriFor` (`webUtils.getPathForFile`) returned empty. */
  readonly emptyPaths?: number
  /** The number of lines inserted. */
  readonly lines?: number
  readonly format?: DropInsertFormat
  /** Whether `insert-text` could be sent to the viewer (no port, or the display changed, is false). */
  readonly sent?: boolean
  /** The caller of `end` / the reason of `guest-drop-skipped` (TODO 429). */
  readonly reason?: DropEndReason | DropSkipReason
  /** The element that received the drag (TODO 429). */
  readonly target?: DropTraceTarget
  readonly dropEffect?: string
  readonly effectAllowed?: string
  /** The viewer could not structured-clone the `File` and sent only the count (TODO 429). */
  readonly cloneFailed?: boolean
  /**
   * How the drop was handled (TODO 563). The left half of the conversation pane is `attach`, the right half and the viewer's "open" are `open`,
   * and insertion into a viewer being edited is `insert`.
   */
  readonly action?: DropAction
}

/** How a drop is handled (TODO 563). */
export type DropAction = 'attach' | 'open' | 'insert'
export const DROP_ACTIONS: readonly DropAction[] = ['attach', 'open', 'insert']

const TRACE_COUNTS = ['files', 'uris', 'emptyPaths', 'lines'] as const

/** Re-validates a value that came from the renderer (main side). Null if the shape is wrong. Only integers from 0 to 10000 pass for counts. */
export function sanitizeDropTrace(input: unknown): DropTrace | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const stage = record.stage
  if (typeof stage !== 'string' || !(DROP_TRACE_STAGES as readonly string[]).includes(stage)) return null
  const out: { -readonly [K in keyof DropTrace]: DropTrace[K] } = { stage: stage as DropTraceStage }
  if (record.source === 'window' || record.source === 'guest') out.source = record.source
  for (const key of TRACE_COUNTS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000) out[key] = value
  }
  if (record.format === 'markdown-link' || record.format === 'path') out.format = record.format
  if (typeof record.sent === 'boolean') out.sent = record.sent
  if (typeof record.reason === 'string' && (DROP_TRACE_REASONS as readonly string[]).includes(record.reason)) {
    out.reason = record.reason as DropEndReason | DropSkipReason
  }
  if (record.target === 'overlay' || record.target === 'body') out.target = record.target
  if (typeof record.dropEffect === 'string' && DROP_EFFECTS.includes(record.dropEffect)) out.dropEffect = record.dropEffect
  if (typeof record.effectAllowed === 'string' && EFFECTS_ALLOWED.includes(record.effectAllowed)) {
    out.effectAllowed = record.effectAllowed
  }
  if (typeof record.cloneFailed === 'boolean') out.cloneFailed = record.cloneFailed
  if (typeof record.action === 'string' && (DROP_ACTIONS as readonly string[]).includes(record.action)) {
    out.action = record.action as DropAction
  }
  return out
}
