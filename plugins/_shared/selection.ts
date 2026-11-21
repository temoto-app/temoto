/**
 * Turns the viewer's selection into the form reported to the host (item 97, ARCHITECTURE.md 7.4.5).
 *
 * Only pure functions that touch neither the DOM nor the port live here (`test/viewer-selection.test.ts` tests them directly).
 * Sending is the bridge (`reportSelection`); picking up selection changes is done by the editor and the Markdown preview.
 */
import type { Text } from '@codemirror/state'
import { MAX_SELECTION_TEXT, type ViewerSelectionRange } from '@shared/plugin.js'

/**
 * Cuts the body at the limit. It does not cut in the middle of a surrogate pair (a cut-off half would become U+FFFD at the destination).
 */
export function clipSelectionText(
  text: string,
  max = MAX_SELECTION_TEXT
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  let cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return { text: cut, truncated: true }
}

/**
 * Builds the reported form from a CodeMirror document and a selection (`from` / `to`, in either order). An empty selection
 * (only a cursor) or a whitespace-only selection gives null. Lines are 1-based and inclusive at both ends, and if the selection's end is exactly at
 * a line start (the shape of sweeping a whole line downward), that line is not included.
 */
export function selectionOf(doc: Text, a: number, b: number): ViewerSelectionRange | null {
  const from = Math.max(0, Math.min(a, b, doc.length))
  const to = Math.min(doc.length, Math.max(a, b))
  if (to <= from) return null
  const whole = doc.sliceString(from, to)
  if (whole.trim() === '') return null
  const fromLine = doc.lineAt(from).number
  const end = doc.lineAt(to)
  const toLine = end.from === to && end.number > fromLine ? end.number - 1 : end.number
  const clipped = clipSelectionText(whole)
  return { text: clipped.text, fromLine, toLine, truncated: clipped.truncated }
}

/** A selection without line information (a DOM selection in the Markdown preview). null if whitespace only. */
export function plainSelection(text: string): ViewerSelectionRange | null {
  if (text.trim() === '') return null
  const clipped = clipSelectionText(text)
  return { text: clipped.text, fromLine: null, toLine: null, truncated: clipped.truncated }
}

/**
 * Whether selections are the same (so as not to re-report). A drag changes the selection every frame, so
 * the same value is not kept flowing to the port.
 */
export function sameSelection(
  a: ViewerSelectionRange | null,
  b: ViewerSelectionRange | null
): boolean {
  if (a === null || b === null) return a === b
  return a.text === b.text && a.fromLine === b.fromLine && a.toLine === b.toLine
}
