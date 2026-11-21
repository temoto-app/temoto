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
  it('↑↓ wrap around at the ends, PageUp / PageDown stop at the ends, and ↓ goes to the first and ↑ to the last when nothing is pointed at yet', () => {
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

  it('ignores keys during IME composition (including keyCode 229) and with modifier keys', () => {
    expect(pickerKey({ key: 'ArrowDown' })).toBe('ArrowDown')
    expect(pickerKey({ key: 'Enter', isComposing: true })).toBeNull()
    expect(pickerKey({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(pickerKey({ key: 'ArrowDown', metaKey: true })).toBeNull()
    expect(pickerKey({ key: 'ArrowDown', shiftKey: true })).toBeNull()
  })
})

describe('editor symbol list', () => {
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

  it('announces "has symbols" for TS, and openSymbols lists all symbols in body order', async () => {
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

  it('filter → ↓ → Enter puts the cursor on the name characters of that symbol and closes', async () => {
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

  it('shows a notice when nothing matches, Enter does nothing, and Esc closes', async () => {
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

  it('opens with Ctrl+R / ⌘R (the editor keymap)', async () => {
    const { view, picker, done } = await make()
    // jsdom is not mac, so Mod = Ctrl.
    const event = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(event)
    expect(picker().hidden).toBe(false)
    // Do not pass it on to the default action (reload).
    expect(event.defaultPrevented).toBe(true)
    done()
  })

  it('closes when the body changes (the positions become stale)', async () => {
    const { editor, picker, done } = await make()
    editor.openSymbols()
    editor.setValue('function other() {}')
    expect(picker().hidden).toBe(true)
    done()
  })

  it('announces "none" when switched to a language without a table (text), and does not open the list', async () => {
    const { editor, reports, done } = await make()
    const count = reports.length
    editor.setValue('plain text')
    editor.setFilename('notes.txt')
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(count), { timeout: 5000 })
    expect(reports.at(-1)).toBe(false)
    expect(editor.openSymbols()).toBe(false)
    done()
  })

  it('does not open in an editor that is not given onSymbolsAvailable (Source of markdown / html)', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = createEditor(host, { value: SOURCE, filename: 'a.ts', readOnly: false, theme: 'light', onChange: () => undefined })
    expect(editor.openSymbols()).toBe(false)
    expect(host.querySelector('.symbol-picker')).toBeNull()
    editor.destroy()
    host.remove()
  })
})

describe('createListPicker: a list whose window exceeds PICKER_MAX_ROWS (code-review of TODO 692)', () => {
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

  it('the window holds PICKER_MAX_ROWS rows yet includes the initial row, and the highlight lands on that row', () => {
    const { picker, rows, activeRow, done } = make()
    expect(picker.open()).toBe(true)
    const shown = rows()
    expect(shown.length).toBe(PICKER_MAX_ROWS)
    expect(shown).toContain(String(INITIAL))
    expect(activeRow()).toBe(String(INITIAL))
    done()
  })

  it('Enter jumps to that row (not an unrelated row near the top)', () => {
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

  it('only open-symbols addressed to the displayed file arrives', () => {
    host({ type: 'open-symbols', uri: 'file:///w/b.ts' })
    expect(opened).toBe(0)
    host({ type: 'open-symbols', uri: 'file:///w/a.ts' })
    expect(opened).toBe(1)
  })

  it('reportSymbols sends symbols (not the symbols themselves)', () => {
    bridge.reportSymbols('file:///w/a.ts', true)
    expect(sent().filter((m) => m.type === 'symbols')).toEqual([{ type: 'symbols', uri: 'file:///w/a.ts', available: true }])
  })
})

describe("keys inside the viewer are not in the host's send-back table (TODO 467 / 468)", () => {
  it('⌘R / ⌘D / ⌘⌥[ are not sent back (not stolen in the capture phase)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const keys = viewerForwardedShortcuts(platform).map((row) => row.key)
      expect(keys).not.toContain('r')
      expect(keys).not.toContain('d')
      expect(keys).not.toContain('[')
    }
  })
})
