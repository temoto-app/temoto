/**
 * The pure part of the instruction to jump ViewerPane to a line (item 273, ARCHITECTURE.md 5.1 / 7.6.2).
 *
 * There are two sources: a link in the body (`foo.ts:42` / `#L42`, main's `fs.resolveLink` splits out the line) and
 * the gateway's `openFile` `line`. Both go through `store.select(uri, { line, column })`.
 *
 * - **One-shot.** `nonce` is a number that advances per instruction, and ViewerPane remembers the number it sent so it never sends twice.
 *   Pressing the same line again with the same file open jumps because the number differs. Resending
 *   `resource` on a theme / language change does not jump again (it is not put in `resource`; it is a separate message).
 * - **Not written to the memory (item 63)** (owner decision 2026-10-01). The memory's listener looks only at `selectedUri` and
 *   `highlightQuery`, so it structurally cannot be written. Switching threads and coming back starts from the top.
 * - Line / column accept only safe integers of 1 or more; anything else is "no line" (the file is still opened). Clamping to the
 *   body's range is done by the viewer (`revealPosition` in `plugins/_shared/editor.ts`).
 */
import type { ViewerHostMessage, ViewerScrollPosition } from '@shared/plugin.js'
import { acceptViewerPosition } from '@shared/viewer-position.js'

/**
 * The instruction to jump to a page (TODO 1009 stage 2, a PDF full-text search hit). The same one-shot shape as the line instruction,
 * going through the same store slot (`viewerLine`) and the same sending entry point (`revealMessageFor`).
 */
export interface ViewerPageRequest {
  readonly uri: string
  /** 1-based. Clamping to the range is done by the viewer. */
  readonly page: number
  /** A number that advances per instruction (from 1). */
  readonly nonce: number
}

/**
 * The instruction to return to the previously viewed position (TODO 1146). The viewer's back / forward (left/right arrows) passes the position previously viewed in the destination document
 * through `select(uri, { restore })`. The same one-shot shape as the line / page instructions, going through the same store slot (`viewerLine`) and the
 * same sending entry point (`revealMessageFor`). It puts no marker and does not move the cursor (it only shows where the user was).
 */
export interface ViewerRestoreRequest {
  readonly uri: string
  readonly position: ViewerScrollPosition
  /** A number that advances per instruction (from 1). */
  readonly nonce: number
}

/** A line, a page, or the previously viewed position (each is a one-shot "jump here"). */
export type ViewerRevealRequest = ViewerLineRequest | ViewerPageRequest | ViewerRestoreRequest

export interface ViewerLineRequest {
  /** The file the line points at. Sent only when it matches the file ViewerPane is currently handing to the viewer. */
  readonly uri: string
  readonly line: number
  readonly column: number | null
  /** A number that advances per instruction (from 1). */
  readonly nonce: number
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

/**
 * Builds the instruction from `select`'s arguments. null (no instruction) if `uri` is null or the line is missing / malformed.
 * If only the column is malformed, the column is dropped.
 */
export function viewerLineRequest(
  uri: string | null,
  options: { readonly line?: number | null; readonly column?: number | null } | undefined,
  nonce: number
): ViewerLineRequest | null {
  if (uri === null) return null
  const line = positive(options?.line)
  if (line === null) return null
  return { uri, line, column: positive(options?.column), nonce }
}

/** Builds the page instruction from `select`'s arguments. null if `uri` is null or the page is missing / malformed. */
export function viewerPageRequest(
  uri: string | null,
  options: { readonly page?: number | null } | undefined,
  nonce: number
): ViewerPageRequest | null {
  if (uri === null) return null
  const page = positive(options?.page)
  if (page === null) return null
  return { uri, page, nonce }
}

/** Builds the "to the previously viewed position" instruction from `select`'s arguments (TODO 1146). null if `uri` is null or the position is missing / malformed. */
export function viewerRestoreRequest(
  uri: string | null,
  options: { readonly restore?: ViewerScrollPosition | null } | undefined,
  nonce: number
): ViewerRestoreRequest | null {
  if (uri === null || options?.restore === undefined || options.restore === null) return null
  const position = acceptViewerPosition(options.restore)
  return position === null ? null : { uri, position, nonce }
}

/**
 * The "to this line / page" message that should be sent to the viewer now. null if there is no instruction, it was already sent (`sentNonce`), or the file the viewer
 * is drawing (`pushedUri`, where `resource` was sent) differs from the instruction's file.
 * The `pushedUri` match is the condition for not sending before `resource`.
 */
export function revealMessageFor(
  request: ViewerRevealRequest | null,
  pushedUri: string | null,
  sentNonce: number
): Extract<ViewerHostMessage, { type: 'reveal' | 'reveal-page' | 'restore-position' }> | null {
  if (request === null || request.nonce === sentNonce) return null
  if (pushedUri === null || pushedUri !== request.uri) return null
  if ('position' in request) return { type: 'restore-position', uri: request.uri, position: request.position }
  if ('page' in request) return { type: 'reveal-page', uri: request.uri, page: request.page }
  return {
    type: 'reveal',
    uri: request.uri,
    line: request.line,
    ...(request.column === null ? {} : { column: request.column })
  }
}

/**
 * The instruction to re-center on the search hit (TODO 446, wave 23 bundle G). Every press of a full-text search result sets it up with `select(uri, { highlight })`.
 * **When the same hit of the same file is pressed again**, the store's `selectedUri` / `highlightQuery` do not change and
 * ViewerPane's `samePush` does not send the same `resource`, so the viewer did not move (it could not return after looking elsewhere).
 * Like `reveal` (item 273), it is not put in `resource` but is a one-shot message (`recenter`), sent only once per number.
 * On receiving it the viewer re-applies the current search term (= makes the first match of the document the current match and centers it).
 * When another file is opened it is also centered by the `resource` search term, so it is centered twice, but at the same position, so it does no harm.
 */
export interface ViewerRecenterRequest {
  readonly uri: string
  /** A number that advances per instruction (from 1). */
  readonly nonce: number
}

/** Builds the instruction from `select`'s arguments. null if `uri` is null or the search term is empty. */
export function viewerRecenterRequest(
  uri: string | null,
  highlight: string,
  nonce: number
): ViewerRecenterRequest | null {
  if (uri === null || highlight === '') return null
  return { uri, nonce }
}

/**
 * The "re-center on the hit" that should be sent to the viewer now. The same conditions as `revealMessageFor`: null if there is no instruction, it was already sent, or
 * the file the viewer is drawing differs from the instruction's file (`resource` has not been sent yet).
 */
export function recenterMessageFor(
  request: ViewerRecenterRequest | null,
  pushedUri: string | null,
  sentNonce: number
): Extract<ViewerHostMessage, { type: 'recenter' }> | null {
  if (request === null || request.nonce === sentNonce) return null
  if (pushedUri === null || pushedUri !== request.uri) return null
  return { type: 'recenter', uri: request.uri }
}
