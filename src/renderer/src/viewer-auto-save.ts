/**
 * Viewer auto-save (TODO 555, wave 28 bundle D, ARCHITECTURE 5.2.2): the decision logic and the focus watcher.
 *
 * The clock and the decision live in the host (ViewerPane); the plugin is unchanged. The save itself is the existing `doSave` (the same entry
 * point as the heading's "Save" - it passes the base mtime to `viewer.write`, so if the disk side changed, main refuses with `conflict`).
 *
 *   - `afterDelay`: re-arms the timer every time the draft changes, and saves once it has been quiet for `delayMs`.
 *   - `onFocusChange`: saves when the viewer (iframe) loses focus. The iframe is a separate origin (OOPIF) and focus
 *     events inside it do not reach the parent, so it is detected through the parent window's `blur` (= focus entered the iframe), the
 *     following parent `focusin` / `focus` (= moved elsewhere in the parent), and the whole window losing focus (watching `document.hasFocus()`).
 *   - In both modes, **when moving to another file or closing the pane**, an unsaved draft is saved in the background if there is one
 *     (VS Code keeps saving dirty buffers in the background. aios writes what it remembered in the drafts table, TODO 312).
 *
 * Out of scope: viewers that accept no edits (read-only, truncated, image, PDF etc. - `editable` is false) and temporary views (`aios.diff`;
 * `TransientViewerPane` has no save entry point). It also does not save while the draft-conflict band is shown (use "Overwrite and save" on the band).
 *
 * Independent of electron and React (the watcher takes the DOM window as an argument), so `test/viewer-auto-save.test.ts` tests it directly.
 */
import type { AutoSaveMode } from '@shared/auto-save.js'
import type { StoredDraft } from './viewer-drafts.js'
import { shouldSaveByKey } from './viewer-save.js'

export interface AutoSaveGate {
  readonly mode: AutoSaveMode
  readonly editable: boolean
  readonly dirty: boolean
  readonly saving: boolean
  readonly conflict: boolean
  /** The current draft is the same one the previous auto-save was refused for (for a reason other than a conflict). Do not keep retrying the same thing. */
  readonly failedBefore: boolean
}

/** Whether auto-saving is allowed right now (regardless of mode - the triggers to call it differ per mode). */
export function canAutoSave(gate: AutoSaveGate): boolean {
  return gate.mode !== 'off' && !gate.failedBefore && shouldSaveByKey(gate)
}

/** Whether to arm the `afterDelay` timer. */
export function armsDelay(gate: AutoSaveGate): boolean {
  return gate.mode === 'afterDelay' && canAutoSave(gate)
}

/** What gets written in the background when moving to another file / closing the pane. */
export interface BackgroundSave {
  readonly pluginId: string
  readonly uri: string
  readonly text: string
  readonly baseMtimeMs: number
}

/**
 * Whether to write the draft of the file being left (what is remembered in the table, TODO 312) in the background. Not written when `off`, there is no draft, the plugin is unknown,
 * or that file shows a conflict band (the draft stays in the table and is restored as before when the user returns).
 */
export function planBackgroundSave(input: {
  readonly mode: AutoSaveMode
  readonly uri: string
  readonly pluginId: string | null
  readonly stored: StoredDraft | undefined
  readonly conflictUri: string | null
}): BackgroundSave | null {
  if (input.mode === 'off' || input.pluginId === null || input.pluginId === '') return null
  if (input.stored === undefined || input.conflictUri === input.uri) return null
  return { pluginId: input.pluginId, uri: input.uri, text: input.stored.text, baseMtimeMs: input.stored.baseMtimeMs }
}

/** The reason focus was lost (for logs and tests). */
export type FocusLoss = 'focus' | 'window'

/** Interval (ms) for checking whether the whole window lost focus. Runs only while the iframe has focus. */
export const WINDOW_FOCUS_POLL_MS = 500

/**
 * Calls `onLoss` when the viewer's iframe loses focus (`onFocusChange`). The return value stops the watcher.
 *
 * - If `activeElement` is the iframe right after the parent window's `blur`, it means "entered the iframe".
 * - While inside, a parent `focusin` (non-iframe) / parent window `focus` (with a non-iframe active) means "moved elsewhere in the parent".
 * - While inside, `document.hasFocus()` is watched, and going true -> false means "the whole window lost focus" (another app).
 *   The focus is still in the iframe, so when the user returns to the window and focus goes back to the iframe nothing happens (it fires again the next time it is lost).
 */
export function watchFrameFocusLoss(
  win: Window,
  frame: () => HTMLIFrameElement | null,
  onLoss: (reason: FocusLoss) => void,
  pollMs: number = WINDOW_FOCUS_POLL_MS
): () => void {
  const doc = win.document
  let inside = frame() !== null && doc.activeElement === frame()
  let windowFocused = doc.hasFocus()
  let poll: ReturnType<typeof setInterval> | null = null
  let pending: ReturnType<typeof setTimeout> | null = null

  const stopPoll = (): void => {
    if (poll !== null) clearInterval(poll)
    poll = null
  }
  const startPoll = (): void => {
    if (poll !== null) return
    windowFocused = doc.hasFocus()
    poll = setInterval(() => {
      const focused = doc.hasFocus()
      if (inside && windowFocused && !focused) onLoss('window')
      windowFocused = focused
    }, pollMs)
  }
  const leave = (): void => {
    if (!inside) return
    inside = false
    stopPoll()
    onLoss('focus')
  }
  const onBlur = (): void => {
    // `activeElement` changes after the blur, so wait one tick before looking.
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      const target = frame()
      if (target !== null && doc.activeElement === target) {
        inside = true
        startPoll()
      }
    }, 0)
  }
  const onFocusIn = (event: FocusEvent): void => {
    if (inside && event.target !== frame()) leave()
  }
  const onFocus = (): void => {
    if (inside && doc.activeElement !== frame()) leave()
  }
  if (inside) startPoll()
  win.addEventListener('blur', onBlur)
  win.addEventListener('focus', onFocus)
  doc.addEventListener('focusin', onFocusIn, true)
  return () => {
    win.removeEventListener('blur', onBlur)
    win.removeEventListener('focus', onFocus)
    doc.removeEventListener('focusin', onFocusIn, true)
    if (pending !== null) clearTimeout(pending)
    stopPoll()
  }
}
