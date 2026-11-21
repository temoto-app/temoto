/**
 * @vitest-environment jsdom
 *
 * TODO 406 (wave 21 bundle B): select lines of the body by clicking, dragging, or shift-clicking the line-number gutter (as in VS Code).
 *
 *  - Pure functions (`lineDragSelection` / `shiftLineSelection` / `lineEndWithBreak`): ranges by line
 *  - `gutterLineMouseDown` (the real CodeMirror, jsdom): a click selects the whole line, dragging (mousemove) extends it until mouseup,
 *    shift keeps the anchor, selection works even when read-only, and non-left buttons are left alone
 *  - the editor gutter has `user-select: none`
 *
 * jsdom does not lay out, so the lines for a drag are decided by replacing `lineBlockAtHeight`. Neither the model nor Electron is started.
 */
import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { gutterLineMouseDown, lineDragSelection, lineEndWithBreak, shiftLineSelection } from '../plugins/_shared/line-select.js'
import { createEditor } from '../plugins/_shared/editor.js'

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

// Line starts: 0 "aaa" / 4 "bbb" / 8 "ccc" / 12 "dd" (last line, no line break). The body length is 14.
const doc = Text.of(['aaa', 'bbb', 'ccc', 'dd'])

describe('行単位の範囲 (純関数)', () => {
  it('lineEndWithBreak: 次の行の頭。最終行は本文の末尾', () => {
    expect(lineEndWithBreak(doc, 0)).toBe(4)
    expect(lineEndWithBreak(doc, 6)).toBe(8)
    expect(lineEndWithBreak(doc, 12)).toBe(14)
    expect(lineEndWithBreak(doc, 99)).toBe(14)
  })

  it('lineDragSelection: 同じ行は行全体、下へは押した行の頭から、上へは押した行の終わりから', () => {
    expect(lineDragSelection(doc, 4, 4)).toEqual({ anchor: 4, head: 8 })
    expect(lineDragSelection(doc, 4, 9)).toEqual({ anchor: 4, head: 12 })
    expect(lineDragSelection(doc, 4, 13)).toEqual({ anchor: 4, head: 14 })
    expect(lineDragSelection(doc, 8, 1)).toEqual({ anchor: 12, head: 0 })
    // Round positions outside the range.
    expect(lineDragSelection(doc, -3, 500)).toEqual({ anchor: 0, head: 14 })
  })

  it('shiftLineSelection: anchor はそのまま、下 (同じ行を含む) は行の終わり、上は行の頭', () => {
    expect(shiftLineSelection(doc, 5, 9)).toEqual({ anchor: 5, head: 12 })
    expect(shiftLineSelection(doc, 5, 6)).toEqual({ anchor: 5, head: 8 })
    expect(shiftLineSelection(doc, 9, 1)).toEqual({ anchor: 9, head: 0 })
  })
})

describe('gutterLineMouseDown (実物の CodeMirror)', () => {
  function make(): { view: EditorView; host: HTMLElement } {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({ parent: host, doc: 'aaa\nbbb\nccc\ndd' })
    return { view, host }
  }
  const sel = (view: EditorView): { anchor: number; head: number } => ({
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head
  })

  it('クリックで行全体を選び、drag で行単位に伸ばし、mouseup の後は動かない', () => {
    const { view, host } = make()
    // y (px) → line start: 0-9 → 0, 10-19 → 4, 20-29 → 8, 30 and up → 12.
    view.lineBlockAtHeight = ((h: number) => ({ from: [0, 4, 8, 12][Math.min(3, Math.max(0, Math.floor(h / 10)))] })) as never
    Object.defineProperty(view, 'documentTop', { value: 0 })
    expect(gutterLineMouseDown(view, 4, mouse('mousedown', { button: 0 }))).toBe(true)
    expect(sel(view)).toEqual({ anchor: 4, head: 8 })
    document.dispatchEvent(mouse('mousemove', { buttons: 1, clientY: 35 }))
    expect(sel(view)).toEqual({ anchor: 4, head: 14 })
    document.dispatchEvent(mouse('mousemove', { buttons: 1, clientY: 2 }))
    expect(sel(view)).toEqual({ anchor: 8, head: 0 })
    document.dispatchEvent(mouse('mouseup', {}))
    document.dispatchEvent(mouse('mousemove', { buttons: 1, clientY: 25 }))
    expect(sel(view)).toEqual({ anchor: 8, head: 0 })
    view.destroy()
    host.remove()
  })

  it('shift + クリックは anchor を保って押した行まで伸ばす', () => {
    const { view, host } = make()
    view.dispatch({ selection: { anchor: 5 } })
    gutterLineMouseDown(view, 8, mouse('mousedown', { button: 0, shiftKey: true }))
    expect(sel(view)).toEqual({ anchor: 5, head: 12 })
    document.dispatchEvent(mouse('mouseup', {}))
    gutterLineMouseDown(view, 0, mouse('mousedown', { button: 0, shiftKey: true }))
    expect(sel(view)).toEqual({ anchor: 5, head: 0 })
    document.dispatchEvent(mouse('mouseup', {}))
    view.destroy()
    host.remove()
  })

  it('左ボタン以外は扱わない (false、選択は変えない)', () => {
    const { view, host } = make()
    expect(gutterLineMouseDown(view, 4, mouse('mousedown', { button: 2 }))).toBe(false)
    expect(sel(view)).toEqual({ anchor: 0, head: 0 })
    view.destroy()
    host.remove()
  })
})

describe('createEditor のガター', () => {
  it('読み取り専用でも行番号のクリックで行を選べる。ガターは user-select: none', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const selections: unknown[] = []
    const editor = createEditor(host, {
      value: 'one\ntwo\nthree',
      filename: 'a.txt',
      readOnly: true,
      theme: 'light',
      onChange: () => undefined,
      onSelection: (s) => selections.push(s)
    })
    const gutter = host.querySelector('.cm-lineNumbers') as HTMLElement
    expect(gutter).not.toBeNull()
    // jsdom does not lay out, so every height hits line 1.
    gutter.dispatchEvent(mouse('mousedown', { button: 0, clientY: 0 }))
    document.dispatchEvent(mouse('mouseup', {}))
    expect(selections.at(-1)).toMatchObject({ text: 'one\n' })
    expect(editor.getValue()).toBe('one\ntwo\nthree')
    const style = getComputedStyle(host.querySelector('.cm-gutters') as HTMLElement)
    expect(style.userSelect === 'none' || style.getPropertyValue('-webkit-user-select') === 'none').toBe(true)
    editor.destroy()
    host.remove()
  })
})

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, ...init })
}
