/**
 * @vitest-environment jsdom
 *
 * TODO 852: keep the line endings of an opened file (editing one spot in a CRLF file must not turn every line into LF). Does not call the model.
 */
import { describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditor } from '../plugins/_shared/editor.js'
import { applyEol, detectEol, normalizeEol } from '../plugins/_shared/eol.js'

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

describe('detectEol', () => {
  it('多い方に寄せる。無い・同数は LF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n')
    expect(detectEol('a\nb\nc')).toBe('\n')
    expect(detectEol('a\r\nb\nc\r\nd')).toBe('\r\n')
    expect(detectEol('a\r\nb\nc')).toBe('\n')
    expect(detectEol('a\rb\rc')).toBe('\r')
    expect(detectEol('abc')).toBe('\n')
  })
  it('normalize / apply は往復する', () => {
    expect(applyEol(normalizeEol('a\r\nb\r\n'), '\r\n')).toBe('a\r\nb\r\n')
  })
})

describe('createEditor の改行', () => {
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
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
    return { editor, view, changes }
  }

  it('CRLF のファイルを 1 文字直しても、host に返す値は CRLF のまま', () => {
    const { editor, view, changes } = make('a\r\nb\r\nc\r\n')
    expect(editor.getValue()).toBe('a\r\nb\r\nc\r\n')
    view.dispatch({ changes: { from: 0, insert: 'X' } })
    expect(changes.at(-1)).toBe('Xa\r\nb\r\nc\r\n')
    editor.destroy()
  })

  it('編集を全部戻した値は元の本文と一致する (未保存に見えない)', () => {
    const { editor, view, changes } = make('a\r\nb\r\n')
    view.dispatch({ changes: { from: 0, insert: 'X' } })
    view.dispatch({ changes: { from: 0, to: 1, insert: '' } })
    expect(changes.at(-1)).toBe('a\r\nb\r\n')
    editor.destroy()
  })

  it('setValue で別の改行のファイルに替えても追随する', () => {
    const { editor, view, changes } = make('a\nb\n')
    editor.setValue('x\r\ny\r\n')
    expect(editor.getValue()).toBe('x\r\ny\r\n')
    view.dispatch({ changes: { from: 0, insert: 'Z' } })
    expect(changes.at(-1)).toBe('Zx\r\ny\r\n')
    editor.destroy()
  })

  it('混在した本文を host が入れ直しても、dispatch も onChange も出さない', () => {
    const mixed = 'a\r\nb\r\nc\nd\r\n'
    const { editor, view, changes } = make(mixed)
    const before = view.state.doc
    editor.setValue(mixed)
    editor.setValue(editor.getValue())
    expect(view.state.doc).toBe(before)
    expect(changes).toEqual([])
    // When the text is replaced with a different body, a change pushed from the host is not reported through onChange
    editor.setValue('x\r\ny\r\n')
    expect(changes).toEqual([])
    editor.destroy()
  })
})
