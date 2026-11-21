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
  it('表示中のファイル宛てで、文字列が空でなく上限以内のものだけ', () => {
    const ok = { uri: 'file:///a.md', text: '![x](file:///x.png)' }
    expect(acceptInsert(ok, 'file:///a.md')).toEqual({ uri: 'file:///a.md', text: '![x](file:///x.png)' })
    expect(acceptInsert(ok, 'file:///b.md')).toBeNull()
    expect(acceptInsert(ok, null)).toBeNull()
    expect(acceptInsert({ ...ok, text: '' }, 'file:///a.md')).toBeNull()
    expect(acceptInsert({ ...ok, text: 3 }, 'file:///a.md')).toBeNull()
    expect(acceptInsert({ ...ok, text: 'x'.repeat(MAX_INSERT_TEXT + 1) }, 'file:///a.md')).toBeNull()
  })

  it('366 の頃の座標 (x / y) が付いていても無視する (位置はキャレット)', () => {
    const legacy = { uri: 'file:///a.md', text: 't', x: 1, y: 2 } as { uri: string; text: string }
    expect(acceptInsert(legacy, 'file:///a.md')).toEqual({ uri: 'file:///a.md', text: 't' })
  })

  it('draggingFiles: Finder のファイルか URI の列だけ (テキストの選択は違う)', () => {
    expect(draggingFiles(['Files'])).toBe(true)
    expect(draggingFiles(['text/uri-list', 'text/plain'])).toBe(true)
    expect(draggingFiles(['text/plain'])).toBe(false)
    expect(draggingFiles(undefined)).toBe(false)
  })
})

describe('padDropInsert (TODO 429 / 428 の観察 (1))', () => {
  it('直前が空白でなければ半角空白を 1 つ前に。空白 (半角・全角・タブ・改行) と文頭は補わない', () => {
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

  it('2 つ目以降のパスの改行の区切りはそのまま (前に補うのは 1 つ目の前だけ)', () => {
    expect(padDropInsert('a', '/p/one\n/p/two')).toBe(' /p/one\n/p/two')
  })
})

describe('editor.insertText (実物の CodeMirror)', () => {
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

  it('キャレットの位置に挿し、挿した後ろにキャレット。下書きとして知らせる (行の途中は半角空白を補う、429)', () => {
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

  it('直前が空白・タブ・全角空白・行頭なら補わない。改行は補わない (429)', () => {
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

  it('複数行 (1 行に 1 つのパス) もそのまま。キャレットが文頭なら文頭に', () => {
    const { editor, host } = make('abc')
    expect(editor.insertText('/p/one\n/p/two')).toBe(true)
    expect(editor.getValue()).toBe('/p/one\n/p/twoabc')
    editor.destroy()
    host.remove()
  })

  it('読み取り専用・空の文字列は断る (本文は変わらない)', () => {
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

describe('bridge: insert-text と iframe の中のドラッグ', () => {
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

  it('表示中のファイル宛ての insert-text だけ届く', () => {
    host({ type: 'insert-text', uri: 'file:///w/b.md', text: 'x' })
    host({ type: 'insert-text', uri: 'file:///w/a.md', text: '[c](file:///c)' })
    expect(inserted).toEqual([{ uri: 'file:///w/a.md', text: '[c](file:///c)' }])
  })

  it('ファイルのドラッグは捕捉段階で止め、drag-files を間引いて送る。File の無い drop も数 0 で送る (429)', () => {
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

  it('iframe の中に落ちた File は読まずに drop-files で送り返す (407)。CodeMirror には渡さない。上限は 64', () => {
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

  it('File の構造化複製に失敗したら数だけ送り直す (名前もパスも載せない、429)', () => {
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

  it('テキストのドラッグ (editor の中の選択の移動) には触らない', () => {
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
