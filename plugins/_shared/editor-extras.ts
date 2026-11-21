/**
 * Three standard features added to the CodeMirror viewer (TODO 467, wave 23 bundle F, ARCHITECTURE.md 7.4.3.1).
 *
 * Three of the pieces of the official `basicSetup` that had been left out are brought in (owner decision 2026-10-04):
 *
 * 1. **Faint highlight of the same word + Cmd+D + multiple cursors** - `highlightSelectionMatches` and
 *    `EditorState.allowMultipleSelections`. Cmd+D (`selectNextOccurrence`) was already in `searchKeymap`,
 *    but multiple selections were not allowed, so they collapsed to one and had no effect (the same for Alt + drag rectangular selection).
 *    **Alt+click adds a cursor** (same as VS Code on mac; CodeMirror's default is Cmd+click) - `altPointerSelection`.
 * 2. **Folding** - `foldGutter` (the down / right chevrons to the right of the line numbers) and `foldKeymap` (Cmd+Alt+[ / ], and Ctrl+Alt+[ / ] for all).
 *    State is not remembered (everything is open again after reopening).
 * 3. **Symbols for invisible characters** - `highlightSpecialChars`. NBSP (U+00A0) and WORD JOINER (U+2060) are added to the default table (control characters,
 *    zero-width space, BOM, bidirectional controls). The full-width space (U+3000) is a legitimate character in Japanese, so it is not shown.
 *
 * Bracket auto-completion (`closeBrackets`) and input completion (`autocompletion`) are not included (editing in a viewer is mainly short fixes).
 * Colors come only from viewer.css variables (7.4.1).
 */
import { EditorSelection, EditorState, countColumn, findColumn, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view'
import { highlightSelectionMatches } from '@codemirror/search'
import { foldGutter, foldKeymap, foldedRanges, unfoldEffect } from '@codemirror/language'

/** Invisible characters added to the default table (NBSP / WORD JOINER). */
export const EXTRA_SPECIAL_CHARS = /[\u00a0\u2060]/

/** Selection length that starts the same-word highlight. With one character the whole body lights up and is noisy. */
export const SELECTION_MATCH_MIN_LENGTH = 2

/** Appearance of the three features (fold markers, the "..." for a folded region, invisible characters). Colors are viewer.css variables. */
const extrasTheme = EditorView.theme({
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 2px', color: 'var(--fg-dim)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--line)',
    color: 'var(--fg-dim)',
    borderRadius: '3px',
    padding: '0 4px',
    margin: '0 2px'
  },
  '.cm-specialChar': { color: 'var(--special-char-fg)' }
})

/**
 * Alt + left button (TODO 467). A plain press and release adds a cursor at that position (removes it if one is already there - same as VS Code),
 * and a drag makes a rectangular selection (instead of `rectangularSelection`; Alt + drag keeps working as before).
 * A mousedown in the line-number gutter (TODO 406's `gutterLineMouseDown`) is taken first by the gutter's handler, so it does not reach here.
 */
export function altPointerSelection(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (!event.altKey || event.button !== 0 || event.metaKey || event.ctrlKey) return null
    let start = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    let startSel = view.state.selection
    return {
      update(update) {
        if (!update.docChanged) return
        start = update.changes.mapPos(start)
        startSel = startSel.map(update.changes)
      },
      get(current) {
        const end = view.posAtCoords({ x: current.clientX, y: current.clientY }, false)
        return altSelection(view.state, startSel, start, end)
      }
    }
  })
}

/** The Alt + left button selection (pure function). If `start === end` it adds or removes a cursor, otherwise a rectangle. */
export function altSelection(state: EditorState, startSel: EditorSelection, start: number, end: number): EditorSelection {
  if (start === end) return toggleCursor(startSel, start)
  const ranges = rectangleRanges(state, start, end)
  return EditorSelection.create(ranges, ranges.length - 1)
}

/** Adds a cursor at `pos`. If an empty cursor is already there and other selections exist, removes it. */
export function toggleCursor(selection: EditorSelection, pos: number): EditorSelection {
  const at = selection.ranges.findIndex((range) => range.empty && range.head === pos)
  if (at >= 0 && selection.ranges.length > 1) {
    const ranges = selection.ranges.filter((_, i) => i !== at)
    const main = Math.min(selection.mainIndex > at ? selection.mainIndex - 1 : selection.mainIndex, ranges.length - 1)
    return EditorSelection.create(ranges, main)
  }
  if (at >= 0) return selection
  return selection.addRange(EditorSelection.cursor(pos))
}

/**
 * The per-line ranges of the rectangle with `a` and `b` as opposite corners (same rules as `rectangularSelection`). Columns are counted with tabs expanded, and
 * a line shorter than the left column gets a cursor at its line end. The main selection is `b` (the line where the pointer is).
 */
export function rectangleRanges(state: EditorState, a: number, b: number): EditorSelection['ranges'][number][] {
  const doc = state.doc
  const lineA = doc.lineAt(a)
  const lineB = doc.lineAt(b)
  const colA = countColumn(lineA.text, state.tabSize, a - lineA.from)
  const colB = countColumn(lineB.text, state.tabSize, b - lineB.from)
  const left = Math.min(colA, colB)
  const right = Math.max(colA, colB)
  const step = lineB.number >= lineA.number ? 1 : -1
  const ranges = []
  for (let n = lineA.number; ; n += step) {
    const line = doc.line(n)
    const from = findColumn(line.text, left, state.tabSize, true)
    if (from < 0) ranges.push(EditorSelection.cursor(line.to))
    else {
      const to = findColumn(line.text, right, state.tabSize)
      // Direction is from the pressed column to the pointer's column (dragging left puts the head on the left).
      ranges.push(colA <= colB ? EditorSelection.range(line.from + from, line.from + to) : EditorSelection.range(line.from + to, line.from + from))
    }
    if (n === lineB.number) break
  }
  return ranges
}

/**
 * The three features for an editable viewer (`createEditor`). Pushed instead of `rectangularSelection`
 * (`altPointerSelection` takes over the Alt + drag rectangular selection).
 */
export function editingExtras(): Extension {
  return [
    EditorState.allowMultipleSelections.of(true),
    altPointerSelection(),
    highlightSelectionMatches({ minSelectionLength: SELECTION_MATCH_MIN_LENGTH }),
    foldGutter(),
    keymap.of(foldKeymap),
    highlightSpecialChars({ addSpecialChars: EXTRA_SPECIAL_CHARS }),
    extrasTheme
  ]
}

/**
 * The share for a read-only viewer (the merge view of `aios.diff`). **Only same-word highlight and invisible characters** - multiple cursors are not needed
 * because nothing is edited, and folding would break the merge view's left / right line alignment (spacer) and "collapse unchanged lines", so it is left out.
 */
export function readOnlyExtras(): Extension {
  return [
    highlightSelectionMatches({ minSelectionLength: SELECTION_MATCH_MIN_LENGTH }),
    highlightSpecialChars({ addSpecialChars: EXTRA_SPECIAL_CHARS }),
    extrasTheme
  ]
}

/**
 * An effect that unfolds the folds hiding `from` to `to` (TODO 467). The hit box (431) and the first match of a body search do not move
 * the selection (item 97), so CodeMirror's "unfold when a fold covers the selection head" does not apply - unfold with this before centering.
 * Jumping to a line (273) and the symbol list (468) place the cursor, so CodeMirror unfolds by itself.
 * If the range is empty, only when the position is inside a fold (the edges are excluded - the characters at the edges are visible).
 */
export function unfoldEffectsAt(state: EditorState, from: number, to: number = from): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = []
  const hi = Math.max(from, to)
  foldedRanges(state).between(from, hi, (a, b) => {
    const covers = hi > from ? a < hi && b > from : a < from && b > from
    if (covers) effects.push(unfoldEffect.of({ from: a, to: b }))
  })
  return effects
}
