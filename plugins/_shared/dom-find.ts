/**
 * In-document search over the rendered DOM (TODO 819, docx / xlsx of `aios.office`).
 *
 * Cmd+F (Ctrl+F) shows a find box at the top, and on each keystroke the matches in the body are highlighted with `<mark class="cm-searchHit">` from `dom-highlight.ts`
 * (the same look and box as aios.markdown's Preview). Enter / Shift+Enter goes to the next / previous (wrapping at the ends), and Esc closes and removes the highlight.
 *
 * - The host does not send Cmd+F back to the viewer (`isEditorFind`; Cmd+F inside a viewer belongs to the viewer itself). So the viewer picks it up in its own
 *   keydown. On mac, Ctrl+F is in the table the host sends back as "body search" and is taken in the capture phase (bridge.ts), so it never arrives here.
 * - Whenever the host redraws (`root.textContent = ''`), both the box and the highlights disappear. Calling `refresh()` after a redraw re-applies the box with
 *   the same query if it is open and keeps the current match number (it moves neither scroll nor focus).
 * - The input field is an ASCII-input target (Latin letters can be typed even if the IME is still in Japanese mode).
 */
import { ASCII_INPUT_ATTRIBUTE } from '@shared/ascii-input.js'
import { createDomHits, type DomHits } from './dom-highlight.js'
import { vt } from './i18n.js'

export interface DomFindOptions {
  /** The element that holds the box and the hits (a vertical flex with position: relative). */
  readonly host: HTMLElement
  /** The body to highlight (the scrolling element). null if there is none right now. */
  readonly target: () => HTMLElement | null
  /** Called after the box is closed and the highlight removed (so a viewer that has a different highlight on the same body, such as the host's query highlight, can restore it. TODO 1110). */
  readonly onClose?: () => void
}

export interface DomFind {
  /** Opens the box and focuses the input field. */
  open(): void
  close(): void
  isOpen(): boolean
  /** Called after the host redraws the contents. */
  refresh(): void
  /** Returns true if it picked up Cmd+F / Ctrl+F (the caller does preventDefault). */
  handleKey(event: KeyboardEvent): boolean
  /** The number of matches and the current match (for tests). */
  position(): { readonly index: number; readonly count: number }
}

/** Cmd+F or Ctrl+F (without Shift or Alt). Not picked up during IME composition. */
export function isFindKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing'>
): boolean {
  if (event.isComposing || event.shiftKey || event.altKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  return event.key.toLowerCase() === 'f'
}

/** Wait so that all text nodes are not rescanned on every keystroke. */
const FIND_DEBOUNCE_MS = 120

export function createDomFind(options: DomFindOptions): DomFind {
  const { host } = options
  const doc = host.ownerDocument
  let opened = false
  let query = ''
  let hits: DomHits | null = null
  let hitsBody: HTMLElement | null = null
  // Whether the input field had focus. So refresh can restore focus lost when the box was detached by a redraw (a blur after detaching is not counted).
  let focused = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const bar = doc.createElement('div')
  bar.className = 'toolbar doc-find'
  bar.setAttribute('role', 'search')
  const input = doc.createElement('input')
  input.type = 'search'
  input.className = 'doc-find-input'
  input.setAttribute(ASCII_INPUT_ATTRIBUTE, '')
  const count = doc.createElement('span')
  count.className = 'doc-find-count'
  const button = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = text
    // Pressing does not steal focus from the input field.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', onClick)
    return b
  }
  const prev = button('↑', () => move(-1))
  const next = button('↓', () => move(1))
  const closeButton = button('✕', () => api.close())
  bar.append(input, count, prev, next, closeButton)

  const labels = (): void => {
    input.placeholder = vt('findInDocument')
    input.setAttribute('aria-label', vt('findInDocument'))
    for (const [b, key] of [
      [prev, 'hitPrev'],
      [next, 'hitNext'],
      [closeButton, 'findClose']
    ] as const) {
      b.title = vt(key)
      b.setAttribute('aria-label', vt(key))
    }
  }

  const updateCount = (): void => {
    const { index, count: total } = hits?.position() ?? { index: 0, count: 0 }
    if (query.trim() === '') count.textContent = ''
    else count.textContent = total === 0 ? vt('findNone') : `${index} / ${total}`
  }

  const dropHits = (): void => {
    hits?.destroy()
    hits = null
    hitsBody = null
  }

  /**
   * Re-apply. For the same body, re-apply to the existing DomHits (nav and observers are not rebuilt). With `keep`, the current match number is kept and
   * neither scrolling nor focus moves (after a redraw. TODO 828).
   */
  const run = (keep = false): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const body = options.target()
    if (body === null || !opened) {
      dropHits()
      updateCount()
      return
    }
    const index = keep ? hits?.position().index : undefined
    if (hits === null || hitsBody !== body) {
      dropHits()
      // The only navigation UI is the find box's own (no floating box).
      hits = createDomHits(body, host, { nav: false })
      hitsBody = body
    }
    hits.apply(query, {
      literal: true,
      ...(keep ? { scroll: false, ...(index !== undefined && index > 0 ? { keepIndex: index } : {}) } : {})
    })
    updateCount()
  }

  function move(dir: 1 | -1): void {
    if (hits === null) return
    const { index, count: total } = hits.position()
    if (total === 0) return
    if (dir === 1) hits.step(index >= total ? 'first' : 'next')
    else hits.step(index <= 1 ? 'last' : 'prev')
    updateCount()
  }

  input.addEventListener('focus', () => {
    focused = true
  })
  input.addEventListener('blur', () => {
    if (bar.isConnected) focused = false
  })
  input.addEventListener('input', () => {
    query = input.value
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => run(), FIND_DEBOUNCE_MS)
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (timer !== null) run() // apply the term being typed first
      move(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      api.close()
    }
  })

  const api: DomFind = {
    open() {
      opened = true
      labels()
      if (bar.parentElement !== host) host.prepend(bar)
      input.focus()
      input.select()
      run()
    },
    close() {
      if (!opened) return
      opened = false
      if (timer !== null) clearTimeout(timer)
      timer = null
      hits?.apply(null) // remove the highlight
      dropHits()
      bar.remove()
      query = ''
      input.value = ''
      count.textContent = ''
      options.onClose?.()
    },
    isOpen: () => opened,
    refresh() {
      if (!opened) return
      labels()
      host.prepend(bar)
      run(true)
      if (focused && doc.activeElement !== input) input.focus({ preventScroll: true })
    },
    handleKey(event) {
      if (!isFindKey(event)) return false
      api.open()
      return true
    },
    position: () => hits?.position() ?? { index: 0, count: 0 }
  }
  return api
}
