/**
 * The state of in-thread search (TODO 496, ARCHITECTURE 5.1.7). Shared by the floating search window (`ThreadFind.tsx`) and the components that hold collapsed contents
 * (tool rows, plans, subagent blocks, thinking).
 *
 * - There is one window per ThreadPane. It stays open with the same terms even when the thread is switched (like VS Code's find widget,
 *   which remembers the terms when the editor changes). Closing keeps the terms, and the next open shows them fully selected.
 * - A collapsed block decides itself whether "there is a match in the hidden contents" and sets the mark (`data-find-pending`) (`useFindPending`).
 *   When the window advances to that block it issues `requestReveal(key)`, and the block sets its own open/closed state to "open" (the same as the user opening it -
 *   it is not put back when closed. Same as VS Code search leaving a collapsed range open).
 * - A different mechanism from `highlightEventId` (the frame of a row jumped to from Cmd+K, released after 4 seconds). The highlight uses `CSS.highlights`, and touches neither the DOM nor
 *   the auto-scroll decision.
 */
import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { findTerms, textHasMatch, type FindTerm } from './thread/find-text.js'
import { FIND_PENDING_ATTR } from './thread/find-dom.js'

const NO_TERMS: readonly FindTerm[] = []

interface ThreadFindState {
  /** Whether the window is shown. */
  readonly open: boolean
  /** The string in the field. */
  readonly query: string
  /** `query` turned into terms (`findTerms`). Kept even when the window is closed (components read it together with `open`). */
  readonly terms: readonly FindTerm[]
  /** The number of times the field should be focused and fully selected (advances on every Cmd+F / magnifier). */
  readonly focusSeq: number
  /** A request to open a collapsed block (key and count). */
  readonly reveal: { readonly key: string; readonly seq: number } | null
  show(): void
  close(): void
  setQuery(query: string): void
  requestReveal(key: string): void
}

export const useThreadFind = create<ThreadFindState>((set) => ({
  open: false,
  query: '',
  terms: NO_TERMS,
  focusSeq: 0,
  reveal: null,
  show(): void {
    set((state) => ({ open: true, focusSeq: state.focusSeq + 1 }))
  },
  close(): void {
    set({ open: false, reveal: null })
  },
  setQuery(query): void {
    set((state) => (state.query === query ? state : { query, terms: findTerms(query) }))
  },
  requestReveal(key): void {
    set((state) => ({ reveal: { key, seq: (state.reveal?.seq ?? 0) + 1 } }))
  }
}))

/** The terms only while the window is shown and there are terms (for components' selectors. Returns the same reference). */
export function activeFindTerms(state: Pick<ThreadFindState, 'open' | 'terms'>): readonly FindTerm[] {
  return state.open ? state.terms : NO_TERMS
}

/**
 * The entry point for components that hold collapsed contents (decision 5 of TODO 496). `hidden` is the **text that cannot be seen while collapsed** (a tool's arguments,
 * the plan body, a child's hidden messages...). If the window is shown, the block is collapsed (`shown` is false), and `hidden` has a match, it returns
 * the attribute to spread onto the root element (`data-find-pending`). When the window advances to this block it calls `onReveal` (the component opens itself).
 *
 * The caller must `useMemo` `hidden` (re-matching on every keystroke happens only when the terms change). The body of a tool's result
 * is not saved (constraint 10), so it does not match on rows after a restart - only what is at hand goes into `hidden`.
 */
export function useFindPending(
  key: string,
  hidden: string,
  shown: boolean,
  onReveal: () => void
): Record<string, string> {
  const terms = useThreadFind(activeFindTerms)
  const revealSeq = useThreadFind((state) => (state.reveal !== null && state.reveal.key === key ? state.reveal.seq : 0))
  const reveal = useRef(onReveal)
  reveal.current = onReveal
  // Open only when the number **changed**. The value at mount is an already-handled request (it stays until closed), so do not reopen
  // (it does not open even when you refold and go back and forth between threads - review 2026-10-06).
  const seen = useRef(revealSeq)
  useEffect(() => {
    if (revealSeq !== 0 && revealSeq !== seen.current) reveal.current()
    seen.current = revealSeq
  }, [revealSeq])
  const matched = useMemo(() => terms.length > 0 && textHasMatch(hidden, terms), [hidden, terms])
  return !shown && matched ? { [FIND_PENDING_ATTR]: key } : NO_ATTRS
}

const NO_ATTRS: Record<string, string> = {}

// ---- Dispatching Cmd+F (the keydown in `App.tsx`) ----

/** Whether the last press was inside ThreadPane (body text does not take focus, so just pressing leaves activeElement as body). */
let lastPointerInThread = false

/**
 * Whether the element is inside the real ThreadPane. Settings, scheduled runs, and extension details also appear in the same place with the class
 * `thread-pane settings-editor` (ThreadPane is hidden by CSS), so those are excluded (review 2026-10-06).
 */
function insideThreadPane(target: EventTarget | Element | null): boolean {
  if (target === null || typeof (target as Element).closest !== 'function') return false
  const pane = (target as Element).closest('.thread-pane')
  return pane !== null && !pane.classList.contains('settings-editor')
}

/** Attach once to the document (App.tsx). Returns the function that detaches it. */
export function installThreadPointerTracker(doc: Document = document): () => void {
  const onPointer = (event: Event): void => {
    lastPointerInThread = insideThreadPane(event.target)
  }
  doc.addEventListener('pointerdown', onPointer, true)
  return () => doc.removeEventListener('pointerdown', onPointer, true)
}

/**
 * Whether we are in ThreadPane now (including the Composer and the search window). If an element has focus, that decides; if not (body text was
 * just pressed), the last place pressed decides. If a viewer's iframe has focus, activeElement is the iframe (outside ThreadPane).
 */
export function threadPaneHasFocus(doc: Document = document): boolean {
  const active = doc.activeElement
  if (active !== null && active !== doc.body && active !== doc.documentElement) {
    return insideThreadPane(active)
  }
  return lastPointerInThread
}

/** For tests. */
export function setLastPointerInThreadForTest(value: boolean): void {
  lastPointerInThread = value
}

/** Where to return focus to on closing with Esc (where it was when opened). */
let returnFocus: HTMLElement | null = null

/** Opens with Cmd+F / the magnifier (if already shown, focuses the field and selects all again). */
export function openThreadFind(doc: Document = document): void {
  const active = doc.activeElement
  if (active instanceof HTMLElement && !active.classList.contains('thread-find-input') && active !== doc.body) {
    returnFocus = active
  }
  useThreadFind.getState().show()
}

/** Closes with the X / Esc. If `restoreFocus`, returns focus to where it was before opening (does nothing if it is gone). */
export function closeThreadFind(restoreFocus: boolean): void {
  useThreadFind.getState().close()
  const target = returnFocus
  returnFocus = null
  if (restoreFocus && target !== null && target.isConnected) target.focus()
}
