/**
 * @vitest-environment jsdom
 *
 * TODO 1112: when switching to another file, empty the undo history (so that ⌘Z does not put the body of the previous file into the draft).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { createEditor, type Editor } from '../plugins/_shared/editor.js'

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

// Always destroy an editor made in a test at the end of the test. The asynchronous language loading (`loadLanguage`) calls `view.dispatch` after the test environment has been torn down, and it fails because `requestAnimationFrame` is missing (the Errors 2 of `npm run check`).
const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

function make(value: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const changes: string[] = []
  const editor = createEditor(host, {
    value,
    filename: 'a.txt',
    readOnly: false,
    theme: 'light',
    onChange: (next) => changes.push(next)
  })
  editors.push(editor)
  const view = EditorView.findFromDOM(host)!
  return { editor, view, changes }
}

describe('setValue の履歴', () => {
  it('resetHistory なしでは前の本文へ undo で戻る (同じファイルの読み直し)', () => {
    const { editor, view, changes } = make('FILE A')
    editor.setValue('FILE B')
    undo(view)
    expect(view.state.doc.toString()).toBe('FILE A')
    expect(changes).toEqual(['FILE A'])
  })
  it('resetHistory ありでは戻らず onChange も出ない', () => {
    const { editor, view, changes } = make('FILE A')
    editor.setValue('FILE B', { resetHistory: true })
    undo(view)
    expect(view.state.doc.toString()).toBe('FILE B')
    expect(changes).toEqual([])
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input' })
    expect(changes).toEqual(['xFILE B'])
    undo(view)
    expect(view.state.doc.toString()).toBe('FILE B')
  })
  it('resetHistory ありなら同じ内容の別のファイルへ切り替えても前の履歴が残らない', () => {
    const { editor, view } = make('SAME')
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input' })
    editor.setValue('xSAME', { resetHistory: true })
    undo(view)
    expect(view.state.doc.toString()).toBe('xSAME')
  })
})
