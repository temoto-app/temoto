/**
 * The renderer side of English-letter input for search fields (TODO 463, ARCHITECTURE 4.5.11). It only tells main
 * **whether a search field in this window has focus** (`window.aios.input.asciiForSearch(focused)`). Whether to switch and
 * when to switch back (grace period, setting, whether it is macOS) is main's decision.
 *
 * - Target fields are decided by a marker (`ASCII_INPUT`, `@shared/ascii-input.js`). Instead of writing focus / blur per field, the
 *   document-wide `focusin` / `focusout` are watched in one place (`installAsciiInputTracker`, called once from `main.tsx`).
 * - For the ⌘F field inside a viewer (a sandbox iframe), the bridge reports `search-focus`. ViewerPane passes it here through
 *   `setViewerSearchFocus(key, focused)`, and it is folded into one per-window "some field has focus".
 * - When the window loses focus (another app / another window), this window's share is cleared. On return, the focused field is checked again.
 * - A field can vanish from the DOM while holding focus without a `focusout`, so on the next `focusin` / key / click
 *   `document.activeElement` is checked again.
 */
import { ASCII_INPUT_SELECTOR } from '@shared/ascii-input.js'

/** Folds "does a search field have focus" for one window (independent of the DOM. `test/ascii-input.test.ts`). */
export class SearchFocusAggregator {
  private local = false
  private readonly viewers = new Set<string>()
  private reported = false

  constructor(private readonly send: (focused: boolean) => void) {}

  /** A field in the renderer's document. */
  setLocal(focused: boolean): void {
    this.local = focused
    this.flush()
  }

  /** A field inside a viewer (iframe). `key` is per ViewerPane. */
  setViewer(key: string, focused: boolean): void {
    if (focused) this.viewers.add(key)
    else this.viewers.delete(key)
    this.flush()
  }

  /** The window lost focus. Clear everything (the iframe's blur notification arrives late, or may not arrive). */
  clear(): void {
    this.local = false
    this.viewers.clear()
    this.flush()
  }

  get focused(): boolean {
    return this.local || this.viewers.size > 0
  }

  private flush(): void {
    const next = this.focused
    if (next === this.reported) return
    this.reported = next
    this.send(next)
  }
}

let aggregator: SearchFocusAggregator | null = null

/** Whether it is a target field. */
export function isAsciiInputTarget(target: EventTarget | null): boolean {
  const element = target as { matches?: unknown } | null
  return typeof element?.matches === 'function' && (target as Element).matches(ASCII_INPUT_SELECTOR)
}

/** Focus of the search field inside a viewer (ViewerPane calls this on receiving the bridge's `search-focus`). */
export function setViewerSearchFocus(key: string, focused: boolean): void {
  aggregator?.setViewer(key, focused)
}

/**
 * Watches focus over the whole document. Call it once (later calls do nothing). The return value removes it (for tests).
 */
export function installAsciiInputTracker(
  send: (focused: boolean) => void,
  win: Window = window
): () => void {
  if (aggregator !== null) return () => undefined
  const current = new SearchFocusAggregator(send)
  aggregator = current
  const doc = win.document
  const recheck = (): void => {
    current.setLocal(win.document.hasFocus() && isAsciiInputTarget(doc.activeElement))
  }
  const onFocusIn = (event: FocusEvent): void => {
    current.setLocal(isAsciiInputTarget(event.target))
  }
  const onFocusOut = (event: FocusEvent): void => {
    // Moving from field to field gives `focusin` right after `focusout` (main's grace period absorbs the flicker).
    if (isAsciiInputTarget(event.target)) current.setLocal(false)
  }
  const onBlur = (): void => current.clear()
  const onFocus = (): void => recheck()
  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('pointerdown', recheck, true)
  doc.addEventListener('keydown', recheck, true)
  win.addEventListener('blur', onBlur)
  win.addEventListener('focus', onFocus)
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('pointerdown', recheck, true)
    doc.removeEventListener('keydown', recheck, true)
    win.removeEventListener('blur', onBlur)
    win.removeEventListener('focus', onFocus)
    current.clear()
    if (aggregator === current) aggregator = null
  }
}
