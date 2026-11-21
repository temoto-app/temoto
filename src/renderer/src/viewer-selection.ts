/**
 * The pure part of attaching ViewerPane's selection to a send (item 97, ARCHITECTURE.md 4.5 / 7.4.5).
 * It touches neither the DOM nor the store, so `test/viewer-selection.test.ts` tests it directly.
 *
 * Flow: the viewer (iframe) sends "the selection changed" through the bridge -> ViewerPane validates it with
 * `acceptViewerSelection` and puts it in `useStore.viewerSelection` -> the Composer shows a chip with
 * `effectiveSelection` and attaches it to the send -> main re-validates the URI and embeds it in the body.
 * The selection's text is **saved nowhere** (only what was sent remains, as the user's message - constraints 9 / 10).
 */
import { MAX_SELECTION_TEXT, type ViewerSelectionRange } from '@shared/plugin.js'
import type { ViewerSelection } from '@shared/thread.js'
import { uriBasename } from '@shared/uri.js'

function isLine(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 1)
}

/**
 * Validates a selection that arrived from the viewer. The viewer is plugin code, so **its shape is not trusted**.
 * A URI different from the file being shown (a switch mismatch) is dropped. The body is re-cut to the limit.
 * A returned `undefined` means "ignore this message", and `null` means "no selection".
 */
export function acceptViewerSelection(
  message: { readonly uri?: unknown; readonly selection?: unknown },
  currentUri: string | null
): ViewerSelection | null | undefined {
  if (currentUri === null || message.uri !== currentUri) return undefined
  const raw = message.selection
  if (raw === null) return null
  if (typeof raw !== 'object' || raw === undefined) return undefined
  const record = raw as Record<string, unknown>
  const text = record['text']
  const fromLine = record['fromLine'] ?? null
  const toLine = record['toLine'] ?? null
  if (typeof text !== 'string' || !isLine(fromLine) || !isLine(toLine)) return undefined
  if ((fromLine === null) !== (toLine === null)) return undefined
  if (fromLine !== null && toLine !== null && toLine < fromLine) return undefined
  if (text.trim() === '') return null
  const over = text.length > MAX_SELECTION_TEXT
  return {
    uri: currentUri,
    text: over ? text.slice(0, MAX_SELECTION_TEXT) : text,
    fromLine,
    toLine,
    truncated: over || record['truncated'] === true
  }
}

/**
 * The key that tells whether it is the same selection. A selection removed with the close button or already sent is not attached until this key changes
 * (= the user selects again).
 */
export function selectionKey(selection: ViewerSelectionRange & { readonly uri: string }): string {
  return JSON.stringify([selection.uri, selection.fromLine, selection.toLine, selection.text])
}

/**
 * The selection the Composer attaches to a send. The selection restored from a reservation (`held`) comes first; if none,
 * the range currently selected in the viewer (`live`). If it equals the removed / sent key (`dismissed`), it is not attached.
 */
export function effectiveSelection(
  held: ViewerSelection | null | undefined,
  live: ViewerSelection | null,
  dismissed: string | null | undefined
): ViewerSelection | null {
  if (held !== null && held !== undefined) return held
  if (live === null) return null
  return dismissed === selectionKey(live) ? null : live
}

/** The chip's display (`main.ts 10–20`; a selection with no lines is just the name). The name is the end of the URI. */
export function selectionLabel(selection: ViewerSelection): string {
  const name = uriBasename(selection.uri)
  if (selection.fromLine === null || selection.toLine === null) return name
  return selection.fromLine === selection.toLine
    ? `${name}:${selection.fromLine}`
    : `${name}:${selection.fromLine}–${selection.toLine}`
}

/** The validated form of the `context-menu` the host receives (TODO 630). */
export interface ViewerContextMenuRequest {
  readonly uri: string
  readonly x: number
  readonly y: number
  readonly text: string
  /** Over a name, "Go to declaration" and "List assignments and uses" may be shown (TODO 692). Anything other than a boolean is false. */
  readonly codeNav: boolean
}

/**
 * Validates a `context-menu` that arrived from the viewer (TODO 630) (code review of wave 29). The viewer is plugin code, so
 * **its shape is not trusted** - as with other guest messages, check `typeof` and drop it unless it is addressed to the file being shown. Coordinates are accepted only as finite
 * numbers, and the body only as a string, re-cut at `MAX_SELECTION_TEXT` (do not rely on the plugin side's `clipSelectionText`).
 */
export function acceptViewerContextMenu(
  message: {
    readonly uri?: unknown
    readonly x?: unknown
    readonly y?: unknown
    readonly text?: unknown
    readonly codeNav?: unknown
  },
  drawnUri: string | null
): ViewerContextMenuRequest | null {
  if (drawnUri === null || typeof message.uri !== 'string' || message.uri !== drawnUri) return null
  const { x, y, text } = message
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return null
  if (typeof text !== 'string') return null
  return {
    uri: message.uri,
    x,
    y,
    text: text.length > MAX_SELECTION_TEXT ? text.slice(0, MAX_SELECTION_TEXT) : text,
    codeNav: message.codeNav === true
  }
}
