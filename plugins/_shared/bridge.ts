/**
 * Bridge between the viewer (sandboxed iframe) and the ViewerPane (host) (ARCHITECTURE.md 5.2 / 7.8).
 *
 * **The viewer does no I/O at all.** The host reads the contents and pushes them in here;
 * the viewer only hands edits back through `reportDraft`. Saving is called by the host.
 * Thanks to this shape, the Phase 1 viewer implementations could be moved onto the Broker almost
 * unchanged (the contract 5.2 laid down for Phase 4).
 *
 * The only channel is **one MessageChannel port**. The iframe has
 * `sandbox="allow-scripts"`, so it gets an opaque origin and the peer cannot be verified with
 * the `postMessage` targetOrigin. The host hands over exactly one port right after load, and all
 * further talk happens over that port only.
 *
 * The display language (7.4.4) arrives in the same message as a **name only**. On receipt this
 * rewrites the current language in `i18n.ts`, and each viewer looks up its strings with `vt()`.
 *
 * The color theme (7.4.1) also arrives in the same message. On receipt it is written to
 * `<html data-theme>`, and `viewer.css` switches its variables on that.
 * **Never read the parent's DOM or CSS** (constraint 8) - it is a different origin so it cannot be
 * read anyway, but we do not build anything that could read it either.
 *
 * App shortcuts (item 189) are also caught here. When the iframe (OOPIF) has focus, the parent's
 * `keydown` never fires, so keys matching the table the host passed (`ViewerHostMessage.shortcuts`)
 * are stopped in the **capture phase** (before CodeMirror's keymap) and `{ type: 'shortcut', id }`
 * is sent back over the port. Keys the viewer uses itself (the editor's Cmd+F) are removed from the
 * table by the host before it is passed, so no distinction is made here.
 */
import type {
  CodeNavAction,
  DiffLayout,
  DiffSide,
  ViewerGuestMessage,
  ViewerHostMessage,
  ViewerPayload,
  ViewerScrollPosition,
  ViewerSelectionRange,
  ViewerShortcut,
  ViewerWirePayload
} from '@shared/plugin.js'
import type { Theme } from '@shared/theme.js'
import type { Locale } from '@shared/locale.js'
import { setViewerLocale } from './i18n.js'
import { clipSelectionText, sameSelection } from './selection.js'
import { matchViewerMouseButton, matchViewerShortcut } from './shortcuts.js'
import { VIEWER_ASCII_INPUT_SELECTOR } from '@shared/ascii-input.js'
import { isViewerKeybindingCommandId, type ViewerKeybindingCommandId } from '@shared/keybindings.js'
import { acceptSetViewMode, type ViewerViewMode } from '@shared/viewer-view-mode.js'
import { acceptViewerPosition, samePosition } from '@shared/viewer-position.js'

/**
 * Throttle interval for selection reports (ms, item 97). A selection changes every frame during
 * a drag, so it is sent once, after it settles. A human always takes at least 150 ms before
 * pressing the send button.
 */
export const SELECTION_REPORT_DELAY_MS = 150

export interface ViewerResourceEvent {
  readonly uri: string
  /** Display name. **Not an absolute path** (the convention of chapter 7). */
  readonly label: string
  readonly resource: ViewerPayload
  readonly editable: boolean
  readonly theme: Theme
  /** Name of the display language (7.4.4). Strings are looked up by `vt()`, so a viewer rarely reads this directly. */
  readonly locale: Locale
  /** Query for in-file search (TODO 56). Set only when the file was opened through a search hit. */
  readonly highlightQuery: string | null
  /**
   * Version of the contents (items 309-2 / 303). Does not change on a re-send. null if the host does not set it.
   * Whether to replace the body is decided by `planResource` in `resource-update.ts`.
   */
  readonly revision: number | null
  /**
   * Unsaved draft the host remembered (TODO 312, wave 18 bundle B). If present it is shown in the editor instead of the body.
   * `resource.text` stays the on-disk contents. null if there is none.
   */
  readonly draft: string | null
  /**
   * Keys for the commands inside the viewer's editor (TODO 692, go to declaration / list assignments and uses). null if the host does not supply them (default keys).
   * Unknown commands and non-string values have been dropped (`acceptEditorKeys`).
   */
  readonly editorKeys: Readonly<Partial<Record<ViewerKeybindingCommandId, string>>> | null
}

/** Maximum length of a key string (same as `parseKeybinding`). */
const MAX_KEY_TEXT = 64

/**
 * Validates the host's `editorKeys` (TODO 692). null if it is not an object (default keys). Unknown commands, non-strings and
 * values that are too long are dropped. An unreadable key string ends up empty when the viewer opens it into a CodeMirror key (`codeMirrorKeysOf`).
 */
export function acceptEditorKeys(raw: unknown): Readonly<Partial<Record<ViewerKeybindingCommandId, string>>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Partial<Record<ViewerKeybindingCommandId, string>> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isViewerKeybindingCommandId(id) || typeof value !== 'string' || value.length > MAX_KEY_TEXT) continue
    out[id] = value
  }
  return out
}

/** The host's "go to declaration / list assignments and uses" (TODO 692, from the context menu). */
export function acceptCodeNav(
  message: { readonly uri?: unknown; readonly action?: unknown },
  currentUri: string | null
): CodeNavAction | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  return message.action === 'declaration' || message.action === 'references' ? message.action : null
}

/** Context-menu probe (TODO 692). The viewer passes it through `setContextMenuProbe`. */
export type ContextMenuProbe = (event: MouseEvent) => { readonly codeNav: boolean; readonly keepSelection: boolean }

/** The "go to this line" instruction (item 273). Line / column are 1-based; `column` is null when absent. */
export interface ViewerRevealEvent {
  readonly uri: string
  readonly line: number
  readonly column: number | null
}

/**
 * Validates the host's "go to this line" (item 273). Returns null (dropped) if it names a file other than the one the viewer is showing (`currentUri`) or
 * the line is not a safe integer >= 1. If only the column is broken, only the column is dropped.
 */
export function acceptReveal(
  message: { readonly uri: unknown; readonly line: unknown; readonly column?: unknown },
  currentUri: string | null
): ViewerRevealEvent | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  const line = message.line
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return null
  const column = message.column
  const validColumn = typeof column === 'number' && Number.isSafeInteger(column) && column >= 1
  return { uri: message.uri, line, column: validColumn ? column : null }
}

/** The "go to this page" instruction (TODO 1009 stage 2, PDF). Pages are 1-based. */
export interface ViewerRevealPageEvent {
  readonly uri: string
  readonly page: number
}

/**
 * Validates the host's "go to this page". Returns null (dropped) if it names a file other than the one the viewer is showing or the page is not a safe integer >= 1.
 * Clamping to the valid range is the viewer's job (it knows the page count).
 */
export function acceptRevealPage(
  message: { readonly uri: unknown; readonly page: unknown },
  currentUri: string | null
): ViewerRevealPageEvent | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  const page = message.page
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) return null
  return { uri: message.uri, page }
}

/** The host's "restore the position you were viewing before" (TODO 1146). */
export interface ViewerRestorePositionEvent {
  readonly uri: string
  readonly position: ViewerScrollPosition
}

/**
 * Validates the host's "restore the position you were viewing before" (TODO 1146). Returns null (dropped) if it names a file other than the one the viewer is showing or the position is unreadable.
 * Clamping to the valid range is the viewer's job (it knows the line / page count).
 */
export function acceptRestorePosition(
  message: { readonly uri: unknown; readonly position: unknown },
  currentUri: string | null
): ViewerRestorePositionEvent | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  const position = acceptViewerPosition(message.position)
  return position === null ? null : { uri: message.uri, position }
}

/**
 * Throttle interval for view-position reports (ms, TODO 1146). Scrolling fires every frame, so it is sent once, after it settles.
 * The host throttles a further 300 ms after receiving it before writing to main (`ViewerHistoryWriter`).
 */
export const POSITION_REPORT_DELAY_MS = 200

export interface PositionReporter {
  /** The current position. `uri` is the file the position belongs to. */
  report(uri: string, position: ViewerScrollPosition): void
  /** Sends the pending report immediately (before switching to another file). */
  flush(): void
}

/**
 * Throttling of view-position reports (TODO 1146). Consecutive reports for the same file send only the last one after `delayMs`, and
 * **when a report for a different file arrives, the pending one for the previous file is sent immediately** (so the previous file's final position
 * is not lost - that is where Back returns to). Nothing is sent if it equals the last value sent for that file.
 */
export function createPositionReporter(
  send: (message: ViewerGuestMessage) => void,
  timers: {
    readonly set: (fn: () => void, ms: number) => unknown
    readonly clear: (handle: unknown) => void
  } = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  delayMs = POSITION_REPORT_DELAY_MS
): PositionReporter {
  let pending: { uri: string; position: ViewerScrollPosition } | null = null
  let timer: unknown = null
  const sent = new Map<string, ViewerScrollPosition>()
  const flush = (): void => {
    if (timer !== null) timers.clear(timer)
    timer = null
    const next = pending
    pending = null
    if (next === null || samePosition(sent.get(next.uri), next.position)) return
    sent.set(next.uri, next.position)
    send({ type: 'scroll-position', uri: next.uri, position: next.position })
  }
  return {
    report(uri, position) {
      if (pending !== null && pending.uri !== uri) flush()
      pending = { uri, position }
      if (timer !== null) timers.clear(timer)
      timer = timers.set(flush, delayMs)
    },
    flush
  }
}

/** The host's "insert at the cursor" (TODO 366 / 407). 407 removed the coordinates (the insertion point is the caret). */
export interface ViewerInsertEvent {
  readonly uri: string
  readonly text: string
}

/** Upper limit (characters) on a string inserted at once. A dropped link list is about 64 entries x path length, so this is plenty. */
export const MAX_INSERT_TEXT = 256 * 1024

/**
 * Validates the host's "insert at the cursor" (TODO 366 / 407). Returns null if it names a file other than the one shown or the string is empty or too long.
 */
export function acceptInsert(
  message: { readonly uri: unknown; readonly text: unknown },
  currentUri: string | null
): ViewerInsertEvent | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  const text = message.text
  if (typeof text !== 'string' || text === '' || text.length > MAX_INSERT_TEXT) return null
  return { uri: message.uri, text }
}

/** Upper limit on the number of `File`s sent back by `drop-files` (64, same as the host's `MAX_DROP_LINKS`). */
export const MAX_DROP_FILES = 64

/** Whether the dragged thing is files (Finder) or a list of URIs (same check as `carriesFiles` in the renderer's `drop-uris.ts`). */
export function draggingFiles(types: readonly string[] | null | undefined): boolean {
  if (types === null || types === undefined) return false
  return types.includes('Files') || types.includes('text/uri-list')
}

/**
 * Sends a `File` dropped inside the iframe back to the host (TODO 407 / 429). **Sends even when there are 0 `File`s** (`count` is the number seen) -
 * so the host's log can tell whether the viewer saw the drop. If structured-cloning the `File` fails (`postMessage` throws
 * `DataCloneError`), it re-sends only the count as `files: []` + `cloneFailed: true`. Neither name nor path is included
 * (the host can only resolve a path from a `File` - the `getPathForFile` choke point is unchanged).
 */
export function sendDroppedFiles(send: (message: ViewerGuestMessage) => void, files: readonly unknown[]): void {
  const picked = files.slice(0, MAX_DROP_FILES)
  try {
    send({ type: 'drop-files', files: picked, count: files.length })
  } catch {
    send({ type: 'drop-files', files: [], count: files.length, cloneFailed: true })
  }
}

/** Lower bound (ms) on the interval for re-sending `drag-files`. dragover fires every few tens of ms, so it is throttled. */
export const DRAG_NOTICE_INTERVAL_MS = 250

export interface ViewerBridge {
  onResource(handler: (event: ViewerResourceEvent) => void): void
  /**
   * The host's "insert at this position" (TODO 366, a link to a file dropped onto the viewer). Only messages addressed to the displayed
   * file arrive. A viewer that does not accept edits does nothing.
   */
  onInsertText(handler: (event: ViewerInsertEvent) => void): void
  /**
   * The host's "go to this line" (item 273). **One-shot** - called only once when it arrives. Only messages addressed to the displayed file
   * (the `uri` of the preceding `onResource`) arrive.
   */
  onReveal(handler: (event: ViewerRevealEvent) => void): void
  /** The host's "go to this page" (TODO 1009 stage 2, a hit of PDF body search). One-shot like `onReveal`, and only for the displayed file. */
  onRevealPage(handler: (event: ViewerRevealPageEvent) => void): void
  /**
   * The host's "restore the position you were viewing before" (TODO 1146, the viewer's Back / Forward). One-shot like `onReveal`, and only for the displayed
   * file. The position is the value reported through `reportScrollPosition` (the viewer decides its `kind`). Clamping is the viewer's job.
   */
  onRestorePosition(handler: (event: ViewerRestorePositionEvent) => void): void
  /**
   * Tells the host the current viewing position (TODO 1146). May be called on every scroll (the bridge throttles to 200 ms and does not
   * re-send the same value). `uri` is the displayed file received in `onResource`. The host stores it in main together with the Back / Forward history, and when
   * Back / Forward returns to this file it answers with `onRestorePosition`. The line is `line`, the page is `page`, the scroll amount is `offset`.
   */
  reportScrollPosition(uri: string, position: ViewerScrollPosition): void
  /**
   * Returns the edited contents to the host. **Does not save** (the host does). `uri` is the file that body belongs to (the `uri` of `onResource`,
   * TODO 938). The host discards a draft whose URI differs from the `resource` it sent most recently.
   */
  reportDraft(uri: string, text: string): void
  /** Calls a command running in plugin-host (the `command` of 7.1). */
  runCommand(command: string, arg?: unknown): Promise<unknown>
  /**
   * **Asks** the host to open a URL in the external browser (5.1 "external links").
   * The viewer cannot reach the OS: the host forwards it over main's IPC, and main re-validates it,
   * narrowing it to `http:` / `https:` / `mailto:`. The iframe lacks `allow-popups`, so
   * `target="_blank"` / `window.open` do nothing.
   * `modifiers` are the click's modifier keys (TODO 400): for a plain click on `http(s)` the host shows it in the ViewerPane,
   * and with shift / Cmd it goes to the OS browser.
   */
  openExternal(
    url: string,
    modifiers?: { readonly shiftKey?: boolean; readonly metaKey?: boolean; readonly ctrlKey?: boolean }
  ): void
  /**
   * **Asks** the host to open a link in the body (relative, scheme-less or `file:`) (item 254). The viewer does not
   * resolve the path: the host passes it to main relative to the folder of the displayed file, and main checks the
   * choke point (`assertAllowed`) and that the target exists before opening it in the ViewerPane.
   */
  openLink(href: string): void
  /**
   * Tells the host the selection changed (item 97). `uri` is the displayed file received in `onResource`.
   * `null` means no selection. Throttled, and the same value is not re-sent.
   * The host keeps it as a candidate attachment for sending, and the AI can also read it as view state in `inView` of `listOpenFiles`
   * (cut at 4000 characters, passed through redaction, TODO 1061 part 2). It is neither saved nor indexed.
   */
  reportSelection(uri: string, selection: ViewerSelectionRange | null): void
  /**
   * Tells the host the page being viewed (1-based) (TODO 1061 part 2, `aios.pdf`). `uri` is the displayed file received in
   * `onResource`. The same value is not re-sent. The host uses it only for the "where it is displayed" part of the gateway's `listOpenFiles`, and does not save it.
   */
  reportPage(uri: string, page: number): void
  /**
   * **Asks** the host to open in the OS default app (TODO 405, `.avi` of `aios.video`). The viewer cannot
   * reach the OS: the host forwards it over main's IPC, and main opens it with
   * `shell.openPath` after passing `assertAllowed`. `uri` is the file the viewer is showing.
   */
  openDefaultApp(uri: string): void
  /**
   * **Asks** the host to open a file inside an archive (zip) as a temporary view (TODO 905, `aios.zip`). `data` is the contents the viewer
   * extracted, and is **passed by transfer** (after sending, this `data` is empty). `uri` is the displayed archive (the `uri` of `onResource`).
   */
  openEntry(uri: string, name: string, data: Uint8Array): void
  /**
   * **Asks** the host to show two texts as a diff in the temporary diff view (TODO 834 stage 1, `aios.git`). `uri` is the displayed URI (the `uri` of
   * `onResource`). The host re-checks shape and size (`MAX_GUEST_DIFF_CHARS` per side) and opens `aios.diff`; this viewer stays alive behind it.
   */
  openDiff(uri: string, before: DiffSide, after: DiffSide, layout?: DiffLayout): void
  /**
   * The host's "re-center on the search hit" (TODO 446). **One-shot**. Only messages addressed to the displayed file arrive. The viewer
   * re-applies the current query (`highlightQuery` of `onResource`) and centers the first match in the document.
   */
  onRecenter(handler: (event: ViewerRecenterEvent) => void): void
  /** The host's "open the symbol list" (TODO 468, the heading button). Only messages addressed to the displayed file arrive. */
  onOpenSymbols(handler: () => void): void
  /**
   * Tells the host whether the displayed file has a symbol list (TODO 468). The host shows or hides the heading button.
   * The symbols themselves are not sent.
   */
  reportSymbols(uri: string, available: boolean): void
  /**
   * Tells the host whether the current view accepts edits (drop insertion) (TODO 587). A viewer that switches between Source / Preview
   * calls this on every redraw. While it is `false`, the host turns a drop onto the viewer into "open". The same value is not re-sent.
   */
  reportAcceptsEdits(uri: string, accepts: boolean): void
  /** The host's "go to declaration / list assignments and uses" (TODO 692, chosen from the context menu). Only messages addressed to the displayed file arrive. */
  onCodeNav(handler: (action: CodeNavAction) => void): void
  /**
   * Entry point deciding on right-click whether the pointer is over a name (TODO 692). If true, it sends `context-menu` with `codeNav: true` even with no selection, and
   * the host puts "go to declaration" and "list assignments and uses" in the menu. If `keepSelection` is false, the selected text is not sent
   * (the viewer moved the cursor to the right-click position). A viewer that does not pass one behaves as before (only when there is a selection).
   */
  setContextMenuProbe(probe: ContextMenuProbe | null): void
  /**
   * Tells the host the selectable views and the current one (TODO 969, 7.4.12). The host shows a switch in the heading using the same component as the Composer's Model picker
   * (a plugin does not draw its own switch button). The values are exactly one set from the host's vocabulary (`ViewerViewMode`)
   * (Source / Preview, or the interpolation Nearest / Bilinear of TODO 1200). Call it on every redraw. If `modes` is empty, no switch is shown.
   */
  reportViewModes(uri: string, modes: readonly ViewerViewMode[], current: ViewerViewMode): void
  /**
   * The host's "switch to this view" (TODO 969, the heading switch). Addressed to the displayed file, and only values within the views last
   * reported for that file through `reportViewModes` arrive (TODO 1200).
   */
  onSetViewMode(handler: (mode: ViewerViewMode) => void): void
}

/** The host's "re-center on the search hit" (TODO 446). */
export interface ViewerRecenterEvent {
  readonly uri: string
}

/** Validates the host's "re-center on the search hit" (TODO 446). null (dropped) if it names a file other than the displayed one. */
export function acceptRecenter(message: { readonly uri: unknown }, currentUri: string | null): ViewerRecenterEvent | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  return { uri: message.uri }
}

/**
 * Right-click on selected text (TODO 630). null (do nothing, keep the default) if the selection is only whitespace or no file is
 * displayed. The body is cut only for overly large selections (`clipSelectionText`; reducing it to the first line that is actually used for
 * search is the host's job, `path-context-menu.ts`). A pure function independent of the DOM and the port
 * (just called from the `contextmenu` listener).
 */
export function contextMenuMessage(
  text: string,
  uri: string | null,
  x: number,
  y: number,
  codeNav = false
): ViewerGuestMessage | null {
  if (uri === null) return null
  // TODO 692: send even with no selection when over a name (the menu's "go to declaration" and "list assignments and uses").
  if (text.trim() === '') return codeNav ? { type: 'context-menu', uri, x, y, text: '', codeNav: true } : null
  return { type: 'context-menu', uri, x, y, text: clipSelectionText(text).text, ...(codeNav ? { codeNav: true } : {}) }
}

/**
 * Converts the contents on the port into the form handed to the viewer (TODO 905). `bytes` (the file of a temporary view) is turned into a `blob:` URL
 * inside the iframe and passed as `binary` - the viewer just reads `resourceUrl` as before. A `blob:` made by an opaque-origin document can be
 * read from the same document by fetch (including Range) / `<img>` / `<video>` (checked on Electron 44; workers only are not allowed - see the note in aios.pdf).
 * To avoid recreating the URL when the same contents are re-sent (theme / language), the previous URL is returned if `key` (uri + version + size) is the same.
 */
export function createBlobPayloads(
  urls: { create(blob: Blob): string; revoke(url: string): void } = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url)
  }
): (payload: ViewerWirePayload, key: string) => ViewerPayload {
  let current: { key: string; url: string } | null = null
  return (payload, key) => {
    if (payload.kind === 'bytes-ref') {
      // Re-send (theme / language): the previous URL if the contents are the same. Without the previous bytes it cannot be drawn.
      if (current !== null && current.key === key) return { kind: 'binary', resourceUrl: current.url, size: payload.size }
      return { kind: 'error', message: 'missing bytes' }
    }
    if (payload.kind !== 'bytes') {
      if (current !== null) {
        urls.revoke(current.url)
        current = null
      }
      return payload
    }
    if (current === null || current.key !== key) {
      if (current !== null) urls.revoke(current.url)
      const blob = new Blob([payload.data as Uint8Array<ArrayBuffer>], payload.mime === null ? {} : { type: payload.mime })
      current = { key, url: urls.create(blob) }
    }
    return { kind: 'binary', resourceUrl: current.url, size: payload.size }
  }
}

/** Copies the theme received from the host onto the iframe's own `<html>`. CSS looks at nothing else. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

export function connect(pluginId: string): ViewerBridge {
  // TODO 1119: CSP does not stop WebRTC. The bundled viewers do not use it, so remove it in this context (the main window's
  // `setWebRTCIPHandlingPolicy` is what stops it for the app itself; third-party viewers do not use this bridge, so that is the main line of defense).
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection'] as const) {
    try {
      delete (globalThis as Record<string, unknown>)[name]
    } catch {
      /* if it cannot be removed, leave it to the main window's policy */
    }
  }
  let port: MessagePort | null = null
  let handler: ((event: ViewerResourceEvent) => void) | null = null
  let revealHandler: ((event: ViewerRevealEvent) => void) | null = null
  let revealPageHandler: ((event: ViewerRevealPageEvent) => void) | null = null
  /** The host's "restore the position you were viewing before" (TODO 1146). */
  let restorePositionHandler: ((event: ViewerRestorePositionEvent) => void) | null = null
  let insertHandler: ((event: ViewerInsertEvent) => void) | null = null
  let recenterHandler: ((event: ViewerRecenterEvent) => void) | null = null
  /** The host's "open the symbol list" (TODO 468). */
  let openSymbolsHandler: (() => void) | null = null
  /** The host's "go to declaration / list assignments and uses" (TODO 692). */
  let codeNavHandler: ((action: CodeNavAction) => void) | null = null
  /** Context-menu probe (TODO 692). */
  let contextMenuProbe: ContextMenuProbe | null = null
  /** The host's "switch to this view" (TODO 969). */
  let setViewModeHandler: ((mode: ViewerViewMode) => void) | null = null
  /**
   * The views last reported with `view-modes` (TODO 1200). The host's `set-view-mode` only passes values within this. For a rejected choice,
   * this is sent again (wave 81 review Y: put the host's heading back to the viewer's current value).
   */
  let reportedModes: {
    readonly uri: string
    readonly modes: readonly ViewerViewMode[]
    readonly current: ViewerViewMode
  } | null = null
  /** Time `drag-files` was last sent (throttling). */
  let lastDragNotice = 0
  let last: ViewerResourceEvent | null = null
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const queued: ViewerGuestMessage[] = []
  /** The selection last reported (item 97). The same value is not re-sent. */
  let reportedUri = ''
  let reportedPageUri = ''
  let reportedPage = 0
  let reportedSelection: ViewerSelectionRange | null = null
  let selectionTimer: ReturnType<typeof setTimeout> | null = null
  /** The shortcut table received from the host (item 189). Nothing is caught until it arrives. */
  let shortcuts: readonly ViewerShortcut[] = []
  /** The last reported "accepts edits" (TODO 587). The same value is not re-sent. */
  let reportedAccepts: { readonly uri: string; readonly accepts: boolean } | null = null
  /** Turns the file contents of a temporary view into a `blob:` URL (TODO 905). */
  const toViewerPayload = createBlobPayloads()

  const send = (message: ViewerGuestMessage, transfer: Transferable[] = []): void => {
    if (port === null) queued.push(message)
    else port.postMessage(message, transfer)
  }
  /** Reporting of view positions (TODO 1146). */
  const positions = createPositionReporter(send)

  const onPortMessage = (event: MessageEvent): void => {
    const message = event.data as ViewerHostMessage
    if (message.type === 'resource') {
      // Before switching to another file, flush the previous file's final position (TODO 1146).
      if (message.uri !== last?.uri) positions.flush()
      applyTheme(message.theme)
      // The page report is re-sent for every new resource (the host discards the previous value on switching).
      reportedPageUri = ''
      shortcuts = message.shortcuts ?? []
      setViewerLocale(message.locale)
      document.documentElement.lang = message.locale
      last = {
        uri: message.uri,
        label: message.label,
        resource: toViewerPayload(
          message.resource,
          `${message.uri}\n${String(message.revision ?? '')}\n${message.resource.kind === 'bytes' || message.resource.kind === 'bytes-ref' ? message.resource.size : ''}`
        ),
        editable: message.editable,
        theme: message.theme,
        locale: message.locale,
        highlightQuery: message.highlightQuery ?? null,
        revision:
          typeof message.revision === 'number' && Number.isSafeInteger(message.revision) ? message.revision : null,
        draft: typeof message.draft === 'string' ? message.draft : null,
        editorKeys: acceptEditorKeys(message.editorKeys)
      }
      handler?.(last)
      return
    }
    if (message.type === 'reveal') {
      const reveal = acceptReveal(message, last?.uri ?? null)
      if (reveal !== null) revealHandler?.(reveal)
      return
    }
    if (message.type === 'reveal-page') {
      const reveal = acceptRevealPage(message, last?.uri ?? null)
      if (reveal !== null) revealPageHandler?.(reveal)
      return
    }
    if (message.type === 'restore-position') {
      const restore = acceptRestorePosition(message, last?.uri ?? null)
      if (restore !== null) restorePositionHandler?.(restore)
      return
    }
    if (message.type === 'insert-text') {
      const insert = acceptInsert(message, last?.uri ?? null)
      if (insert !== null) insertHandler?.(insert)
      return
    }
    // TODO 446: a one-shot instruction to re-center on the search hit.
    if (message.type === 'recenter') {
      const recenter = acceptRecenter(message, last?.uri ?? null)
      if (recenter !== null) recenterHandler?.(recenter)
      return
    }
    // Open the symbol list (TODO 468). Only for the displayed file.
    if (message.type === 'open-symbols') {
      if (typeof message.uri === 'string' && message.uri === last?.uri) openSymbolsHandler?.()
      return
    }
    // The context menu's "go to declaration / list assignments and uses" (TODO 692). Only for the displayed file.
    if (message.type === 'code-nav') {
      const action = acceptCodeNav(message, last?.uri ?? null)
      if (action !== null) codeNavHandler?.(action)
      return
    }
    // The heading's "view switch" (TODO 969). Only for the displayed file and only values in the vocabulary. TODO 1200 split the vocabulary into sets,
    // so only values within the views the viewer itself reported for that file are passed (so interpolation never reaches a Source / Preview viewer).
    if (message.type === 'set-view-mode') {
      const mode = acceptSetViewMode(message, last?.uri ?? null)
      const reported = reportedModes
      if (reported === null || reported.uri !== message.uri) return
      if (mode !== null && reported.modes.includes(mode) && setViewModeHandler !== null) {
        setViewModeHandler(mode)
        return
      }
      // A rejected choice (outside the vocabulary / set, a file that is not displayed, no handler). So the host's heading does not
      // keep pointing at the chosen value, re-send the views last reported for that file.
      send({ type: 'view-modes', uri: reported.uri, modes: [...reported.modes], current: reported.current })
      return
    }
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.type === 'command-result') waiter.resolve(message.result)
    else waiter.reject(new Error(message.message))
  }

  // Watch in the capture phase (item 189). CodeMirror takes keydown on the bubble of its own DOM,
  // so the window's capture runs first. A matching key is passed to neither the editor nor the default action.
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      const id = matchViewerShortcut(event, shortcuts)
      if (id === null) return
      event.preventDefault()
      event.stopPropagation()
      send({ type: 'shortcut', id })
    },
    true
  )

  // The mouse Back / Forward buttons (TODO 369). Pressed over the viewer they do not reach the parent document, so if the table has a row
  // (the host supplies it on mac), send it back. Both press and release stop the default action (history navigation).
  for (const type of ['mousedown', 'mouseup'] as const) {
    window.addEventListener(
      type,
      (event: MouseEvent) => {
        const id = matchViewerMouseButton(event.button, shortcuts)
        if (id === null) return
        event.preventDefault()
        if (type === 'mouseup') send({ type: 'shortcut', id })
      },
      true
    )
  }

  // File dragging (TODO 366). drag events over the iframe (OOPIF) do not reach the parent, so notice them here and tell
  // the host (the host puts a cover over the iframe, and the host receives later dragover / drop).
  // **Do not read files inside the iframe**: CodeMirror's default reads the file contents and inserts them, so stop it in the capture phase.
  // TODO 407: even with the cover shown, if the drag in progress keeps being delivered to the iframe (OOPIF hit testing), setting
  // dropEffect to `none` as in 366 means no drop happens and "nothing happens". So show `copy` to accept the drop and
  // send the dropped `File` straight back to the host (`drop-files`). Only the host (preload) knows the path; the viewer does not read it.
  const onDrag = (event: DragEvent): void => {
    if (!draggingFiles(event.dataTransfer?.types)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    if (event.type === 'drop') {
      // TODO 429: send even for 0 files (so the host's log records that "the viewer saw the drop"). On a clone failure only the count is sent.
      sendDroppedFiles(send, Array.from(event.dataTransfer?.files ?? []))
      return
    }
    const now = Date.now()
    if (now - lastDragNotice < DRAG_NOTICE_INTERVAL_MS) return
    lastDragNotice = now
    send({ type: 'drag-files' })
  }
  window.addEventListener('dragenter', onDrag, true)
  window.addEventListener('dragover', onDrag, true)
  window.addEventListener('drop', onDrag, true)

  // Right-click on selected text (TODO 630). With no selection, do nothing (keep the default, nothing is shown).
  // `window.getSelection()` reads both CodeMirror's rendering and the Markdown preview's DOM selection in the same way,
  // so there is no need to split the `onSelection` path per viewer. The body is cut only for overly large selections
  // (reducing it to the first line actually used for search is the host's job, `path-context-menu.ts`).
  window.addEventListener(
    'contextmenu',
    (event: MouseEvent) => {
      // Read the selected text before the probe (which may move the cursor).
      const selected = window.getSelection()?.toString() ?? ''
      const probe = contextMenuProbe?.(event) ?? { codeNav: false, keepSelection: true }
      const message = contextMenuMessage(
        probe.keepSelection ? selected : '',
        last?.uri ?? null,
        event.clientX,
        event.clientY,
        probe.codeNav
      )
      if (message === null) return
      event.preventDefault()
      send(message)
    },
    true
  )

  window.addEventListener('message', (event: MessageEvent) => {
    // TODO 574: validate the sender. It is an opaque origin so `event.origin` cannot be compared, but
    // only the parent (host) should be able to pass a port - check with `event.source` (window).
    if (event.source !== window.parent) return
    const incoming = event.ports[0]
    if (incoming === undefined || port !== null) return
    port = incoming
    port.onmessage = onPortMessage
    port.start()
    send({ type: 'ready', pluginId })
    for (const message of queued.splice(0)) port.postMessage(message)
  })

  // Tell the host about search-field focus (TODO 463).
  watchSearchFocus(window, send)

  return {
    onResource(next) {
      handler = next
      if (last !== null) next(last)
    },
    onReveal(next) {
      revealHandler = next
    },
    onRevealPage(next) {
      revealPageHandler = next
    },
    onRestorePosition(next) {
      restorePositionHandler = next
    },
    reportScrollPosition(uri, position) {
      positions.report(uri, position)
    },
    onInsertText(next) {
      insertHandler = next
    },
    reportDraft(uri, text) {
      send({ type: 'draft', uri, text })
    },
    runCommand(command, arg) {
      const id = String(nextId++)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ type: 'command', id, command, ...(arg === undefined ? {} : { arg }) })
      })
    },
    openExternal(url, modifiers) {
      send({
        type: 'open-external',
        url,
        shiftKey: modifiers?.shiftKey === true,
        metaKey: modifiers?.metaKey === true,
        ctrlKey: modifiers?.ctrlKey === true
      })
    },
    openLink(href) {
      send({ type: 'open-link', href })
    },
    reportSelection(uri, selection) {
      if (selectionTimer !== null) clearTimeout(selectionTimer)
      selectionTimer = setTimeout(() => {
        selectionTimer = null
        if (uri === reportedUri && sameSelection(selection, reportedSelection)) return
        reportedUri = uri
        reportedSelection = selection
        send({ type: 'selection', uri, selection })
      }, SELECTION_REPORT_DELAY_MS)
    },
    reportPage(uri, page) {
      if (uri === reportedPageUri && page === reportedPage) return
      reportedPageUri = uri
      reportedPage = page
      send({ type: 'page', uri, page })
    },
    openDefaultApp(uri) {
      send({ type: 'open-default-app', uri })
    },
    openEntry(uri, name, data) {
      // Pass contents up to 64 MB without copying (if the port is not connected yet, it is queued first and copied at that point).
      send({ type: 'open-entry', uri, name, data }, data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? [data.buffer as ArrayBuffer] : [])
    },
    openDiff(uri, before, after, layout) {
      send({ type: 'open-diff', uri, before, after, ...(layout === undefined ? {} : { layout }) })
    },
    onRecenter(next) {
      recenterHandler = next
    },
    onOpenSymbols(next) {
      openSymbolsHandler = next
    },
    reportSymbols(uri, available) {
      send({ type: 'symbols', uri, available })
    },
    onCodeNav(next) {
      codeNavHandler = next
    },
    setContextMenuProbe(probe) {
      contextMenuProbe = probe
    },
    reportAcceptsEdits(uri, accepts) {
      if (reportedAccepts !== null && reportedAccepts.uri === uri && reportedAccepts.accepts === accepts) return
      reportedAccepts = { uri, accepts }
      send({ type: 'accepts-edits', uri, accepts })
    },
    reportViewModes(uri, modes, current) {
      reportedModes = { uri, modes: [...modes], current }
      send({ type: 'view-modes', uri, modes: [...modes], current })
    },
    onSetViewMode(next) {
      setViewModeHandler = next
    }
  }
}

// ---------------------------------------------------------------------------
// Wave 23 bundle C (TODO 463): tell the host about focus of search fields inside the viewer
// ---------------------------------------------------------------------------

/** Whether it is a target search field (a marked field and the search-term field of CodeMirror's search panel). */
export function isViewerSearchField(target: EventTarget | null): boolean {
  // `instanceof Element` differs per document (realm), so check for the presence of `matches` instead.
  const element = target as { matches?: unknown } | null
  return typeof element?.matches === 'function' && (target as Element).matches(VIEWER_ASCII_INPUT_SELECTOR)
}

/**
 * Tells the host of focus / blur of a search field inside the iframe (such as the Cmd+F field) with `search-focus`. **Notification only** -
 * whether to switch the input source is decided by main via the host (renderer) (no capability is given to the plugin, constraint 8).
 * The same value is not re-sent. When the whole iframe loses focus (another app, a field in the parent), the field's blur also fires, so it becomes false.
 */
export function watchSearchFocus(win: Window, send: (message: ViewerGuestMessage) => void): void {
  let reported = false
  const report = (focused: boolean): void => {
    if (focused === reported) return
    reported = focused
    send({ type: 'search-focus', focused })
  }
  win.document.addEventListener('focusin', (event) => report(isViewerSearchField(event.target)), true)
  win.document.addEventListener(
    'focusout',
    (event) => {
      if (isViewerSearchField(event.target)) report(false)
    },
    true
  )
}
