/**
 * @vitest-environment jsdom
 *
 * `aios.office` document search (TODO 819): the window (`dom-find.ts`) highlights matches in a DOM that looks like docx / xlsx, cycles with Enter / Shift+Enter,
 * clears the highlights with Esc, and after a redraw (`refresh`) matches the same word again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomFind, isFindKey } from '../plugins/_shared/dom-find.js'

function key(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

let root: HTMLElement

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
})

function renderDoc(): void {
  root.textContent = ''
  const body = document.createElement('div')
  body.className = 'office-doc'
  body.innerHTML = '<p>Alpha beta</p><p>gamma alpha</p><table><tr><td>ALPHA</td><td>delta</td></tr></table>'
  root.append(body)
}

function typeQuery(value: string): void {
  const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  vi.advanceTimersByTime(300)
}

describe('isFindKey', () => {
  it('accepts Cmd+F and Ctrl+F only', () => {
    expect(isFindKey(key({ key: 'f', metaKey: true }))).toBe(true)
    expect(isFindKey(key({ key: 'F', ctrlKey: true }))).toBe(true)
    expect(isFindKey(key({ key: 'f' }))).toBe(false)
    expect(isFindKey(key({ key: 'f', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isFindKey(key({ key: 'f', metaKey: true, altKey: true }))).toBe(false)
    expect(isFindKey(key({ key: 'g', metaKey: true }))).toBe(false)
  })
})

describe('createDomFind', () => {
  const make = () =>
    createDomFind({ host: root, target: () => root.querySelector<HTMLElement>('.office-doc, .office-sheet-scroll') })

  it('opens on Cmd+F and highlights case-insensitively across blocks and table cells', () => {
    renderDoc()
    const find = make()
    expect(find.handleKey(key({ key: 'f', metaKey: true }))).toBe(true)
    expect(find.isOpen()).toBe(true)
    expect(root.firstElementChild?.classList.contains('doc-find')).toBe(true)
    typeQuery('alpha')
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(3)
    expect(find.position()).toEqual({ index: 1, count: 3 })
    expect(root.querySelector('.doc-find-count')?.textContent).toBe('1 / 3')
  })

  it('treats the whole input as one literal phrase', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('Alpha beta')
    expect(find.position().count).toBe(1)
    typeQuery('beta alpha')
    expect(find.position().count).toBe(0)
    expect(root.querySelector('.doc-find-count')?.textContent).not.toBe('')
  })

  it('Enter steps forward and wraps, Shift+Enter goes back and wraps', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('alpha')
    const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
    input.dispatchEvent(key({ key: 'Enter' }))
    expect(find.position().index).toBe(2)
    input.dispatchEvent(key({ key: 'Enter' }))
    input.dispatchEvent(key({ key: 'Enter' }))
    expect(find.position().index).toBe(1)
    input.dispatchEvent(key({ key: 'Enter', shiftKey: true }))
    expect(find.position().index).toBe(3)
  })

  it('Escape closes, removes the marks and restores the text', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('alpha')
    root.querySelector('.doc-find-input')!.dispatchEvent(key({ key: 'Escape' }))
    expect(find.isOpen()).toBe(false)
    expect(root.querySelector('.doc-find')).toBeNull()
    expect(root.querySelector('mark')).toBeNull()
    expect(root.querySelector('.office-doc')?.textContent).toBe('Alpha betagamma alphaALPHAdelta')
  })

  it('refresh after a re-render puts the bar back and re-applies the same query', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('delta')
    renderDoc() // host cleared the root
    expect(root.querySelector('.doc-find')).toBeNull()
    find.refresh()
    expect(root.firstElementChild?.classList.contains('doc-find')).toBe(true)
    expect(find.position()).toEqual({ index: 1, count: 1 })
    expect(root.querySelectorAll('mark.cm-searchHit').length).toBe(1)
  })

  it('refresh is a no-op while closed', () => {
    renderDoc()
    const find = make()
    find.refresh()
    expect(root.querySelector('.doc-find')).toBeNull()
  })

  it('works on an xlsx-like scroll container', () => {
    root.innerHTML =
      '<div class="office-sheet-scroll"><table><tbody><tr><td>apple</td><td>pear</td></tr><tr><td>Apple pie</td><td>1</td></tr></tbody></table></div>'
    const find = make()
    find.open()
    typeQuery('apple')
    expect(find.position().count).toBe(2)
  })

  it('has a single navigation UI (no floating hit-nav box) and the count stays in sync', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('alpha')
    expect(root.querySelector('.hit-nav')).toBeNull()
    root.querySelector<HTMLInputElement>('.doc-find-input')!.dispatchEvent(key({ key: 'Enter' }))
    expect(root.querySelector('.doc-find-count')?.textContent).toBe('2 / 3')
  })

  it('refresh keeps the current hit, does not scroll and does not steal focus', () => {
    renderDoc()
    const find = make()
    find.open()
    typeQuery('alpha')
    const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
    input.dispatchEvent(key({ key: 'Enter' }))
    expect(find.position().index).toBe(2)
    const bar = root.querySelector('.doc-find')!
    renderDoc()
    root.prepend(bar)
    const scrolled = vi.fn()
    for (const el of Array.from(root.querySelectorAll('mark, p, td'))) (el as HTMLElement).scrollIntoView = scrolled
    input.focus()
    find.refresh()
    for (const el of Array.from(root.querySelectorAll('mark'))) (el as HTMLElement).scrollIntoView = scrolled
    expect(find.position()).toEqual({ index: 2, count: 3 })
    expect(root.querySelector('.doc-find-count')?.textContent).toBe('2 / 3')
    expect(scrolled).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('debounces typing: one scan per pause', () => {
    renderDoc()
    const find = make()
    find.open()
    const input = root.querySelector<HTMLInputElement>('.doc-find-input')!
    for (const v of ['a', 'al', 'alp', 'alph', 'alpha']) {
      input.value = v
      input.dispatchEvent(new Event('input'))
    }
    expect(root.querySelector('mark')).toBeNull()
    vi.advanceTimersByTime(300)
    expect(find.position().count).toBe(3)
  })
})
