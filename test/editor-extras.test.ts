/**
 * @vitest-environment jsdom
 *
 * TODO 467 (wave 23 bundle F): the three standard features of the CodeMirror viewer (`plugins/_shared/editor-extras.ts`).
 *
 *  - Highlight of the same word + ⌘D + multiple cursors: `allowMultipleSelections` is on, and `selectNextOccurrence` (⌘D) makes two selections. An edit with multiple cursors reaches the draft (`onChange`) as one change (it builds on the TODO 312 draft)
 *  - ⌥ click (`altSelection` / `toggleCursor`) and the ⌥ + drag rectangle (`rectangleRanges`)
 *  - The fold gutter and markers are drawn. A match inside a folded region is unfolded before the hit is moved to (`unfoldEffectsAt`, item 431 is related)
 *  - Invisible characters (zero-width space, NBSP) become `.cm-specialChar`
 *
 * Depends on neither the model nor Electron.
 */
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { foldEffect, foldedRanges } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { createEditor } from '../plugins/_shared/editor.js'
import { altSelection, rectangleRanges, toggleCursor, unfoldEffectsAt } from '../plugins/_shared/editor-extras.js'

// jsdom's Range has no rectangles. Return an empty list so that CodeMirror's re-measure does not throw.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

function make(value: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const changes: string[] = []
  const editor = createEditor(host, {
    value,
    filename: 'doc.txt',
    readOnly: false,
    theme: 'light',
    onChange: (next) => changes.push(next)
  })
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
  const done = (): void => {
    editor.destroy()
    host.remove()
  }
  return { editor, view, host, changes, done }
}

describe('multiple cursors and Cmd+D (TODO 467 part 1)', () => {
  it('allowMultipleSelections is on, and Cmd+D (selectNextOccurrence) makes two selections of the same word', () => {
    const { view, done } = make('foo bar foo baz foo')
    expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(true)
    view.dispatch({ selection: EditorSelection.single(0, 3) })
    expect(selectNextOccurrence(view)).toBe(true)
    expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 3],
      [8, 11]
    ])
    done()
  })

  it('input with multiple cursors reaches the draft as one change (rides on the draft and saving of TODO 312)', () => {
    const { view, changes, done } = make('a\nb\nc')
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3), EditorSelection.cursor(5)]) })
    view.dispatch(view.state.replaceSelection(';'))
    expect(changes).toEqual(['a;\nb;\nc;'])
    done()
  })

  it('the extension that highlights the same word is on (.cm-selectionMatch on other occurrences of the selected word)', () => {
    const { view, host, done } = make('alpha beta alpha')
    view.dispatch({ selection: EditorSelection.single(0, 5) })
    // ViewPlugin decorations are attached when redrawn. Even in jsdom the class appears in the DOM.
    expect(host.querySelectorAll('.cm-selectionMatch').length).toBeGreaterThanOrEqual(1)
    done()
  })
})

describe('Option+click and Option+drag (altSelection)', () => {
  const state = EditorState.create({ doc: 'abcdef\nab\nabcdef', extensions: EditorState.allowMultipleSelections.of(true) })

  it('a plain press and release adds a cursor, and again at the same place removes it (same as VS Code)', () => {
    const one = EditorSelection.single(1)
    const two = altSelection(state, one, 4, 4)
    expect(two.ranges.map((r) => r.head)).toEqual([1, 4])
    expect(two.main.head).toBe(4)
    const back = toggleCursor(two, 4)
    expect(back.ranges.map((r) => r.head)).toEqual([1])
    // The last one is not removed.
    expect(toggleCursor(back, 1).ranges.map((r) => r.head)).toEqual([1])
  })

  it("drag replaces with a rectangle; a short line gets a cursor at the line end, and the main selection is on the pointer's line", () => {
    // Column 2 of line 1 (before c) to column 4 of line 3 (before e). Line 2 "ab" ends at column 2, so the cursor goes to the end of that line.
    const sel = altSelection(state, EditorSelection.single(0), 2, 7 + 3 + 4)
    expect(sel.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [2, 4],
      [9, 9],
      [12, 14]
    ])
    expect(sel.mainIndex).toBe(2)
  })

  it('dragging up or left gives the same column range, and head is on the pointer side', () => {
    const ranges = rectangleRanges(state, 7 + 3 + 4, 2)
    expect(ranges.map((r) => [r.anchor, r.head])).toEqual([
      [14, 12],
      [9, 9],
      [4, 2]
    ])
  })
})

describe('folding (TODO 467 part 2)', () => {
  it('the folding gutter is drawn, and returns an effect that opens only positions inside a fold (it does not open for an end character that is visible)', () => {
    const { view, host, done } = make('a {\n  b\n  c\n}\nd')
    expect(host.querySelector('.cm-foldGutter')).not.toBeNull()
    view.dispatch({ effects: foldEffect.of({ from: 3, to: 12 }) })
    expect(unfoldEffectsAt(view.state, 6)).toHaveLength(1)
    expect(unfoldEffectsAt(view.state, 3)).toHaveLength(0)
    expect(unfoldEffectsAt(view.state, 12)).toHaveLength(0)
    expect(unfoldEffectsAt(view.state, 0, 4)).toHaveLength(1)
    expect(unfoldEffectsAt(view.state, 13, 14)).toHaveLength(0)
    done()
  })

  it('when the first match of body search is inside a fold, opens it and then centers (431 / 467)', () => {
    const { editor, view, done } = make('top {\n  needle\n}\nend')
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 15 }) })
    expect(foldedRanges(view.state).size).toBe(1)
    editor.setHighlight('needle')
    expect(foldedRanges(view.state).size).toBe(0)
    done()
  })

  it('a jump to a line (273) puts the cursor, so CodeMirror opens the fold', () => {
    const { editor, view, done } = make('top {\n  needle\n}\nend')
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 15 }) })
    editor.revealLine(2, 3)
    expect(foldedRanges(view.state).size).toBe(0)
    done()
  })
})

describe('marks for invisible characters (TODO 467 part 3)', () => {
  it('zero-width space and NBSP become .cm-specialChar, and a full-width space does not', () => {
    const { host, done } = make('a​b c　d')
    expect(host.querySelectorAll('.cm-specialChar')).toHaveLength(2)
    done()
  })
})
