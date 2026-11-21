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

describe('複数カーソルと ⌘D (TODO 467 の 1)', () => {
  it('allowMultipleSelections が入り、⌘D (selectNextOccurrence) で同じ語の選択が 2 つになる', () => {
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

  it('複数カーソルでの入力は 1 回の変更として下書きに届く (TODO 312 の下書き・保存に乗る)', () => {
    const { view, changes, done } = make('a\nb\nc')
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3), EditorSelection.cursor(5)]) })
    view.dispatch(view.state.replaceSelection(';'))
    expect(changes).toEqual(['a;\nb;\nc;'])
    done()
  })

  it('同じ語の強調の拡張が入っている (選んだ語の他の出現に .cm-selectionMatch)', () => {
    const { view, host, done } = make('alpha beta alpha')
    view.dispatch({ selection: EditorSelection.single(0, 5) })
    // ViewPlugin decorations are attached when redrawn. Even in jsdom the class appears in the DOM.
    expect(host.querySelectorAll('.cm-selectionMatch').length).toBeGreaterThanOrEqual(1)
    done()
  })
})

describe('⌥クリックと ⌥ + drag (altSelection)', () => {
  const state = EditorState.create({ doc: 'abcdef\nab\nabcdef', extensions: EditorState.allowMultipleSelections.of(true) })

  it('押して離しただけならカーソルを足し、同じ所をもう一度なら消す (VS Code と同じ)', () => {
    const one = EditorSelection.single(1)
    const two = altSelection(state, one, 4, 4)
    expect(two.ranges.map((r) => r.head)).toEqual([1, 4])
    expect(two.main.head).toBe(4)
    const back = toggleCursor(two, 4)
    expect(back.ranges.map((r) => r.head)).toEqual([1])
    // The last one is not removed.
    expect(toggleCursor(back, 1).ranges.map((r) => r.head)).toEqual([1])
  })

  it('drag は矩形で置き換える。短い行は行末のカーソル、主選択は pointer の行', () => {
    // Column 2 of line 1 (before c) to column 4 of line 3 (before e). Line 2 "ab" ends at column 2, so the cursor goes to the end of that line.
    const sel = altSelection(state, EditorSelection.single(0), 2, 7 + 3 + 4)
    expect(sel.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [2, 4],
      [9, 9],
      [12, 14]
    ])
    expect(sel.mainIndex).toBe(2)
  })

  it('上へ・左へ drag しても列の範囲は同じで、head が pointer の側', () => {
    const ranges = rectangleRanges(state, 7 + 3 + 4, 2)
    expect(ranges.map((r) => [r.anchor, r.head])).toEqual([
      [14, 12],
      [9, 9],
      [4, 2]
    ])
  })
})

describe('折り畳み (TODO 467 の 2)', () => {
  it('折り畳みの欄が描かれ、畳んだ中の位置だけを開く effect を返す (端の字は見えているので開かない)', () => {
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

  it('本文検索の最初の一致が畳んだ中なら、開いてから中央に寄せる (431 / 467)', () => {
    const { editor, view, done } = make('top {\n  needle\n}\nend')
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 15 }) })
    expect(foldedRanges(view.state).size).toBe(1)
    editor.setHighlight('needle')
    expect(foldedRanges(view.state).size).toBe(0)
    done()
  })

  it('行へのジャンプ (273) はカーソルを置くので、CodeMirror が畳みを開く', () => {
    const { editor, view, done } = make('top {\n  needle\n}\nend')
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 15 }) })
    editor.revealLine(2, 3)
    expect(foldedRanges(view.state).size).toBe(0)
    done()
  })
})

describe('見えない文字の記号 (TODO 467 の 3)', () => {
  it('ゼロ幅空白と NBSP は .cm-specialChar になり、全角空白はならない', () => {
    const { host, done } = make('a​b c　d')
    expect(host.querySelectorAll('.cm-specialChar')).toHaveLength(2)
    done()
  })
})
