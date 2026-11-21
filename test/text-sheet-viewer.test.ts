/**
 * @vitest-environment jsdom
 *
 * TODO 1215: `aios.text` switching Table / Text for `.csv` / `.tsv`. It loads the viewer's entry (`main.ts`) as is, and replaces only the bridge and the editor (the same shape as `markdown-preview-find.test.ts`).
 *
 * - The default when opened is the table. Switching is announced by the host's header `view-modes` (Table / Text).
 * - Switching does not touch the body or the draft (it does not call `reportDraft`, so it does not become dirty). The editor is only hidden.
 * - A draft rewritten in Text appears in the table. A draft that the host had remembered (`draft`) also appears in the table.
 * - The last chosen one is also used for the next `.csv` that is opened. For files not shown as tables, the switch is removed.
 * - ⌘F in the table is the in-document search (the same part as TODO 1110). It is not caught in Text (CodeMirror's search).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: never) => void
const handlers: Record<string, Handler> = {}
const calls: Array<{ name: string; args: unknown[] }> = []

vi.mock('../plugins/_shared/bridge.js', () => ({
  connect: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === 'runCommand') return () => Promise.resolve(null)
          if (name.startsWith('on')) return (h: Handler) => void (handlers[name] = h)
          return (...args: unknown[]) => {
            calls.push({ name, args })
            return undefined
          }
        }
      }
    )
}))

interface FakeEditor {
  value: string
  onChange: (next: string) => void
  setValueCalls: number
  revealed: number[]
}
let editors: FakeEditor[] = []

vi.mock('../plugins/_shared/editor.js', () => ({
  createEditor: (_host: HTMLElement, options: { value: string; onChange: (next: string) => void }) => {
    const state: FakeEditor = { value: options.value, onChange: options.onChange, setValueCalls: 0, revealed: [] }
    editors.push(state)
    return {
      getValue: () => state.value,
      setValue: (value: string) => {
        state.value = value
        state.setValueCalls++
      },
      setReadOnly: () => undefined,
      setFilename: () => undefined,
      setTheme: () => undefined,
      setHighlight: () => undefined,
      setEditorKeys: () => undefined,
      revealLine: (line: number) => void state.revealed.push(line),
      restoreTopLine: () => undefined,
      insertText: () => true,
      openSymbols: () => true,
      runCodeNav: () => true,
      probeContextMenu: () => ({ codeNav: false, keepSelection: true }),
      destroy: () => undefined
    }
  }
}))

let revision = 0
function open(name: string, text: string, extra: { draft?: string | null; truncated?: boolean; uri?: string } = {}): void {
  revision++
  handlers.onResource?.({
    uri: extra.uri ?? `file:///tmp/${name}`,
    label: name,
    editable: true,
    theme: 'light',
    highlightQuery: null,
    draft: extra.draft ?? null,
    revision,
    editorKeys: null,
    resource: { kind: 'text', text, truncated: extra.truncated ?? false, size: text.length, mtimeMs: 1 }
  } as never)
}

function setMode(mode: 'table' | 'text'): void {
  handlers.onSetViewMode?.(mode as never)
}

function lastViewModes(): unknown[] | undefined {
  return calls.filter((c) => c.name === 'reportViewModes').at(-1)?.args
}

function cells(): string[][] {
  return [...root.querySelectorAll('.office-sheet tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')
  )
}

function editorHidden(): boolean {
  return root.querySelector<HTMLElement>('.editor')?.style.display === 'none'
}

function fire(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event
}

let root: HTMLElement
const added: Array<[string, EventListenerOrEventListenerObject]> = []

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  calls.length = 0
  editors = []
  for (const key of Object.keys(handlers)) delete handlers[key]
  const original = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: unknown, options?: unknown) => {
    added.push([type, listener as EventListenerOrEventListenerObject])
    original(type, listener as EventListener, options as boolean)
  })
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
  await import('../plugins/aios.text/viewer/main.js')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener)
})

describe('aios.text の .csv / .tsv (TODO 1215)', () => {
  it('開いたときは表。見出しに Table / Text の切替を知らせ、editor は隠す', () => {
    open('a.csv', 'name,qty\n"Tokyo, JP",1,200\n')
    expect(lastViewModes()).toEqual(['file:///tmp/a.csv', ['table', 'text'], 'table'])
    expect(cells()).toEqual([
      ['name', 'qty', ''],
      ['Tokyo, JP', '1', '200']
    ])
    expect(editorHidden()).toBe(true)
    // Cells that look like numbers are right-aligned.
    expect(root.querySelectorAll('.office-sheet td.num').length).toBe(2)
    // Between tables, no drop insertion is accepted.
    expect(calls.filter((c) => c.name === 'reportAcceptsEdits').at(-1)?.args).toEqual(['file:///tmp/a.csv', false])
  })

  it('切り替えても本文・下書きに触らない (reportDraft を呼ばない)', () => {
    open('a.csv', 'a,b\n1,2\n')
    setMode('text')
    expect(editorHidden()).toBe(false)
    expect(root.querySelector('.office-sheet')).toBeNull()
    expect(lastViewModes()).toEqual(['file:///tmp/a.csv', ['table', 'text'], 'text'])
    setMode('table')
    setMode('text')
    setMode('table')
    expect(calls.some((c) => c.name === 'reportDraft')).toBe(false)
    expect(editors).toHaveLength(1)
    expect(editors[0]!.value).toBe('a,b\n1,2\n')
    expect(editors[0]!.setValueCalls).toBe(0)
  })

  it('Text で書き換えた下書きが表に出る', () => {
    open('a.csv', 'a,b\n')
    setMode('text')
    // The user's keystrokes (the editor's onChange).
    editors[0]!.value = 'a,b\nx,"y\nz"\n'
    editors[0]!.onChange(editors[0]!.value)
    setMode('table')
    expect(cells()).toEqual([
      ['a', 'b'],
      ['x', 'y\nz']
    ])
  })

  it('host が覚えていた下書き (draft) を表に出す', () => {
    open('a.csv', 'disk,1\n', { draft: 'draft,2\n' })
    expect(cells()).toEqual([['draft', '2']])
  })

  it('最後に選んだ方を次の .csv でも使い、表にしないファイルでは切替を消す', () => {
    open('a.csv', 'a\n')
    setMode('text')
    open('b.tsv', 'x\ty\n')
    expect(lastViewModes()).toEqual(['file:///tmp/b.tsv', ['table', 'text'], 'text'])
    expect(root.querySelector('.office-sheet')).toBeNull()
    setMode('table')
    expect(cells()).toEqual([['x', 'y']])
    open('notes.txt', 'hello\n')
    expect(lastViewModes()).toEqual(['file:///tmp/notes.txt', [], 'text'])
    expect(root.querySelector('.office-sheet')).toBeNull()
    expect(editorHidden()).toBe(false)
    open('c.csv', 'p,q\n')
    expect(lastViewModes()).toEqual(['file:///tmp/c.csv', ['table', 'text'], 'table'])
    expect(cells()).toEqual([['p', 'q']])
  })

  it('同じファイルの送り直し (テーマ・言語) では表のまま、本文を置き換えない', () => {
    open('a.csv', 'a,b\n', { uri: 'file:///tmp/a.csv' })
    const first = revision
    handlers.onResource?.({
      uri: 'file:///tmp/a.csv',
      label: 'a.csv',
      editable: true,
      theme: 'dark',
      highlightQuery: null,
      draft: null,
      revision: first,
      editorKeys: null,
      resource: { kind: 'text', text: 'a,b\n', truncated: false, size: 4, mtimeMs: 1 }
    } as never)
    expect(cells()).toEqual([['a', 'b']])
    expect(editors[0]!.setValueCalls).toBe(0)
  })

  it('大きいファイルの先頭だけなら、途中で切れた最後の行は表に出さない', () => {
    open('big.csv', 'a,b\n1,2\n3,"cut', { truncated: true })
    expect(cells()).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(root.querySelector('.banner')).not.toBeNull()
  })

  it('空の .csv は表の代わりに注記', () => {
    open('empty.csv', '')
    expect(root.querySelector('.office-sheet')).toBeNull()
    expect(root.querySelector('.sheet-pane .message')).not.toBeNull()
  })

  it('大きな表は先頭の範囲だけ描き、続きを表示で広げる', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `${i},v${i}`).join('\n')
    open('many.csv', text)
    expect(cells()).toHaveLength(200)
    root.querySelector<HTMLButtonElement>('.office-sheet-more-rows')!.click()
    expect(cells()).toHaveLength(700)
  })

  it('行へのジャンプは Text に切り替えてから飛ぶ', () => {
    open('a.csv', 'a\nb\nc\n')
    handlers.onReveal?.({ uri: 'file:///tmp/a.csv', line: 3, column: null } as never)
    expect(editorHidden()).toBe(false)
    expect(editors[0]!.revealed).toEqual([3])
    expect(lastViewModes()).toEqual(['file:///tmp/a.csv', ['table', 'text'], 'text'])
  })

  it('行つきで開いた後に別の CSV を開くと表 (行へのジャンプは記憶を書き換えない、code-review Y5)', () => {
    open('a.csv', 'a\nb\nc\n')
    handlers.onReveal?.({ uri: 'file:///tmp/a.csv', line: 3, column: null } as never)
    expect(editorHidden()).toBe(false)
    // Re-sending the same file (theme / language) stays in Text.
    open('a.csv', 'a\nb\nc\n')
    expect(editorHidden()).toBe(false)
    expect(lastViewModes()).toEqual(['file:///tmp/a.csv', ['table', 'text'], 'text'])
    open('b.csv', 'x,y\n')
    expect(editorHidden()).toBe(true)
    expect(cells()).toEqual([['x', 'y']])
    expect(lastViewModes()).toEqual(['file:///tmp/b.csv', ['table', 'text'], 'table'])
  })

  it('利用者が Text を選んだら、行へのジャンプの後でも次の CSV は Text', () => {
    open('a.csv', 'a\nb\n')
    setMode('text')
    open('b.csv', 'x\ny\n')
    handlers.onReveal?.({ uri: 'file:///tmp/b.csv', line: 2, column: null } as never)
    open('c.csv', 'p,q\n')
    expect(editorHidden()).toBe(false)
    expect(lastViewModes()).toEqual(['file:///tmp/c.csv', ['table', 'text'], 'text'])
  })

  it('行へのジャンプで Text になった後に Text を押し直すと、それを利用者の選択として覚える', () => {
    open('a.csv', 'a\nb\n')
    handlers.onReveal?.({ uri: 'file:///tmp/a.csv', line: 2, column: null } as never)
    setMode('text')
    open('b.csv', 'x,y\n')
    expect(editorHidden()).toBe(false)
  })

  it('違う URI 宛ての reveal (前のファイル宛て) は無視する', () => {
    open('b.csv', 'x\ny\n')
    handlers.onReveal?.({ uri: 'file:///tmp/a.csv', line: 2, column: null } as never)
    expect(editorHidden()).toBe(true)
    expect(editors[0]!.revealed).toEqual([])
    expect(lastViewModes()).toEqual(['file:///tmp/b.csv', ['table', 'text'], 'table'])
  })

  it('表の ⌘F は文書内検索、Text では拾わない', () => {
    open('a.csv', 'apple,pear\nApple pie,1\n')
    expect(fire({ key: 'f', metaKey: true }).defaultPrevented).toBe(true)
    const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
    input.value = 'apple'
    input.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(300)
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(2)
    expect(root.querySelector('.doc-find-count')?.textContent).toBe('1 / 2')
    setMode('text')
    expect(root.querySelector('.doc-find')).toBeNull()
    expect(fire({ key: 'f', metaKey: true }).defaultPrevented).toBe(false)
  })

  it('.csv 以外は今までどおり (切替を出さない)', () => {
    open('main.ts', 'const a = 1\n')
    expect(calls.some((c) => c.name === 'reportViewModes')).toBe(false)
    expect(root.querySelector('.sheet-pane')).toBeNull()
    expect(editorHidden()).toBe(false)
  })
})
