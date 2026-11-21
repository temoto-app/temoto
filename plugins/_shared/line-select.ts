/**
 * Clicking / dragging / shift+clicking in the line-number column (gutter) selects body lines (TODO 406, wave 21 bundle B).
 *
 * Same as VS Code:
 *  - clicking a line number = selects that whole line (up to its newline; the caret goes to the start of the next line)
 *  - dragging over line numbers = extends the selection line by line from the pressed line (extending upward makes the end of the pressed line the anchor)
 *  - shift + click = extends from the current selection's anchor to the pressed line (to the line end if downward, the line start if upward)
 *
 * Range computation is in the pure functions here (they look only at `Text`). Handling of the DOM (mousedown -> mousemove -> mouseup) is
 * plugged into `lineNumbers({ domEventHandlers })` by `gutterLineMouseDown`. Selecting works even in read-only mode because it does not
 * change the body (copying is possible too).
 */
import { EditorSelection, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface LineSelection {
  readonly anchor: number
  readonly head: number
}

/** The "end" of the line containing `pos`: the start of the next line (after the newline). For the last line, the end of the body. */
export function lineEndWithBreak(doc: Text, pos: number): number {
  const line = doc.lineAt(clamp(doc, pos))
  return line.number < doc.lines ? line.to + 1 : line.to
}

function clamp(doc: Text, pos: number): number {
  return Math.min(Math.max(0, Math.trunc(pos)), doc.length)
}

/**
 * Selects, line by line, from the line whose number was pressed (the line containing `originPos`) to the line where the pointer is now (the line containing `targetPos`).
 * For the same line, that whole line. Extending downward makes the anchor the start of the pressed line, and extending upward makes it the end of the pressed line.
 */
export function lineDragSelection(doc: Text, originPos: number, targetPos: number): LineSelection {
  const origin = doc.lineAt(clamp(doc, originPos))
  const target = doc.lineAt(clamp(doc, targetPos))
  if (target.number >= origin.number) return { anchor: origin.from, head: lineEndWithBreak(doc, target.from) }
  return { anchor: lineEndWithBreak(doc, origin.from), head: target.from }
}

/**
 * shift + click on a line number: the anchor (the current selection's anchor) stays and the selection extends to the pressed line.
 * If the pressed line is the anchor's line or below it, to the line end; if above, to the line start.
 */
export function shiftLineSelection(doc: Text, anchor: number, targetPos: number): LineSelection {
  const from = clamp(doc, anchor)
  const anchorLine = doc.lineAt(from)
  const target = doc.lineAt(clamp(doc, targetPos))
  const head = target.number >= anchorLine.number ? lineEndWithBreak(doc, target.from) : target.from
  return { anchor: from, head }
}

/** Window vertical coordinate -> the start of the line at that height. Above / below the body gives the first / last line. */
function lineAtClientY(view: EditorView, clientY: number): number {
  return view.lineBlockAtHeight(clientY - view.documentTop).from
}

/**
 * The handler passed to `lineNumbers({ domEventHandlers: { mousedown } })`. Handles only the left button and returns true
 * (CodeMirror then calls `preventDefault`, so the gutter digits are not selected as DOM text).
 */
export function gutterLineMouseDown(view: EditorView, lineFrom: number, event: MouseEvent): boolean {
  if (event.button !== 0) return false
  const doc = view.state.doc
  // With shift, the anchor stays at the current selection. The same anchor is used when extending by drag.
  const shiftAnchor = event.shiftKey ? view.state.selection.main.anchor : null
  const select = (targetPos: number): void => {
    const range =
      shiftAnchor === null ? lineDragSelection(doc, lineFrom, targetPos) : shiftLineSelection(doc, shiftAnchor, targetPos)
    const current = view.state.selection.main
    if (current.anchor === range.anchor && current.head === range.head) return
    view.dispatch({
      selection: EditorSelection.single(range.anchor, range.head),
      scrollIntoView: true,
      userEvent: 'select.pointer'
    })
  }
  select(lineFrom)
  view.focus()

  const owner = view.dom.ownerDocument
  const onMove = (move: MouseEvent): void => {
    // If the body was replaced (the host re-sent the contents during a drag), stop extending.
    if (view.state.doc !== doc) {
      stop()
      return
    }
    if ((move.buttons & 1) === 0) {
      stop()
      return
    }
    move.preventDefault()
    select(lineAtClientY(view, move.clientY))
  }
  const stop = (): void => {
    owner.removeEventListener('mousemove', onMove, true)
    owner.removeEventListener('mouseup', stop, true)
  }
  owner.addEventListener('mousemove', onMove, true)
  owner.addEventListener('mouseup', stop, true)
  return true
}
