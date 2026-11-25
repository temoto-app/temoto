/**
 * Wiring of the Files back / forward and the per-conversation Files selection (TODO 1257, wave 92 bundle A,
 * ARCHITECTURE 5.4 "Files back / forward"). The rules (record, collapse, step, drop gone rows) are pure functions in
 * `filer-history.ts`; this file only connects them to the stores and the buttons. Same shape as `viewerHistory.ts`.
 *
 * - **The Files selection is the current step of the shown conversation's history** (`useFilerSelection`). It is the
 *   main highlight of the tree; the viewer's file only gets a quiet mark (owner decision 2026-11-17). Switching the
 *   conversation switches the selection and reveals it (ancestors opened, scrolled into view when out of view).
 * - **Recorded picks**: rows clicked / activated / moved to with ↑↓ in the tree (`pickFilerRow`, called by
 *   `FileMode`), and every explicit reveal (`reveal(uri)` without `auto` — the working folder from the Files icon or
 *   ⌘⇧E, "Show in Files", a folder hit of the file name search), caught here from `revealTick`.
 * - **Back / forward only reveal the row** (`reveal(uri, { row: true })`). They never touch the viewer, and the
 *   reveal is marked with `navigating.ts` so no history records it. Gone rows are found with `fs.stat` when a
 *   button is pressed (nearest step first, stopping at the first live one) and dropped from the list (so a button left with only gone rows becomes disabled).
 * - **Memory only, per window, per conversation.** Folder open / closed state (`expanded`) stays per window.
 *   While no conversation is shown, one row is held without history (the viewer history does not record then
 *   either), so the buttons stay disabled.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import {
  EMPTY_FILER,
  canStepFiler,
  copyFilerHistory,
  currentFilerUri,
  dropEntries,
  holdOnly,
  recordPick,
  renameEntries,
  stepFiler,
  type FilerDirection,
  type FilerHistory
} from './filer-history.js'
import { isNavigating, withNavigating } from './navigating.js'

interface FilerState {
  /** Keyed by conversation id; `NO_THREAD` while no conversation is shown. */
  histories: Readonly<Record<string, FilerHistory>>
}

export const useFiler = create<FilerState>(() => ({ histories: {} }))

/** Slot used while no conversation is shown. Conversation ids are never empty. */
const NO_THREAD = ''

function keyOf(threadId: string | null): string {
  return threadId ?? NO_THREAD
}

function historyOf(key: string): FilerHistory {
  return useFiler.getState().histories[key] ?? EMPTY_FILER
}

function setHistoryOf(key: string, history: FilerHistory): void {
  if (historyOf(key) === history) return
  useFiler.setState((state) => ({ histories: { ...state.histories, [key]: history } }))
}

/** A row was picked in Files (file or folder). Not recorded while back / forward is moving. */
export function pickFilerRow(uri: string, options?: { readonly byKeys?: boolean }): void {
  if (isNavigating()) return
  const threadId = useThreads.getState().activeThreadId
  const key = keyOf(threadId)
  const pick = { uri, now: Date.now(), byKeys: options?.byKeys === true }
  const history = historyOf(key)
  setHistoryOf(key, threadId === null ? holdOnly(history, pick) : recordPick(history, pick))
}

/** After a rename (TODO 1145): move the URIs under `from` in every conversation's Files history. */
export function renameFilerRows(from: string, to: string): void {
  const histories = useFiler.getState().histories
  let changed = false
  const next: Record<string, FilerHistory> = {}
  for (const [key, history] of Object.entries(histories)) {
    const renamed = renameEntries(history, from, to)
    if (renamed !== history) changed = true
    next[key] = renamed
  }
  if (changed) useFiler.setState({ histories: next })
}

/**
 * TODO 1334: the handoff to a lighter conversation copies the source conversation's Files history (selection and ← →) to the
 * new one. A copy, not a move: the source keeps its own. Does nothing when the source has none or the new conversation already
 * has one (it was picked into meanwhile). The URIs are only revealed / stat'ed through the usual checked calls afterwards.
 */
export function copyFilerHistoryTo(fromId: string, toId: string): void {
  const source = useFiler.getState().histories[fromId]
  if (source === undefined || source.entries.length === 0) return
  if (useFiler.getState().histories[toId] !== undefined) return
  setHistoryOf(toId, copyFilerHistory(source))
}

/** The row Files highlights for the shown conversation. The selector returns a string or null (React #185). */
export function useFilerSelection(): string | null {
  const key = keyOf(useThreads((state) => state.activeThreadId))
  return useFiler((state) => currentFilerUri(state.histories[key] ?? EMPTY_FILER))
}

/** Whether the Files ← / → buttons are enabled. The selectors return booleans only. */
export function useFilerNavState(): { readonly back: boolean; readonly forward: boolean } {
  const key = keyOf(useThreads((state) => state.activeThreadId))
  const back = useFiler((state) => canStepFiler(state.histories[key] ?? EMPTY_FILER, 'back'))
  const forward = useFiler((state) => canStepFiler(state.histories[key] ?? EMPTY_FILER, 'forward'))
  return { back, forward }
}

/** Whether the row no longer exists. A failed stat counts as present. */
async function isGone(uri: string): Promise<boolean> {
  try {
    return (await window.aios.fs.stat(uri)) === null
  } catch {
    // Unreadable: keep the step (the tree shows what it can).
    return false
  }
}

/** Open the ancestors of the row and scroll it into view, without recording anything. */
function showRow(uri: string): void {
  withNavigating(() => void useStore.getState().reveal(uri, { row: true }))
}

let queue: Promise<unknown> = Promise.resolve()

/** Files back / forward. Presses are handled in order (no crossing while stat is pending). True when it moved. */
export function navigateFiler(direction: FilerDirection): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const key = keyOf(useThreads.getState().activeThreadId)
    // Look at the nearest step only, one stat at a time, and stop at the first row that is still there (at most one
    // stat per press when nothing is gone, as the window-wide history does).
    for (;;) {
      const before = historyOf(key)
      const step = stepFiler(before, direction)
      if (step === null) return false
      const gone = await isGone(step.entry.uri)
      // The conversation changed while waiting: that press was for the other one.
      if (keyOf(useThreads.getState().activeThreadId) !== key) return false
      // The history moved while waiting (a pick, a rename): look again from where it is now.
      if (historyOf(key) !== before) continue
      if (gone) {
        setHistoryOf(key, dropEntries(before, (uri) => uri === step.entry.uri))
        continue
      }
      setHistoryOf(key, step.history)
      showRow(step.entry.uri)
      return true
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

/**
 * Put once in App, **after `useViewerMemory()`**: when the conversation changes, the Files selection's reveal runs
 * after the viewer restore's auto reveal, so the tree ends up on the Files selection.
 */
export function useFilerHistory(): void {
  const activeThreadId = useThreads((state) => state.activeThreadId)

  // Conversation switched: show that conversation's Files selection (only when the tree is shown, not the filter's
  // results — leaving the filter reveals it, `FileMode`).
  useEffect(() => {
    const uri = currentFilerUri(historyOf(keyOf(activeThreadId)))
    if (uri === null || useStore.getState().results !== null) return
    // The viewer restore's auto reveal (which ran just before) is cut short by this reveal because they share a
    // generation. Open the ancestors of the viewer's file quietly first (no scroll), then show the Files row last,
    // so the quiet mark of the viewer's file stays visible and the scroll lands on the Files row.
    const viewerUri = useStore.getState().selectedUri
    if (viewerUri === null || viewerUri === uri) {
      showRow(uri)
      return
    }
    void useStore
      .getState()
      .reveal(viewerUri, { quiet: true })
      .finally(() => {
        // Another conversation may have been picked meanwhile.
        if (useThreads.getState().activeThreadId === activeThreadId) showRow(uri)
      })
  }, [activeThreadId])

  // A conversation that left the list (deleted, trashed) takes its Files history with it. Restoring it from the
  // trash starts with an empty history.
  useEffect(
    () =>
      useThreads.subscribe((state, previous) => {
        if (state.threadsById === previous.threadsById) return
        const histories = useFiler.getState().histories
        const gone = Object.keys(histories).filter(
          (key) => key !== NO_THREAD && previous.threadsById[key] !== undefined && state.threadsById[key] === undefined
        )
        if (gone.length === 0) return
        const next = { ...histories }
        for (const key of gone) delete next[key]
        useFiler.setState({ histories: next })
      }),
    []
  )

  // An explicit reveal (working folder, "Show in Files", a folder hit) selects that row = 1 pick.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.revealTick === previous.revealTick) return
        if (state.revealTarget?.always !== true || state.revealedUri === null) return
        pickFilerRow(state.revealedUri)
      }),
    []
  )
}
