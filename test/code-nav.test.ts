/**
 * @vitest-environment jsdom
 *
 * TODO 692 (wave 32 bundle B): the code viewer's "go to declaration" (F12), "list assignments and uses" (⇧F12), and highlighting of the same variable
 * (`plugins/_shared/code-nav.ts`), and the entry points to the host (the bridge's `code-nav` / `editorKeys` / right-click `codeNav`,
 * the renderer's shortcut table and menu). The analysis itself is in `test/references.test.ts`.
 *
 * Runs the real CodeMirror + language pack (dynamic import) in jsdom. Neither the model nor Electron is started.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { ViewerHostMessage } from '../src/shared/plugin.js'
import { createEditor } from '../plugins/_shared/editor.js'
import { acceptCodeNav, acceptEditorKeys, connect, contextMenuMessage } from '../plugins/_shared/bridge.js'
import {
  HIGHLIGHT_SCAN_MARGIN,
  REF_HIGHLIGHT_DELAY_MS,
  filterRefRows,
  highlightRefsFor,
  highlightScanRange,
  refRows
} from '../plugins/_shared/code-nav.js'
import { EditorState } from '@codemirror/state'
import { codeMirrorKeysOf, conflictsOf, effectiveKeybinding, keybindingCommand } from '../src/shared/keybindings.js'
import { setKeybindings, viewerEditorKeyLabel, viewerEditorKeys, viewerForwardedShortcuts } from '../src/renderer/src/shortcuts.js'
import { acceptViewerContextMenu } from '../src/renderer/src/viewer-selection.js'
import { codeNavMenuItems } from '../src/renderer/src/path-context-menu.js'

// jsdom's Range has no rectangles. Returns empty so CodeMirror's re-measure does not throw (same as symbol-picker.test.ts).
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

const SOURCE = ['let total = 0', 'function add(n) {', '  total += n', '  return total', '}', 'add(total)'].join('\n')

async function make(value = SOURCE, filename = 'a.ts') {
  const host = document.createElement('div')
  document.body.append(host)
  const reports: boolean[] = []
  const editor = createEditor(host, {
    value,
    filename,
    readOnly: false,
    theme: 'light',
    onChange: () => undefined,
    onSymbolsAvailable: (available) => reports.push(available),
    codeNav: true
  })
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!
  // The language pack is loaded dynamically. When it hits, a symbol notice arrives (the change of the same structure).
  await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0), { timeout: 5000 })
  const pickerOf = (): HTMLElement => host.querySelector('.ref-picker') as HTMLElement
  const rows = (): string[] =>
    [...host.querySelectorAll('.ref-picker .symbol-picker-item')].map(
      (row) => `${row.querySelector('.ref-role')?.textContent} ${row.querySelector('.symbol-line')?.textContent}`
    )
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    view.contentDOM.dispatchEvent(event)
    return event
  }
  const at = (pos: number): void => view.dispatch({ selection: { anchor: pos } })
  const done = (): void => {
    editor.destroy()
    host.remove()
  }
  return { editor, view, host, pickerOf, rows, press, at, done }
}

describe('editor: F12 / ⇧F12 (TODO 692)', () => {
  it('F12 で宣言の名前の字へ。宣言の上で押せば一覧', async () => {
    const { view, press, at, pickerOf, done } = await make()
    at(SOURCE.lastIndexOf('total') + 1)
    const event = press('F12')
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('total'))
    expect(view.state.selection.main.empty).toBe(true)
    // Already on the declaration: F12 again lists assignments and uses (the same as VS Code's default).
    press('F12')
    expect(pickerOf().hidden).toBe(false)
    done()
  })

  it('⇧F12 で一覧: 宣言 / 代入 / 使用の印と行番号、カーソルの下の出現を強調。Enter でその行へ', async () => {
    const { view, press, at, pickerOf, rows, host, done } = await make()
    at(SOURCE.indexOf('total +=') + 2)
    press('F12', { shiftKey: true })
    expect(pickerOf().hidden).toBe(false)
    expect(rows()).toEqual(['decl 1', 'write 3', 'read 4', 'read 6'])
    const active = host.querySelector('.ref-picker .symbol-picker-item.active .symbol-line')
    expect(active?.textContent).toBe('3')
    const input = host.querySelector('.ref-picker .symbol-picker-input') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(pickerOf().hidden).toBe(true)
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('return total') + 'return '.length)
    done()
  })

  it('宣言の見つからない名前では知らせを出し、カーソルは動かさない', async () => {
    const src = ['console.log(1)'].join('\n')
    const { view, press, at, host, done } = await make(src)
    at(2)
    press('F12')
    expect(view.state.selection.main.head).toBe(2)
    const note = host.querySelector('.code-nav-note') as HTMLElement
    expect(note.hidden).toBe(false)
    expect(note.textContent).toContain('console')
    done()
  })

  it('キーは host の editorKeys で替わる (外せば効かない)', async () => {
    const { editor, view, press, at, done } = await make()
    editor.setEditorKeys({ 'code.goToDeclaration': 'Ctrl+Alt+D' })
    at(SOURCE.lastIndexOf('total') + 1)
    expect(press('F12').defaultPrevented).toBe(false)
    expect(view.state.selection.main.head).toBe(SOURCE.lastIndexOf('total') + 1)
    press('d', { ctrlKey: true, altKey: true, code: 'KeyD' })
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('total'))
    // null returns to the default.
    editor.setEditorKeys(null)
    at(SOURCE.lastIndexOf('total') + 1)
    press('F12')
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf('total'))
    done()
  })

  it('カーソルが名前の上に止まると、代入 (と宣言) と使用を色を分けて強調する。選択中は出さない', async () => {
    const { view, at, host, done } = await make()
    at(SOURCE.indexOf('total') + 1)
    await vi.waitFor(() => expect(host.querySelectorAll('.cm-codeRef').length).toBe(4), { timeout: REF_HIGHLIGHT_DELAY_MS * 20 })
    expect(host.querySelectorAll('.cm-codeRef-write').length).toBe(2)
    expect(host.querySelectorAll('.cm-codeRef-read').length).toBe(2)
    view.dispatch({ selection: { anchor: 0, head: 5 } })
    await vi.waitFor(() => expect(host.querySelectorAll('.cm-codeRef').length).toBe(0), { timeout: REF_HIGHLIGHT_DELAY_MS * 20 })
    done()
  })

  it('TODO 692 の code-review: highlightScanRange は見えている範囲 + 余白、ドキュメントの外へは出ない', () => {
    const doc = 'x'.repeat(10_000)
    const state = EditorState.create({ doc })
    const stubView = { visibleRanges: [{ from: 4000, to: 4100 }], state } as unknown as EditorView
    expect(highlightScanRange(stubView)).toEqual({ from: 4000 - HIGHLIGHT_SCAN_MARGIN, to: 4100 + HIGHLIGHT_SCAN_MARGIN })
    const atStart = { visibleRanges: [{ from: 0, to: 50 }], state } as unknown as EditorView
    expect(highlightScanRange(atStart).from).toBe(0)
    const atEnd = { visibleRanges: [{ from: 9950, to: 10000 }], state } as unknown as EditorView
    expect(highlightScanRange(atEnd).to).toBe(10_000)
  })

  it('TODO 692 の code-review: highlightRefsFor は scanRange の外の出現を数えない (範囲外でもカーソル自身は数える)', async () => {
    const doc = ['let x = 0', ...Array.from({ length: 20 }, () => 'x++'), 'x'].join('\n')
    const { view, at, done } = await make(doc)
    const pos = doc.indexOf('let x') + 4
    at(pos)
    const full = highlightRefsFor(view.state)
    const narrow = highlightRefsFor(view.state, { from: pos, to: pos + 20 })
    expect(narrow.length).toBeLessThan(full.length)
    expect(narrow.some((ref) => ref.from === pos)).toBe(true)
    done()
  })

  it('右クリック: 名前の上ならカーソルをそこへ移して真。メニューの code-nav は右クリックした位置で動く', async () => {
    const { editor, view, pickerOf, done } = await make()
    const target = SOURCE.indexOf('total +=') + 1
    // jsdom has no layout, so only the coordinate -> position mapping is replaced.
    view.posAtCoords = (() => target) as typeof view.posAtCoords
    const probe = editor.probeContextMenu({ clientX: 1, clientY: 1, target: view.contentDOM })
    expect(probe).toEqual({ codeNav: true, keepSelection: true })
    expect(view.state.selection.main.head).toBe(target)
    view.dispatch({ selection: { anchor: 0 } })
    expect(editor.runCodeNav('references')).toBe(true)
    expect(pickerOf().hidden).toBe(false)
    // Outside the name (above `=`) is false.
    view.posAtCoords = (() => SOURCE.indexOf('=')) as typeof view.posAtCoords
    expect(editor.probeContextMenu({ clientX: 1, clientY: 1, target: view.contentDOM }).codeNav).toBe(false)
    done()
  })

  it('右クリック: 選択の中なら選択はそのまま、選択の外なら選択を外す (検索の項目は出さない)', async () => {
    const { editor, view, done } = await make()
    view.dispatch({ selection: { anchor: 0, head: 9 } })
    view.posAtCoords = (() => 5) as typeof view.posAtCoords
    expect(editor.probeContextMenu({ clientX: 1, clientY: 1, target: view.contentDOM })).toEqual({ codeNav: true, keepSelection: true })
    expect(view.state.selection.main.empty).toBe(false)
    view.posAtCoords = (() => SOURCE.indexOf('total +=') + 1) as typeof view.posAtCoords
    expect(editor.probeContextMenu({ clientX: 1, clientY: 1, target: view.contentDOM })).toEqual({ codeNav: true, keepSelection: false })
    expect(view.state.selection.main.empty).toBe(true)
    done()
  })

  it('codeNav を立てない editor (markdown / html の Source) と表の無い言語では何もしない', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const plain = createEditor(host, { value: SOURCE, filename: 'a.ts', readOnly: false, theme: 'light', onChange: () => undefined })
    expect(plain.runCodeNav('declaration')).toBe(false)
    expect(plain.probeContextMenu({ clientX: 0, clientY: 0, target: null }).codeNav).toBe(false)
    expect(host.querySelector('.ref-picker')).toBeNull()
    plain.destroy()
    host.remove()
    const text = await make('let x = 1', 'notes.txt')
    expect(text.editor.runCodeNav('references')).toBe(false)
    expect(text.host.querySelector('.code-nav-note')?.hasAttribute('hidden')).toBe(true)
    text.done()
  })
})

describe('一覧の行 (TODO 692)', () => {
  it('抜粋は先頭の空白を落とし、名前の位置を持つ。絞り込みは抜粋か行番号', () => {
    const state = EditorState.create({ doc: ['    foo = 1', 'x = foo'].join('\n') })
    const rows = refRows(state, [
      { from: 4, to: 7, line: 1, role: 'declaration' },
      { from: 16, to: 19, line: 2, role: 'read' }
    ])
    expect(rows.map((r) => [r.excerpt, r.excerpt.slice(r.nameFrom, r.nameTo)])).toEqual([
      ['foo = 1', 'foo'],
      ['x = foo', 'foo']
    ])
    expect(filterRefRows(rows, 'X =').map((r) => r.ref.line)).toEqual([2])
    expect(filterRefRows(rows, '1').map((r) => r.ref.line)).toEqual([1])
  })

  it('長い行は名前の前後だけ (… で切る)', () => {
    const long = `${'a'.repeat(300)} target ${'b'.repeat(300)}`
    const state = EditorState.create({ doc: long })
    const [row] = refRows(state, [{ from: 301, to: 307, line: 1, role: 'read' }])
    expect(row!.excerpt.length).toBeLessThanOrEqual(162)
    expect(row!.excerpt.startsWith('…')).toBe(true)
    expect(row!.excerpt.slice(row!.nameFrom, row!.nameTo)).toBe('target')
  })
})

describe('bridge (TODO 692)', () => {
  interface FakePort {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage: ReturnType<typeof vi.fn>
    start: () => void
  }
  let port: FakePort
  const actions: string[] = []
  let keys: unknown = undefined
  const host = (message: ViewerHostMessage): void => port.onmessage?.({ data: message } as MessageEvent)

  beforeAll(() => {
    const bridge = connect('aios.test')
    bridge.onCodeNav((action) => actions.push(action))
    bridge.onResource((event) => {
      keys = event.editorKeys
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
      locale: 'en',
      editorKeys: { 'code.goToDeclaration': 'F11' }
    })
  })

  it('表示中のファイル宛ての code-nav だけ届く。editorKeys は resource に載って届く', () => {
    expect(keys).toEqual({ 'code.goToDeclaration': 'F11' })
    host({ type: 'code-nav', uri: 'file:///w/b.ts', action: 'declaration' })
    host({ type: 'code-nav', uri: 'file:///w/a.ts', action: 'references' })
    expect(actions).toEqual(['references'])
  })

  it('検め: 知らないコマンド・文字列でない値は落とす。action は 2 つだけ', () => {
    expect(acceptEditorKeys({ 'code.goToDeclaration': 'F12', bogus: 'F1', 'code.listReferences': 3 })).toEqual({
      'code.goToDeclaration': 'F12'
    })
    expect(acceptEditorKeys(null)).toBeNull()
    expect(acceptEditorKeys(['F12'])).toBeNull()
    expect(acceptCodeNav({ uri: 'u', action: 'run' }, 'u')).toBeNull()
    expect(acceptCodeNav({ uri: 'u', action: 'declaration' }, 'u')).toBe('declaration')
  })

  it('右クリックの知らせ: 名前の上なら選択が無くても送る (text は空)', () => {
    expect(contextMenuMessage('', 'u', 1, 2)).toBeNull()
    expect(contextMenuMessage('', 'u', 1, 2, true)).toEqual({ type: 'context-menu', uri: 'u', x: 1, y: 2, text: '', codeNav: true })
    expect(contextMenuMessage('abc', 'u', 1, 2)).toEqual({ type: 'context-menu', uri: 'u', x: 1, y: 2, text: 'abc' })
  })
})

describe('ショートカットの表とメニュー (TODO 692)', () => {
  it('既定は F12 / ⇧F12 (scope viewer)。送り返しの表には載らない', () => {
    expect(keybindingCommand('code.goToDeclaration')).toMatchObject({ scope: 'viewer', defaults: { mac: 'F12', other: 'F12' } })
    expect(effectiveKeybinding('code.listReferences', 'mac', {})).toBe('Shift+F12')
    for (const platform of ['mac', 'other'] as const) {
      expect(viewerForwardedShortcuts(platform).some((row) => row.key === 'F12')).toBe(false)
    }
    expect(conflictsOf('F12', 'code.goToDeclaration', 'mac', {}).commands).toEqual([])
  })

  it('viewerEditorKeys は利用者の割り当てに従い、外したコマンドは載せない', () => {
    setKeybindings({}, 'mac')
    expect(viewerEditorKeys('mac')).toEqual({ 'code.goToDeclaration': 'F12', 'code.listReferences': 'Shift+F12' })
    expect(viewerEditorKeyLabel('code.listReferences', 'mac')).toBe('⇧F12')
    setKeybindings({ 'code.goToDeclaration': 'CmdOrCtrl+B', 'code.listReferences': null }, 'mac')
    expect(viewerEditorKeys('mac')).toEqual({ 'code.goToDeclaration': 'CmdOrCtrl+B' })
    expect(viewerEditorKeyLabel('code.listReferences', 'mac')).toBeNull()
    setKeybindings({}, 'mac')
  })

  it('CodeMirror のキーの書式: CmdOrCtrl は Mod (mac は Ctrl も)、英字は小文字、名前付きは KeyboardEvent の名前', () => {
    expect(codeMirrorKeysOf('Shift+F12', 'mac')).toEqual(['Shift-F12'])
    expect(codeMirrorKeysOf('CmdOrCtrl+Shift+B', 'mac')).toEqual(['Mod-Shift-b', 'Ctrl-Shift-b'])
    expect(codeMirrorKeysOf('CmdOrCtrl+B', 'other')).toEqual(['Mod-b'])
    expect(codeMirrorKeysOf('Cmd+Alt+Left', 'mac')).toEqual(['Meta-Alt-ArrowLeft'])
    expect(codeMirrorKeysOf('bogus', 'mac')).toEqual([])
  })

  it('右クリックのメニュー: 名前の上なら 2 つ (キーの表記つき)。選ばれたら viewer に頼む', () => {
    const t = ((key: string) => key) as never
    const ran: string[] = []
    const items = codeNavMenuItems(t, (action) => (action === 'declaration' ? 'F12' : null), (action) => ran.push(action))
    expect(items.map((item) => [item.key, item.label, item.shortcut])).toEqual([
      ['go-to-declaration', 'viewer.contextMenu.goToDeclaration', 'F12'],
      ['list-references', 'viewer.contextMenu.listReferences', undefined]
    ])
    items[1]!.onSelect()
    expect(ran).toEqual(['references'])
    expect(acceptViewerContextMenu({ uri: 'u', x: 1, y: 2, text: '', codeNav: true }, 'u')?.codeNav).toBe(true)
    expect(acceptViewerContextMenu({ uri: 'u', x: 1, y: 2, text: '', codeNav: 'yes' }, 'u')?.codeNav).toBe(false)
  })
})
