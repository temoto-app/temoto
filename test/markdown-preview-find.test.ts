/**
 * @vitest-environment jsdom
 *
 * `aios.markdown` Preview's in-document search (TODO 1110): ⌘F opens a bar that counts the matches; switching to Source closes it.
 * It uses the same `<mark>` as the host's search-term highlight (TODO 445), so while the bar is open the host's highlight is removed, and it is restored when the bar closes.
 * It reads the viewer's entry point (`main.ts`) as it is, replacing only the bridge and the editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: never) => void
const handlers: Record<string, Handler> = {}

vi.mock('../plugins/_shared/bridge.js', () => ({
  connect: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === 'runCommand') return () => Promise.resolve([])
          if (name.startsWith('on'))
            return (h: Handler) => void (handlers[name] = h)
          return () => undefined
        },
      },
    ),
}))
vi.mock('../plugins/_shared/editor.js', () => ({
  createEditor: () => ({
    destroy: () => undefined,
    setHighlight: () => undefined,
    revealLine: () => undefined,
  })
}))

function fire(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(event)
  return event
}

function resource(highlightQuery: string | null): void {
  handlers.onResource?.({
    uri: 'file:///a.md',
    editable: true,
    theme: 'light',
    highlightQuery,
    draft: null,
    resource: {
      kind: 'text',
      text: '# Title\n\nAlpha beta\n\ngamma alpha\n',
      revision: 'r1',
    },
  } as never)
}

let root: HTMLElement
// Each time resetModules rebuilds it, main.ts adds a keydown to document, so the ones from the previous test are removed.
const added: Array<[string, EventListenerOrEventListenerObject]> = []

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  const original = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: unknown, options?: unknown) => {
    added.push([type, listener as EventListenerOrEventListenerObject])
    original(type, listener as EventListener, options as boolean)
  })
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
  await import('../plugins/aios.markdown/viewer/main.js')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener)
})

function typeQuery(value: string): void {
  const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  vi.advanceTimersByTime(300)
}

function escape(): void {
  root
    .querySelector('.doc-find-input')!
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
}

describe('aios.markdown Preview の文書内検索', () => {
  it('⌘F で窓が出て、一致を数え、Esc で光りが消える', () => {
    resource(null)
    expect(root.querySelector('.doc-find')).toBeNull()
    expect(fire({ key: 'f', metaKey: true }).defaultPrevented).toBe(true)
    expect(root.querySelector('.doc-find')).not.toBeNull()
    typeQuery('alpha')
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(2)
    expect(root.querySelector('.doc-find-count')?.textContent).toBe('1 / 2')
    escape()
    expect(root.querySelector('.doc-find')).toBeNull()
    expect(root.querySelector('mark')).toBeNull()
  })

  it('host の検索語の光りと両方出ても壊れない (開く間は外れ、閉じると戻る)', () => {
    resource('beta')
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(1)
    fire({ key: 'f', metaKey: true })
    expect(root.querySelector('mark')).toBeNull()
    typeQuery('alpha')
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(2)
    escape()
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(1)
    expect(root.querySelector('mark')?.textContent?.toLowerCase()).toBe('beta')
  })

  it('Source に切り替えると窓が閉じ、Source では ⌘F を拾わない', () => {
    resource(null)
    fire({ key: 'f', metaKey: true })
    typeQuery('alpha')
    handlers.onSetViewMode?.('source' as never)
    expect(root.querySelector('.doc-find')).toBeNull()
    expect(fire({ key: 'f', metaKey: true }).defaultPrevented).toBe(false)
    expect(root.querySelector('.doc-find')).toBeNull()
  })

  it('閉じて host の光りを戻すとき、中央へ飛ばさず今の一致の番号を保つ (1110 review 1・10)', () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled as never
    resource('alpha')
    const buttons = root.querySelectorAll<HTMLButtonElement>('.hit-nav-btn')
    buttons[buttons.length - 1]!.click() // Next: 2 / 2
    expect(root.querySelector('.hit-nav-pos')?.textContent).toContain('2')
    fire({ key: 'f', metaKey: true })
    typeQuery('beta')
    scrolled.mockClear()
    escape()
    expect(scrolled).not.toHaveBeenCalled()
    const marks = [...root.querySelectorAll('mark.cm-searchHit')]
    expect(marks.length).toBe(2)
    expect(marks[1]!.classList.contains('cm-searchHit-current')).toBe(true)
    expect(marks[0]!.classList.contains('cm-searchHit-current')).toBe(false)
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
})
