/**
 * The list of symbols in a file (TODO 468, wave 23 bundle F, ARCHITECTURE.md 7.4.3.2). Cmd+R (Ctrl+R) or the ViewerPane heading button
 * (the host's `open-symbols`) shows a filterable list over the editor. Look and operation match the Cmd+P candidates
 * (the renderer's Quick Open, TODO 357): type to filter, Up / Down (wrapping at the ends) and Enter to jump, Esc to close, clicking outside closes it.
 *
 * - The list is ordinary DOM inside the viewer (centered at the top edge of `.cm-editor`). The plugin boundary (constraint 8) forbids importing the renderer's
 *   `list-keys.ts`, so a small implementation in the same style (`pickerKeyStep` / `pickerKey`) is kept here.
 * - The jump target is the characters of the name, at the vertical center (the same `scrollIntoView(…, { y: 'center' })` as 431 / 273). The cursor is placed there,
 *   so if it is inside a fold CodeMirror unfolds it (467).
 * - Extracting symbols is in `symbols.ts`. If the language has no table the list does not open and the host is told "none" (the heading button is not shown).
 */
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { ASCII_INPUT_ATTRIBUTE } from '@shared/ascii-input.js'
import { vt } from './i18n.js'
import {
  collectSymbols,
  filterSymbols,
  languageNameOf,
  supportsSymbols,
  type DocSymbol,
  type SymbolKind,
  type SymbolResult
} from './symbols.js'

/** Number of rows moved by PageUp / PageDown. */
export const PICKER_PAGE = 10

/** Upper limit on rows drawn at once (so the keys of a 5000-entry JSON are not redrawn on every keystroke). Filtering reveals the rest. */
export const PICKER_MAX_ROWS = 300

/**
 * The next position (Quick Open style of the renderer's `listKeyStep`: Up / Down wrap at the ends, PageUp / PageDown stop at the ends).
 * null for keys not handled and for an empty list.
 */
export function pickerKeyStep(key: string, index: number, length: number): number | null {
  if (length <= 0) return null
  const placed = index >= 0 && index < length
  switch (key) {
    case 'ArrowDown':
      return !placed ? 0 : index + 1 < length ? index + 1 : 0
    case 'ArrowUp':
      return !placed ? length - 1 : index > 0 ? index - 1 : length - 1
    case 'PageDown':
      return !placed ? 0 : Math.min(length - 1, index + PICKER_PAGE)
    case 'PageUp':
      return !placed ? 0 : Math.max(0, index - PICKER_PAGE)
    default:
      return null
  }
}

/** The keydown fields read by `pickerKey`. */
export interface PickerKeyEvent {
  readonly key: string
  readonly keyCode?: number
  readonly isComposing?: boolean
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}

/**
 * The key to treat as a list operation (the same decision as the renderer's `navKey`). null during IME composition (including keyCode 229) and
 * with modifier keys - so the composition candidates' Up / Down and the confirming Enter do not move the list.
 */
export function pickerKey(event: PickerKeyEvent): string | null {
  if (event.isComposing === true || event.keyCode === 229) return null
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true || event.shiftKey === true) return null
  return event.key
}

/** The kind marker (one character). Colors are per `data-group` in viewer.css (syntax-color variables). */
const KIND_GLYPH: Readonly<Record<SymbolKind, string>> = {
  function: 'ƒ',
  method: 'm',
  class: 'C',
  struct: 'S',
  interface: 'I',
  enum: 'E',
  type: 'T',
  namespace: '{}',
  impl: 'i',
  variable: 'v',
  constant: 'c',
  property: 'p',
  key: 'k',
  selector: '#',
  macro: '#'
}

const KIND_GROUP: Readonly<Record<SymbolKind, 'function' | 'type' | 'variable' | 'other'>> = {
  function: 'function',
  method: 'function',
  class: 'type',
  struct: 'type',
  interface: 'type',
  enum: 'type',
  type: 'type',
  impl: 'type',
  namespace: 'other',
  macro: 'other',
  selector: 'other',
  variable: 'variable',
  constant: 'variable',
  property: 'variable',
  key: 'variable'
}

export interface SymbolPicker {
  readonly element: HTMLDivElement
  /** Opens the list. If the language has no table, does not open and returns false. */
  open(): boolean
  /** Closes. With `refocus`, returns focus to the editor (Esc). */
  close(refocus: boolean): void
  isOpen(): boolean
}

/** The contents shown in the list (built by `collect` on every open). */
export interface ListPickerContent<T> {
  readonly items: readonly T[]
  /** The row to highlight on opening (an index in the order before filtering). Omitted = the first. */
  readonly initial?: number
  /** The notice above the list (`total` is the total count, `shown` is the count after filtering). Not shown if empty. */
  note(total: number, shown: number): string
}

/**
 * The contents and drawing of a filterable list (shared by TODO 468's symbol list and TODO 692's assignments-and-uses list). Building the DOM and
 * the operation (type to filter, Up / Down, Enter, Esc, closing on a click outside) belong to `createListPicker`.
 */
export interface ListPickerSource<T> {
  /** Called when opening. If null, it does not open. */
  collect(): ListPickerContent<T> | null
  filter(items: readonly T[], query: string): T[]
  /** Draws the contents of one row into `row` (`li.symbol-picker-item`). `filtered` tells whether a filter is active. */
  renderRow(row: HTMLLIElement, item: T, filtered: boolean): void
  /** The position to jump to when chosen. */
  positionOf(item: T): number
  placeholder(): string
  label(): string
  /** A class to add to the list element (to swap the look). */
  readonly className?: string
}

/** The DOM and operation of a filterable list. Mounted on the `.cm-editor` of `view`. */
export function createListPicker<T>(view: EditorView, source: ListPickerSource<T>): SymbolPicker {
  const doc = view.dom.ownerDocument
  const element = doc.createElement('div')
  element.className = source.className === undefined ? 'symbol-picker' : `symbol-picker ${source.className}`
  element.hidden = true
  element.setAttribute('role', 'dialog')
  const input = doc.createElement('input')
  input.type = 'text'
  input.className = 'symbol-picker-input'
  input.spellcheck = false
  input.autocomplete = 'off'
  // This is a search / filter field, so it is an ASCII-input target (TODO 463). The bridge's watcher sees this marker and tells the host.
  input.setAttribute(ASCII_INPUT_ATTRIBUTE, '')
  const note = doc.createElement('div')
  note.className = 'symbol-picker-note'
  const list = doc.createElement('ul')
  list.className = 'symbol-picker-list'
  list.setAttribute('role', 'listbox')
  element.append(input, note, list)
  view.dom.append(element)

  let content: ListPickerContent<T> | null = null
  let shown: T[] = []
  let active = 0

  const markActive = (): void => {
    list.querySelectorAll('.symbol-picker-item').forEach((row, i) => {
      const on = i === active
      row.classList.toggle('active', on)
      row.setAttribute('aria-selected', on ? 'true' : 'false')
      if (on) (row as HTMLElement).scrollIntoView?.({ block: 'nearest' })
    })
  }

  const render = (): void => {
    if (content === null) return
    const filtered = input.value.trim() !== ''
    const all = source.filter(content.items, input.value)
    // The window is chosen out of `all` so that it contains `active` (the index, before filtering, that may point at the cursor's occurrence) (code review
    // of TODO 692): when the list is long (`MAX_REFERENCES` etc.) and exceeds PICKER_MAX_ROWS, always cutting from the start dropped
    // the cursor's row out of the window, and Enter jumped to an unrelated row.
    const start =
      all.length > PICKER_MAX_ROWS
        ? Math.min(Math.max(0, active - Math.floor(PICKER_MAX_ROWS / 2)), all.length - PICKER_MAX_ROWS)
        : 0
    shown = all.slice(start, start + PICKER_MAX_ROWS)
    active = shown.length === 0 ? -1 : Math.min(Math.max(0, active - start), shown.length - 1)
    list.textContent = ''
    for (const [i, item] of shown.entries()) {
      const row = doc.createElement('li')
      row.className = 'symbol-picker-item'
      row.setAttribute('role', 'option')
      row.dataset.index = String(i)
      source.renderRow(row, item, filtered)
      list.append(row)
    }
    const message = content.note(content.items.length, shown.length)
    note.textContent = message
    note.hidden = message === ''
    markActive()
  }

  const close = (refocus: boolean): void => {
    if (element.hidden) return
    element.hidden = true
    content = null
    shown = []
    list.textContent = ''
    if (refocus) view.focus()
  }

  const pick = (index: number): void => {
    const item = shown[index]
    if (item === undefined) return
    close(false)
    const at = Math.min(source.positionOf(item), view.state.doc.length)
    view.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: 'center' }),
      userEvent: 'select'
    })
    view.focus()
  }

  input.addEventListener('input', () => {
    active = 0
    render()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const key = pickerKey(event)
    if (key === null) return
    if (key === 'Enter') {
      event.preventDefault()
      pick(active)
      return
    }
    const next = pickerKeyStep(key, active, shown.length)
    if (next === null) return
    event.preventDefault()
    active = next
    markActive()
  })
  // Pressing does not steal the input field's focus (so it does not trigger the "close when leaving" check).
  list.addEventListener('mousedown', (event) => event.preventDefault())
  list.addEventListener('click', (event) => {
    const row = (event.target as Element | null)?.closest?.('.symbol-picker-item') as HTMLElement | null
    if (row?.dataset.index !== undefined) pick(Number(row.dataset.index))
  })
  list.addEventListener('mousemove', (event) => {
    const row = (event.target as Element | null)?.closest?.('.symbol-picker-item') as HTMLElement | null
    const index = row?.dataset.index === undefined ? -1 : Number(row.dataset.index)
    if (index >= 0 && index !== active) {
      active = index
      markActive()
    }
  })
  // Close when focus leaves the list (same as Quick Open).
  element.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null
    if (next !== null && element.contains(next)) return
    close(false)
  })

  return {
    element,
    open() {
      const collected = source.collect()
      if (collected === null) return false
      content = collected
      // The window is not cut here yet (`render` takes a window of `all.length` that contains `active`).
      active = Math.max(0, collected.initial ?? 0)
      input.value = ''
      input.placeholder = source.placeholder()
      input.setAttribute('aria-label', source.label())
      list.setAttribute('aria-label', source.label())
      element.hidden = false
      render()
      input.focus()
      return true
    },
    close,
    isOpen() {
      return !element.hidden
    }
  }
}

/** The DOM and operation of the symbol list. Mounted on the `.cm-editor` of `view`. */
export function createSymbolPicker(view: EditorView, collect: () => SymbolResult | null = () => collectSymbols(view.state)): SymbolPicker {
  const doc = view.dom.ownerDocument
  return createListPicker<DocSymbol>(view, {
    collect() {
      const result = collect()
      if (result === null) return null
      return {
        items: result.symbols,
        note: (total, shown) =>
          total === 0 ? vt('symbolsNone') : shown === 0 ? vt('symbolsNoMatch') : result.partial ? vt('symbolsPartial') : ''
      }
    },
    filter: filterSymbols,
    renderRow(row, symbol, filtered) {
      // While not filtering, show nesting by indentation (close to VS Code's Outline).
      if (!filtered) row.style.paddingLeft = `${8 + Math.min(symbol.depth, 8) * 12}px`
      const kind = doc.createElement('span')
      kind.className = 'symbol-kind'
      kind.dataset.group = KIND_GROUP[symbol.kind]
      kind.textContent = KIND_GLYPH[symbol.kind]
      const name = doc.createElement('span')
      name.className = 'symbol-name'
      name.textContent = symbol.name
      row.append(kind, name)
      if (symbol.container !== null) {
        const container = doc.createElement('span')
        container.className = 'symbol-container'
        container.textContent = symbol.container
        row.append(container)
      }
      const line = doc.createElement('span')
      line.className = 'symbol-line'
      line.textContent = String(symbol.line)
      row.append(line)
    },
    positionOf: (symbol) => symbol.from,
    placeholder: () => vt('symbolsPlaceholder'),
    label: () => vt('symbolsLabel')
  })
}

export interface SymbolNav {
  /** The editor extension (the Cmd+R / Ctrl+R key, and the notification when the language changes). Push it onto `createEditor`'s array. */
  readonly extension: Extension
  /** Called once after the view exists. Mounts the list DOM on `.cm-editor`. */
  mount(view: EditorView): void
  /** Opens the list (the host's heading button). false if it cannot be opened. */
  open(): boolean
  destroy(): void
}

/**
 * Entry point of the symbol list (TODO 468). `onAvailable` is passed "whether this language has a symbol table" every time the language configuration changes
 * (a language pack arrived, another file) - the host shows or hides the heading button based on it. Switching between files of the same language
 * also re-applies the language pack (`loadLanguage` in `editor.ts`), so it is re-reported each time.
 */
export function createSymbolNav(onAvailable: (available: boolean) => void): SymbolNav {
  let picker: SymbolPicker | null = null
  const open = (): boolean => picker?.open() ?? false
  return {
    extension: [
      // Cmd+R (mac) / Ctrl+R. Ctrl+R on mac is the same (aios keys follow the metaKey || ctrlKey convention).
      // Even for a language with no symbols it returns true, so the default action (reload) is not run.
      keymap.of([
        { key: 'Mod-r', run: () => (open(), true), preventDefault: true },
        { mac: 'Ctrl-r', run: () => (open(), true), preventDefault: true }
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) picker?.close(false)
        if (update.transactions.some((tr) => tr.reconfigured)) {
          onAvailable(supportsSymbols(languageNameOf(update.state)))
        }
      })
    ],
    mount(view) {
      picker = createSymbolPicker(view)
    },
    open,
    destroy() {
      picker?.element.remove()
      picker = null
    }
  }
}
