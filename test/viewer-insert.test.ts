/**
 * @vitest-environment jsdom
 *
 * TODO 366 (wave 20 bundle E) / 407 (wave 21 bundle B) on the viewer side: receives the host's `insert-text` and inserts the string at the **caret position**
 * (since 407, not from the 'dropped position'; coordinates are no longer carried).
 *
 *  - bridge (`acceptInsert`): drops a string for a file other than the one displayed, and empty or too long strings
 *  - bridge (`connect`): `insert-text` goes to `onInsertText` only for the file displayed. A file drag inside the iframe is stopped in the capture phase
 *    (so CodeMirror does not read the contents), and `drag-files` is sent to the host thinned out. If a drop lands inside the iframe because the overlay was not in time,
 *    the `File` is sent back as `drop-files` as it is (407)
 *  - editor (`insertText`, the real CodeMirror in jsdom): inserts at the caret and does not replace the selection. The caret goes after the inserted text; read-only is refused
 *
 * Neither the model nor Electron is started.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ViewerGuestMessage, ViewerHostMessage } from '../src/shared/plugin.js'
import {
  DRAG_NOTICE_INTERVAL_MS,
  MAX_DROP_FILES,
  MAX_INSERT_TEXT,
  acceptInsert,
  connect,
  draggingFiles,
  sendDroppedFiles,
  type ViewerInsertEvent
} from '../plugins/_shared/bridge.js'
import { createEditor, padDropInsert } from '../plugins/_shared/editor.js'

// jsdom's Range has no rectangles. An empty value is returned so that CodeMirror's re-measure (focus and selection layers) does not throw and dirty stderr
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

describe('acceptInsert', () => {
  it('only for the file being shown, and only a string that is non-empty and within the limit', () => {
    const ok = { uri: 'file:///a.md', text: '![x](file:///x.png)' }
    expect(acceptInsert(ok, 'file:///a.md')).toEqual({ uri: 'file:///a.md', text: '![x](file:///x.png)' })
    expect(acceptInsert(ok, 'file:///b.md')).toBeNull()
    expect(acceptInsert(ok, null)).toBeNull()
    expect(acceptInsert({ ...ok, text: '' }, 'file:///a.md')).toBeNull()
    expect(acceptInsert({ ...ok, text: 3 }, 'file:///a.md')).toBeNull()
    expect(acceptInsert({ ...ok, text: 'x'.repeat(MAX_INSERT_TEXT + 1) }, 'file:///a.md')).toBeNull()
  })

  it('ignores the coordinates (x / y) from the time of 366 if present (the position is the caret)', () => {
    const legacy = { uri: 'file:///a.md', text: 't', x: 1, y: 2 } as { uri: string; text: string }
    expect(acceptInsert(legacy, 'file:///a.md')).toEqual({ uri: 'file:///a.md', text: 't' })
  })

  it('draggingFiles: only Finder files or a list of URIs (a text selection is not)', () => {
    expect(draggingFiles(['Files'])).toBe(true)
    expect(draggingFiles(['text/uri-list', 'text/plain'])).toBe(true)
    expect(draggingFiles(['text/plain'])).toBe(false)
    expect(draggingFiles(undefined)).toBe(false)
  })
})

describe('padDropInsert (TODO 429 / 428 observation (1))', () => {
  it('adds one half-width space before unless the preceding character is whitespace; does not pad for whitespace (half-width, full-width, tab, newline) or the start of the text', () => {
    expect(padDropInsert('a', '/p/x')).toBe(' /p/x')
    expect(padDropInsert('。', '/p/x')).toBe(' /p/x')
    expect(padDropInsert(')', '![a.png](file:///p/a.png)')).toBe(' ![a.png](file:///p/a.png)')
    expect(padDropInsert(' ', '/p/x')).toBe('/p/x')
    expect(padDropInsert('　', '/p/x')).toBe('/p/x')
    expect(padDropInsert('\t', '/p/x')).toBe('/p/x')
    expect(padDropInsert('\n', '/p/x')).toBe('/p/x')
    expect(padDropInsert('', '/p/x')).toBe('/p/x')
    expect(padDropInsert('a', '')).toBe('')
  })

  it('newline separators between the second and later paths stay as they are (padding is only before the first)', () => {
    expect(padDropInsert('a', '/p/one\n/p/two')).toBe(' /p/one\n/p/two')
  })
})

describe('editor.insertText (real CodeMirror)', () => {
  function make(value: string, readOnly = false) {
    const host = document.createElement('div')
    document.body.append(host)
    const changes: string[] = []
    const editor = createEditor(host, {
      value,
      filename: 'doc.txt',
      readOnly,
      theme: 'light',
      onChange: (next) => changes.push(next)
    })
    return { editor, host, changes }
  }

  it('inserts at the caret and puts the caret after it; reports as a draft (pads a half-width space mid-line, 429)', () => {
    const { editor, host, changes } = make('line1\nline2\n')
    editor.revealLine(2, 3) // Caret to line 2, column 3 (= 'li|ne2')
    expect(editor.insertText('/Users/k/a b.txt')).toBe(true)
    expect(editor.getValue()).toBe('line1\nli /Users/k/a b.txtne2\n')
    expect(changes.at(-1)).toBe('line1\nli /Users/k/a b.txtne2\n')
    // The caret goes after the inserted text (also past the padding space added): inserting again lines up after it
    editor.insertText('X')
    expect(editor.getValue()).toBe('line1\nli /Users/k/a b.txt Xne2\n')
    editor.destroy()
    host.remove()
  })

  it('does not pad when the preceding character is whitespace, tab, full-width space, or at the line start; does not pad newlines (429)', () => {
    const cases: [string, number, string][] = [
      ['ab cd', 4, 'ab /p/xcd'],
      ['ab\tcd', 4, 'ab\t/p/xcd'],
      ['ab　cd', 4, 'ab　/p/xcd'],
      ['ab\ncd', 1, 'ab\n/p/xcd'] // Start of line 2
    ]
    for (const [value, column, expected] of cases) {
      const { editor, host } = make(value)
      editor.revealLine(value.includes('\n') ? 2 : 1, column)
      editor.insertText('/p/x')
      expect(editor.getValue()).toBe(expected)
      editor.destroy()
      host.remove()
    }
  })

  it('multiple lines (one path per line) stay as they are; inserts at the start of the text when the caret is there', () => {
    const { editor, host } = make('abc')
    expect(editor.insertText('/p/one\n/p/two')).toBe(true)
    expect(editor.getValue()).toBe('/p/one\n/p/twoabc')
    editor.destroy()
    host.remove()
  })

  it('refuses in read-only mode and for an empty string (the body does not change)', () => {
    const { editor, host, changes } = make('keep', true)
    expect(editor.insertText('[a](file:///a)')).toBe(false)
    expect(editor.getValue()).toBe('keep')
    expect(changes).toEqual([])
    editor.setReadOnly(false)
    expect(editor.insertText('')).toBe(false)
    editor.destroy()
    host.remove()
  })
})

describe('bridge: insert-text and drags inside the iframe', () => {
  interface FakePort {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage: ReturnType<typeof vi.fn>
    start: () => void
  }
  let port: FakePort
  const inserted: ViewerInsertEvent[] = []

  const sent = (): ViewerGuestMessage[] => port.postMessage.mock.calls.map((call) => call[0] as ViewerGuestMessage)
  const host = (message: ViewerHostMessage): void => port.onmessage?.({ data: message } as MessageEvent)

  function drag(
    type: string,
    types: readonly string[],
    files: readonly unknown[] = []
  ): { event: Event; reachedBelow: boolean; effect: string } {
    const target = document.getElementById('cm') as HTMLElement
    let reachedBelow = false
    const below = (): void => {
      reachedBelow = true
    }
    target.addEventListener(type, below)
    const event = new Event(type, { bubbles: true, cancelable: true })
    const dataTransfer = { types, files, dropEffect: 'none' }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(event)
    target.removeEventListener(type, below)
    return { event, reachedBelow, effect: dataTransfer.dropEffect }
  }

  beforeAll(() => {
    const div = document.createElement('div')
    div.id = 'cm'
    document.body.append(div)
    const bridge = connect('aios.test')
    bridge.onInsertText((event) => inserted.push(event))
    port = { onmessage: null, postMessage: vi.fn(), start: () => undefined }
    const event = new MessageEvent('message')
    Object.defineProperty(event, 'ports', { value: [port] })
    Object.defineProperty(event, 'source', { value: window.parent })
    window.dispatchEvent(event)
    host({
      type: 'resource',
      uri: 'file:///w/a.md',
      label: 'a.md',
      resource: { kind: 'text', text: '', truncated: false, size: 0 },
      editable: true,
      theme: 'light',
      locale: 'en'
    })
  })

  it('only insert-text addressed to the shown file arrives', () => {
    host({ type: 'insert-text', uri: 'file:///w/b.md', text: 'x' })
    host({ type: 'insert-text', uri: 'file:///w/a.md', text: '[c](file:///c)' })
    expect(inserted).toEqual([{ uri: 'file:///w/a.md', text: '[c](file:///c)' }])
  })

  it('stops a file drag in the capture phase and sends drag-files throttled; also sends a drop with no File with count 0 (429)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      port.postMessage.mockClear()
      const enter = drag('dragenter', ['Files'])
      expect(enter.event.defaultPrevented).toBe(true)
      expect(enter.reachedBelow).toBe(false)
      // 407: with `none`, no drop happens when the overlay was not in time. Show `copy` and accept
      expect(enter.effect).toBe('copy')
      drag('dragover', ['Files'])
      expect(sent().filter((m) => m.type === 'drag-files')).toHaveLength(1)
      vi.setSystemTime(10_000 + DRAG_NOTICE_INTERVAL_MS + 1)
      drag('dragover', ['Files'])
      expect(sent().filter((m) => m.type === 'drag-files')).toHaveLength(2)

      port.postMessage.mockClear()
      const dropped = drag('drop', ['Files'])
      expect(dropped.event.defaultPrevented).toBe(true)
      expect(dropped.reachedBelow).toBe(false)
      // 429: to split 'the viewer saw the drop' in the host log, it is sent even with 0 Files
      expect(sent()).toEqual([{ type: 'drop-files', files: [], count: 0 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a File dropped inside the iframe back via drop-files without reading it (407); does not hand it to CodeMirror; the limit is 64', () => {
    port.postMessage.mockClear()
    const files = [{ name: 'a.txt' }, { name: 'b.png' }]
    const dropped = drag('drop', ['Files'], files)
    expect(dropped.event.defaultPrevented).toBe(true)
    expect(dropped.reachedBelow).toBe(false)
    expect(sent()).toEqual([{ type: 'drop-files', files, count: 2 }])

    port.postMessage.mockClear()
    const many = Array.from({ length: MAX_DROP_FILES + 5 }, (_, i) => ({ name: `f${i}` }))
    drag('drop', ['Files'], many)
    const message = sent()[0] as Extract<ViewerGuestMessage, { type: 'drop-files' }>
    expect(message.files).toHaveLength(MAX_DROP_FILES)
    expect(message.count).toBe(MAX_DROP_FILES + 5)
  })

  it('when structured cloning of a File fails, resends only the count (no name or path, 429)', () => {
    const messages: ViewerGuestMessage[] = []
    let first = true
    const send = (message: ViewerGuestMessage): void => {
      if (first) {
        first = false
        throw new DOMException('could not be cloned', 'DataCloneError')
      }
      messages.push(message)
    }
    sendDroppedFiles(send, [{ name: 'secret.png' }])
    expect(messages).toEqual([{ type: 'drop-files', files: [], count: 1, cloneFailed: true }])
    expect(JSON.stringify(messages)).not.toContain('secret')
  })

  it('does not touch a text drag (moving a selection inside the editor)', () => {
    port.postMessage.mockClear()
    const over = drag('dragover', ['text/plain'])
    expect(over.event.defaultPrevented).toBe(false)
    expect(over.reachedBelow).toBe(true)
    const dropped = drag('drop', ['text/plain'])
    expect(dropped.event.defaultPrevented).toBe(false)
    expect(dropped.reachedBelow).toBe(true)
    expect(sent()).toEqual([])
  })
})
