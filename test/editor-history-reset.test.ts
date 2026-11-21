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

describe('history of setValue', () => {
  it('without resetHistory, undo goes back to the previous body (a reload of the same file)', () => {
    const { editor, view, changes } = make('FILE A')
    editor.setValue('FILE B')
    undo(view)
    expect(view.state.doc.toString()).toBe('FILE A')
    expect(changes).toEqual(['FILE A'])
  })
  it('with resetHistory, it does not go back and onChange is not issued', () => {
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
  it('with resetHistory, even switching to a different file with the same content leaves no previous history', () => {
    const { editor, view } = make('SAME')
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input' })
    editor.setValue('xSAME', { resetHistory: true })
    undo(view)
    expect(view.state.doc.toString()).toBe('xSAME')
  })
})
