/**
 * The wiring of aios-wide back / forward (TODO 801, wave 38 bundle B, ARCHITECTURE 5.4 "global back / forward").
 * The rules for pushing, going back / forward, coalescing and skipping vanished destinations are pure functions (`nav-history.ts`); this only connects the store and the entry points (keys, buttons).
 * Same shape as `viewerHistory.ts` (the viewer's back / forward, TODO 369).
 *
 * - **Recording is done by subscribing to the store.** A change of `activeThreadId` = a conversation step (TODO 1257: the only kind of step; mode
 *   switches and picks in Files / Search are not steps). A change of `selectedUri` (switching the viewer file within a conversation,
 *   restoring the memory when the conversation changes) is not a step; it only rewrites the current step's viewer file.
 * - **One per window, memory only** (not kept across restarts. The renderer module is separate per `window`, so this comes naturally).
 * - Moves opened by back / forward are not recorded (the marker in `navigating.ts`. Shared with the viewer / Files histories so nothing is pushed twice).
 *   When the conversation changes, the viewer file is reopened from `pending` after the restore (effect) of `useViewerMemory` finishes.
 *   Going back keeps the current sidebar mode (`selectThread(id, { keepMode: true })`).
 * - Steps for vanished conversations are skipped silently (the buttons' enabled / disabled state uses the same check). If the viewer file at the destination
 *   no longer exists, close the viewer and go back only in the conversation. File existence is checked with `fs.stat` (only when back / forward is pressed; not read in the history subscription).
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import {
  EMPTY_NAV,
  canStepNav,
  followViewer,
  recordStep,
  stepNav,
  type NavDirection,
  type NavEntry,
  type NavHistory,
  type NavPosition
} from './nav-history.js'
import { globalNavShortcut, type GlobalNavId } from './shortcuts.js'
import { isNavigating, withNavigating } from './navigating.js'

interface NavState {
  history: NavHistory
}

export const useNav = create<NavState>(() => ({ history: EMPTY_NAV }))

/** The viewer file to reopen after the conversation changes, once the restore effect has finished. */
let pending: { readonly threadId: string; readonly uri: string | null } | null = null

function currentPosition(): NavPosition {
  return { threadId: useThreads.getState().activeThreadId, viewerUri: useStore.getState().selectedUri }
}

function setHistory(history: NavHistory): void {
  if (history !== useNav.getState().history) useNav.setState({ history })
}

/** Whether a conversation step points at a vanished conversation (not in the list = deleted or trashed). */
export function isThreadDead(entry: NavEntry, threadsById: Readonly<Record<string, unknown>>): boolean {
  return entry.threadId !== null && threadsById[entry.threadId] === undefined
}

/** Whether the viewer file of the destination step is gone. A failed stat counts as present. */
async function isMissingFile(uri: string | null): Promise<boolean> {
  if (uri === null || !uri.startsWith('file:')) return false
  try {
    return (await window.aios.fs.stat(uri)) === null
  } catch {
    // If it could not be read, treat it as existing (the viewer shows its own error).
    return false
  }
}

function openViewer(uri: string | null): void {
  const store = useStore.getState()
  if (store.selectedUri !== uri) store.select(uri)
  // Even if the restore (memory) wrote a different file first, the current step holds the display at the destination.
  setHistory(followViewer(useNav.getState().history, currentPosition(), Date.now()))
}

function applyEntry(entry: NavEntry, viewerUri: string | null): void {
  withNavigating(() => {
    const threads = useThreads.getState()
    const alive = entry.threadId !== null && threads.threadsById[entry.threadId] !== undefined
    const switching = alive && entry.threadId !== threads.activeThreadId
    if (switching && entry.threadId !== null) {
      pending = { threadId: entry.threadId, uri: viewerUri }
      // The mode is not part of a step (TODO 1257): stay in whatever sidebar mode is shown now.
      void threads.selectThread(entry.threadId, { keepMode: true })
    } else {
      pending = null
      openViewer(viewerUri)
    }
  })
}

let queue: Promise<unknown> = Promise.resolve()

/** Back / forward. Rapid presses are processed in order (so a next one arriving while waiting for stat does not cross over). true if it moved. */
export function navigateGlobal(direction: NavDirection): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    // To guard against recording mismatches, align the current step with the current display before moving.
    setHistory(followViewer(useNav.getState().history, currentPosition(), Date.now()))
    const threadsById = useThreads.getState().threadsById
    const step = stepNav(useNav.getState().history, direction, (entry) => isThreadDead(entry, threadsById))
    if (step === null) return false
    const missing = await isMissingFile(step.entry.viewerUri)
    // The await may have let something else move the history (another conversation picked meanwhile): compute the
    // step again from the history as it is now instead of writing back the one computed before the wait.
    setHistory(followViewer(useNav.getState().history, currentPosition(), Date.now()))
    const latest = useThreads.getState().threadsById
    const next = stepNav(useNav.getState().history, direction, (entry) => isThreadDead(entry, latest))
    if (next === null) return false
    // The stat result only applies to the file it was made for.
    const gone = missing && next.entry.viewerUri === step.entry.viewerUri
    setHistory(next.history)
    applyEntry(next.entry, gone ? null : next.entry.viewerUri)
    return true
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

export function runGlobalNav(id: GlobalNavId): void {
  void navigateGlobal(id === 'navBack' ? 'back' : 'forward')
}

/** Enabled / disabled state of the titlebar buttons. The selector returns only booleans (to avoid the React #185 pitfall). */
export function useGlobalNavState(): { readonly back: boolean; readonly forward: boolean } {
  const history = useNav((state) => state.history)
  const threadsById = useThreads((state) => state.threadsById)
  const dead = (entry: NavEntry): boolean => isThreadDead(entry, threadsById)
  return { back: canStepNav(history, 'back', dead), forward: canStepNav(history, 'forward', dead) }
}

/** Place once in App. Call it **after `useViewerMemory()`** (so the destination's viewer is reopened after the restore effect). */
export function useNavHistory(): void {
  const activeThreadId = useThreads((state) => state.activeThreadId)

  // Back / forward that changed the conversation: after the memory restore (the effect of `useViewerMemory`, which runs first), open the viewer at the destination.
  useEffect(() => {
    if (pending === null || pending.threadId !== activeThreadId) return
    const { uri } = pending
    pending = null
    withNavigating(() => openViewer(uri))
  }, [activeThreadId])

  // The first step (the position at startup).
  useEffect(() => {
    setHistory(followViewer(useNav.getState().history, currentPosition(), Date.now()))
  }, [])

  // A conversation switch = 1 step. Mode (ActivityBar) switches are not steps (TODO 1257).
  useEffect(
    () =>
      useThreads.subscribe((state, previous) => {
        if (isNavigating()) return
        if (state.activeThreadId === previous.activeThreadId) return
        const history = followViewer(useNav.getState().history, previousPosition(previous), Date.now())
        if (state.activeThreadId === null) {
          // The displayed conversation is gone (deleted): not a step.
          setHistory(history)
          return
        }
        setHistory(recordStep(history, currentPosition(), Date.now()))
      }),
    []
  )

  // Switching the viewer file only rewrites the current step (picking an item in Files / Search is not a step either, TODO 1257).
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (isNavigating()) return
        if (state.selectedUri === previous.selectedUri) return
        setHistory(followViewer(useNav.getState().history, currentPosition(), Date.now()))
      }),
    []
  )

  // Keys (⌘[ / ⌘] on mac, Alt+Shift+← / → elsewhere). Mouse back / forward and swipes stay for the viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const id = globalNavShortcut(event)
      if (id === null) return
      // When an input field or editor (including CodeMirror) has focus, prefer indent / word selection (the buttons still work).
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
      event.preventDefault()
      runGlobalNav(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Whether the element is editable (textarea / input / contenteditable / CodeMirror). Used to decide not to steal the key. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type)
  }
  return target.closest('.cm-editor') !== null
}

/** The position before the change (the previous conversation + the current viewer file; the viewer's belongs to the previous conversation until the conversation changes). */
function previousPosition(previous: { readonly activeThreadId: string | null }): NavPosition {
  return { threadId: previous.activeThreadId, viewerUri: useStore.getState().selectedUri }
}
