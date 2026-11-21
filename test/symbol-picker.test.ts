/**
 * @vitest-environment jsdom
 *
 * TODO 468 (wave 23 bundle F): the list of symbols in a file (`plugins/_shared/symbol-picker.ts`) and its entry with the host (the bridge's `open-symbols` / `symbols`).
 *
 *  - Pure key functions (`pickerKeyStep` / `pickerKey`): ↑↓ wrap around at the ends. Keys during IME composition and with modifiers are not read
 *  - editor (the real CodeMirror and language pack in jsdom): when a language matches, it reports 'has symbols'; when switched to a language without a table, 'none'. ⌘R (jsdom is not mac, so Ctrl+R) and `openSymbols` open the list; narrowing, ↓, and Enter place the cursor on that name's characters and close it. Esc closes it. It closes when the body changes
 *  - bridge: only `open-symbols` addressed to the file being shown arrives, and `reportSymbols` sends `symbols`
 *
 * Neither a model nor Electron is started.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { ViewerGuestMessage, ViewerHostMessage } from '../src/shared/plugin.js'
import { createEditor } from '../plugins/_shared/editor.js'
import { connect } from '../plugins/_shared/bridge.js'
import {
  createListPicker,
  PICKER_MAX_ROWS,
  PICKER_PAGE,
  pickerKey,
  pickerKeyStep,
  type ListPickerSource
} from '../plugins/_shared/symbol-picker.js'
import { viewerForwardedShortcuts } from '../src/renderer/src/shortcuts.js'

// jsdom's Range has no rectangles. Return empty so that CodeMirror's re-measurement does not throw.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

describe('pickerKeyStep / pickerKey', () => {
  it('↑↓ は端で巡回、PageUp / PageDown は端で止まる。まだ指していなければ ↓ は先頭・↑ は末尾', () => {
    expect(pickerKeyStep('ArrowDown', 0, 3)).toBe(1)
    expect(pickerKeyStep('ArrowDown', 2, 3)).toBe(0)
    expect(pickerKeyStep('ArrowUp', 0, 3)).toBe(2)
    expect(pickerKeyStep('ArrowDown', -1, 3)).toBe(0)
    expect(pickerKeyStep('ArrowUp', -1, 3)).toBe(2)
    expect(pickerKeyStep('PageDown', 0, 30)).toBe(PICKER_PAGE)
    expect(pickerKeyStep('PageDown', 25, 30)).toBe(29)
    expect(pickerKeyStep('PageUp', 3, 30)).toBe(0)
    expect(pickerKeyStep('Home', 3, 30)).toBeNull()
    expect(pickerKeyStep('ArrowDown', 0, 0)).toBeNull()
  })

  it('IME の変換中 (keyCode 229 を含む) と修飾キー付きは読まない', () => {
    expect(pickerKey({ key: 'ArrowDown' })).toBe('ArrowDown')
    expect(pickerKey({ key: 'Enter', isComposing: true })).toBeNull()
    expect(pickerKey({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(pickerKey({ key: 'ArrowDown', metaKey: true })).toBeNull()
    expect(pickerKey({ key: 'ArrowDown', shiftKey: true })).toBeNull()
  })
})

describe('editor の記号の一覧', () => {
  const SOURCE = ['function alpha() {}', 'class Beta {', '  gamma() {}', '}', 'const delta = 1'].join('\n')

  async function make(filename = 'a.ts', value = SOURCE) {
    const host = document.createElement('div')
    document.body.append(host)
    const reports: boolean[] = []
    const editor = createEditor(host, {
      value,
      filename,
      readOnly: false,
      theme: 'light',
      onChange: () => undefined,
      onSymbolsAvailable: (available) => reports.push(available)
    })
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
    // The language pack is a dynamic import. When it matches, a notice arrives.
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0), { timeout: 5000 })
    const picker = (): HTMLElement => host.querySelector('.symbol-picker') as HTMLElement
    const input = (): HTMLInputElement => host.querySelector('.symbol-picker-input') as HTMLInputElement
    const rows = (): string[] =>
      [...host.querySelectorAll('.symbol-picker-item .symbol-name')].map((el) => el.textContent ?? '')
    const key = (k: string, init: KeyboardEventInit = {}): void => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
    }
    const done = (): void => {
      editor.destroy()
      host.remove()
    }
    return { editor, view, host, reports, picker, input, rows, key, done }
  }

  it('TS では「記号あり」を知らせ、openSymbols で全部の記号が本文の順に出る', async () => {
    const { editor, reports, picker, rows, input, done } = await make()
    expect(reports.at(-1)).toBe(true)
    expect(editor.openSymbols()).toBe(true)
    expect(picker().hidden).toBe(false)
    expect(rows()).toEqual(['alpha', 'Beta', 'gamma', 'delta'])
    expect(document.activeElement).toBe(input())
    // The narrowing field is a target of ASCII input (TODO 463, code-review of wave 23).
    expect(input().hasAttribute('data-ascii-input')).toBe(true)
    done()
  })

  it('絞り込み → ↓ → Enter で、その記号の名前の字にカーソルを置いて閉じる', async () => {
    const { editor, view, picker, rows, input, key, done } = await make()
    editor.openSymbols()
    input().value = 'a'
    input().dispatchEvent(new Event('input'))
    // Every name containing 'a' is alpha / Beta / gamma / delta. Move to the second (Beta).
    expect(rows()).toEqual(['alpha', 'Beta', 'gamma', 'delta'])
    key('ArrowDown')
    key('Enter')
    expect(picker().hidden).toBe(true)
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('Beta'))
    expect(view.state.selection.main.empty).toBe(true)
    done()
  })

  it('一致が無ければ知らせを出し、Enter は何もしない。Esc で閉じる', async () => {
    const { editor, view, picker, host, input, key, done } = await make()
    editor.openSymbols()
    input().value = 'zzz'
    input().dispatchEvent(new Event('input'))
    const note = host.querySelector('.symbol-picker-note') as HTMLElement
    expect(note.hidden).toBe(false)
    expect(note.textContent).not.toBe('')
    const before = view.state.selection.main.head
    key('Enter')
    expect(view.state.selection.main.head).toBe(before)
    key('Escape')
    expect(picker().hidden).toBe(true)
    done()
  })

  it('Ctrl+R / ⌘R (editor のキーマップ) で開く', async () => {
    const { view, picker, done } = await make()
    // jsdom is not mac, so Mod = Ctrl.
    const event = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(event)
    expect(picker().hidden).toBe(false)
    // Do not pass it on to the default action (reload).
    expect(event.defaultPrevented).toBe(true)
    done()
  })

  it('本文が替わったら閉じる (位置が古くなるため)', async () => {
    const { editor, picker, done } = await make()
    editor.openSymbols()
    editor.setValue('function other() {}')
    expect(picker().hidden).toBe(true)
    done()
  })

  it('表の無い言語 (テキスト) に替われば「無し」を知らせ、一覧は開かない', async () => {
    const { editor, reports, done } = await make()
    const count = reports.length
    editor.setValue('plain text')
    editor.setFilename('notes.txt')
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(count), { timeout: 5000 })
    expect(reports.at(-1)).toBe(false)
    expect(editor.openSymbols()).toBe(false)
    done()
  })

  it('onSymbolsAvailable を渡さない editor (markdown / html の Source) では開かない', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = createEditor(host, { value: SOURCE, filename: 'a.ts', readOnly: false, theme: 'light', onChange: () => undefined })
    expect(editor.openSymbols()).toBe(false)
    expect(host.querySelector('.symbol-picker')).toBeNull()
    editor.destroy()
    host.remove()
  })
})

describe('createListPicker: 窓が PICKER_MAX_ROWS を超える一覧 (TODO 692 の code-review)', () => {
  // The number of list rows can go well beyond PICKER_MAX_ROWS (300), as MAX_REFERENCES (5000) in `references.ts` does. If `initial` (the cursor's occurrence) is beyond the first 300 in that range, it used to fall outside the window, and Enter jumped to another row.
  const LENGTH = 1000
  const INITIAL = 700 // Beyond PICKER_MAX_ROWS (300)

  function make() {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({ doc: 'x'.repeat(LENGTH + 10), parent: host })
    const items = Array.from({ length: LENGTH }, (_, i) => i)
    const source: ListPickerSource<number> = {
      collect: () => ({ items, initial: INITIAL, note: () => '' }),
      filter: (all, query) => (query.trim() === '' ? [...all] : all.filter((i) => String(i).includes(query))),
      renderRow(row, item) {
        row.textContent = String(item)
      },
      positionOf: (item) => item,
      placeholder: () => '',
      label: () => ''
    }
    const picker = createListPicker(view, source)
    const input = (): HTMLInputElement => host.querySelector('.symbol-picker-input') as HTMLInputElement
    const rows = (): string[] => [...host.querySelectorAll('.symbol-picker-item')].map((el) => el.textContent ?? '')
    const activeRow = (): string | null => host.querySelector('.symbol-picker-item.active')?.textContent ?? null
    const done = (): void => {
      view.destroy()
      host.remove()
    }
    return { picker, view, input, rows, activeRow, done }
  }

  it('窓は PICKER_MAX_ROWS 件でも initial の行を含み、強調もその行に当たる', () => {
    const { picker, rows, activeRow, done } = make()
    expect(picker.open()).toBe(true)
    const shown = rows()
    expect(shown.length).toBe(PICKER_MAX_ROWS)
    expect(shown).toContain(String(INITIAL))
    expect(activeRow()).toBe(String(INITIAL))
    done()
  })

  it('Enter はその行 (無関係の先頭付近の行ではない) へ飛ぶ', () => {
    const { picker, view, input, done } = make()
    picker.open()
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(view.state.selection.main.head).toBe(INITIAL)
    done()
  })
})

describe('bridge: open-symbols / symbols (TODO 468)', () => {
  interface FakePort {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage: ReturnType<typeof vi.fn>
    start: () => void
  }
  let port: FakePort
  let opened = 0
  let bridge: ReturnType<typeof connect>
  const host = (message: ViewerHostMessage): void => port.onmessage?.({ data: message } as MessageEvent)
  const sent = (): ViewerGuestMessage[] => port.postMessage.mock.calls.map((call) => call[0] as ViewerGuestMessage)

  beforeAll(() => {
    bridge = connect('aios.test')
    bridge.onOpenSymbols(() => {
      opened += 1
    })
    port = { onmessage: null, postMessage: vi.fn(), start: () => undefined }
    const event = new MessageEvent('message')
    Object.defineProperty(event, 'ports', { value: [port] })
    Object.defineProperty(event, 'source', { value: window.parent })
    window.dispatchEvent(event)
    host({
      type: 'resource',
      uri: 'file:///w/a.ts',
      label: 'a.ts',
      resource: { kind: 'text', text: '', truncated: false, size: 0 },
      editable: true,
      theme: 'light',
      locale: 'en'
    })
  })

  it('表示中のファイル宛ての open-symbols だけ届く', () => {
    host({ type: 'open-symbols', uri: 'file:///w/b.ts' })
    expect(opened).toBe(0)
    host({ type: 'open-symbols', uri: 'file:///w/a.ts' })
    expect(opened).toBe(1)
  })

  it('reportSymbols は symbols を送る (記号そのものは載せない)', () => {
    bridge.reportSymbols('file:///w/a.ts', true)
    expect(sent().filter((m) => m.type === 'symbols')).toEqual([{ type: 'symbols', uri: 'file:///w/a.ts', available: true }])
  })
})

describe('viewer の中のキーは host の送り返しの表に載らない (TODO 467 / 468)', () => {
  it('⌘R / ⌘D / ⌘⌥[ は送り返さない (捕捉段階で奪わない)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const keys = viewerForwardedShortcuts(platform).map((row) => row.key)
      expect(keys).not.toContain('r')
      expect(keys).not.toContain('d')
      expect(keys).not.toContain('[')
    }
  })
})
