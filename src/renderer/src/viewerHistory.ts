/**
 * The wiring of the viewer's back / forward (TODO 369, wave 20 bundle D, ARCHITECTURE 5.4 "viewer back / forward").
 * Pushing, going back, going forward, and merging are pure functions (`viewer-history.ts`); this only connects the store to the entry points (keys, mouse, gestures).
 *
 * - **Recording is done by subscribing to `selectedUri`** (same form as the memory of item 63). The callers of `select` (tree, search,
 *   links in the body, the gateway's `openFile`, restoring the memory when switching threads) need to know nothing.
 *   Only the up/down keys (item 356) mark it with `select(uri, { byKeys: true })` so that consecutive opens within 1 second merge into one step.
 * - **The history is per thread** (`useStore.viewerHistories`, keyed by thread id). The record goes to the `activeThreadId` at the time of `select`.
 *   The restore on a thread switch (`viewerMemory.ts`) is recorded on the new thread's side.
 * - A `select` opened by back / forward is not recorded (the `navigating` marker. `select` and the subscription are both synchronous, so setting it before and clearing it after is enough).
 * - **Kept in main per conversation (TODO 772, the latest 50 steps).** When a thread is opened, `hydrate` reads it back from main
 *   (`adoptStored`), and changes are written throttled at 300 ms (`ViewerHistoryWriter`). Nothing is written until the read-back finishes.
 *   Reading back only reads; it opens neither URLs nor files - they are loaded only when the user presses the left/right arrows (400).
 * - **The display position per document (TODO 1146).** ViewerPane passes the position the viewer reported (`scroll-position`) to
 *   `recordViewerPosition`, and it is remembered per URI in the history of the conversation being shown (also kept in main). If the destination of a left/right move has a
 *   position, it becomes a one-shot instruction with `select(uri, { restore })`, and ViewerPane returns it to the viewer with `restore-position`.
 * - The temporary diff view (item 104) does not change `selectedUri`, so it is not pushed. "Back" while a diff is in front
 *   closes the diff and returns to the file behind it (looks the same as a browser's "Back").
 */
import { useEffect } from 'react'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import {
  EMPTY_HISTORY,
  ViewerHistoryWriter,
  adoptStored,
  canStep,
  copyHistory,
  recordVisit,
  setPosition,
  stepHistory,
  type HistoryDirection,
  type ViewerHistory
} from './viewer-history.js'
import {
  isViewerNavId,
  viewerNavMouseButton,
  viewerNavShortcut,
  type ViewerNavId
} from './shortcuts.js'
import { keyPlatformOf } from './composer-keys.js'
import { isNavigating, withNavigating } from './navigating.js'
import type { ViewerScrollPosition } from '@shared/plugin.js'
import { closeViewerUri } from './webStore.js'

const writer = new ViewerHistoryWriter({
  send: (threadId, snapshot) => window.aios.threads.setViewerHistory(threadId, snapshot),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
})

/** Conversations whose read-back has started (read only once per window), with the read-back in flight or done. */
const hydrating = new Map<string, Promise<void>>()
/** Conversations whose read-back has finished. Nothing is written until a conversation is in here (so the saved history is not overwritten). */
const hydrated = new Set<string>()

const PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

function historyOf(threadId: string): ViewerHistory {
  return useStore.getState().viewerHistories[threadId] ?? EMPTY_HISTORY
}

/** Pushes the current viewer file as one step on the history of the thread being shown (does nothing if unchanged). */
function recordCurrent(threadId: string): void {
  const { selectedUri, highlightQuery, selectByKeys, selectReplace, setViewerHistory } = useStore.getState()
  if (selectedUri === null) return
  const history = historyOf(threadId)
  const next = recordVisit(history, {
    uri: selectedUri,
    highlight: highlightQuery,
    now: Date.now(),
    byKeys: selectByKeys,
    // The replace step for a web page (TODO 400).
    replace: selectReplace
  })
  if (next !== history) setViewerHistory(threadId, next)
}

/**
 * Reads a conversation's history back from main (TODO 772). Once per conversation per window. On failure (it runs on the current history only),
 * that conversation is not written, and it is read again the next time it is opened. What was read back is marked as "sent" with `markSynced`, so it does not create a write-back round trip.
 * The returned promise settles when the read-back is over (a second call during it gets the same one - TODO 1326 waits on it).
 */
export function hydrateViewerHistory(threadId: string): Promise<void> {
  const running = hydrating.get(threadId)
  if (running !== undefined) return running
  // Registered before the read starts, so a synchronous failure inside cannot be overwritten by the registration.
  const reading = Promise.resolve().then(() => readBack(threadId))
  hydrating.set(threadId, reading)
  return reading
}

async function readBack(threadId: string): Promise<void> {
  try {
    const stored = await window.aios.threads.viewerHistory(threadId)
    const adopted = adoptStored(historyOf(threadId), stored)
    if (adopted !== null) {
      useStore.getState().setViewerHistory(threadId, adopted)
      writer.markSynced(threadId, adopted)
    } else if (historyOf(threadId).entries.length > 1) {
      // The current history won (the user moved while waiting for the read-back): the stored side is stale, so rewrite it.
      hydrated.add(threadId)
      writer.schedule(threadId, () => historyOf(threadId))
    }
    hydrated.add(threadId)
  } catch {
    // Even if it could not be read, the history works in the renderer's memory. But **a conversation that could not be read back is not written** (not marked hydrated):
    // the saved 50 steps would be overwritten by 1 to 2 steps in memory. It is read again the next time that conversation is opened.
    hydrating.delete(threadId)
  }
}

/**
 * TODO 1334: the handoff to a lighter conversation copies the source conversation's ← → history (steps, current step and the
 * per-document positions) to the new one. A copy, not a move: the source keeps its own, and the two change independently.
 *
 * - The source's read-back is waited for first, so what is copied includes the steps kept in main, not only this session's.
 * - The new conversation has nothing stored in main (it was just created), so it counts as read back: the copy is written to
 *   main through the usual throttled write, and main re-validates every step (`sanitizeViewerHistory`) as for any write.
 * - Position reports need no re-pointing: a report for the file on screen goes to the conversation on screen (`recordViewerPosition`).
 * - Does nothing to the history when the new conversation already has a read-back started or steps of its own.
 */
export async function copyViewerHistoryTo(fromId: string, toId: string): Promise<void> {
  await hydrateViewerHistory(fromId)
  if (hydrating.has(toId) || historyOf(toId).entries.length > 0) return
  hydrating.set(toId, Promise.resolve())
  hydrated.add(toId)
  const source = historyOf(fromId)
  if (source.entries.length === 0) return
  useStore.getState().setViewerHistory(toId, copyHistory(source))
  writer.schedule(toId, () => historyOf(toId))
}

/** Back / forward. true if it moved. */
export function navigateViewer(direction: HistoryDirection): boolean {
  const store = useStore.getState()
  // The temporary diff view (item 104) is not in the history. If it is in front, "back" closes it and goes to the file behind.
  if (direction === 'back' && store.transient !== null) {
    store.closeTransient()
    return true
  }
  const threadId = useThreads.getState().activeThreadId
  if (threadId === null) return false
  const step = stepHistory(historyOf(threadId), store.selectedUri, direction)
  if (step === null) return false
  store.setViewerHistory(threadId, step.history)
  // Changes during the `select` of back / forward are not pushed to the history (the marker is shared with the global back / forward, TODO 801).
  // If there is a previously viewed position, it is returned as a one-shot instruction (TODO 1146).
  withNavigating(() =>
    store.select(step.entry.uri, {
      ...(step.entry.highlight === null ? {} : { highlight: step.entry.highlight }),
      ...(step.position === null ? {} : { restore: step.position })
    })
  )
  return true
}

/**
 * Closes the view in front like a browser tab (TODO 1297; reached by ⌘W since TODO 1326 removed the heading's X). The closed URI
 * leaves the conversation's history and focus moves to the view seen just before it; with nothing left the pane shows its empty
 * state (`closeViewerUri`, the same rule as closing a Web tab). The move is not recorded as a new step.
 */
export function closeShownView(): void {
  const uri = useStore.getState().selectedUri
  if (uri === null) return
  closeViewerUri(uri)
}

/**
 * Coming back to a conversation whose remembered view is a page whose tab this window closed (TODO 1326, `isClosedWebPage`): after
 * its history is read back, close that page in it the same way (`closeViewerUri`), so the conversation shows its own earlier view,
 * else a later one, else nothing - never the closed page loaded into some other tab. Does nothing if the user moved on meanwhile
 * (another conversation, or something opened). Resolves to whether it ran.
 */
export async function settleClosedWebView(threadId: string, closedUri: string): Promise<boolean> {
  await hydrateViewerHistory(threadId)
  if (useThreads.getState().activeThreadId !== threadId || useStore.getState().selectedUri !== null) return false
  closeViewerUri(closedUri, threadId)
  return true
}

/**
 * The conversation at the time each URI was last handed to the viewer (review of TODO 1146). The bridge sends the previous file's position when the next `resource` arrives
 * (up to 200 ms later), so a report right after a conversation switch is attributed to "the conversation at the time it was handed over", not "the conversation at arrival".
 */
const pushedThread = new Map<string, string>()

/**
 * Opaque per-conversation tokens (TODO 1337 item 12): `viewerGenerationFor` gives a conversation's token (the same one every time), and
 * `threadOfGeneration` maps a token the viewer echoed back to the conversation. Tokens are random, so a viewer cannot name a conversation it was never shown. Bounded; an evicted / unknown token falls back to the guess in `recordViewerPosition`.
 */
const generationOfThread = new Map<string, string>()
const threadOfToken = new Map<string, string>()

export function viewerGenerationFor(threadId: string): string {
  const known = generationOfThread.get(threadId)
  if (known !== undefined) return known
  // Unguessable on purpose: a viewer (a sandboxed plugin iframe) can then only echo tokens the host handed to it, never one of another conversation.
  const token = crypto.randomUUID()
  generationOfThread.set(threadId, token)
  threadOfToken.set(token, threadId)
  if (generationOfThread.size > 256) {
    const oldest = generationOfThread.keys().next().value as string
    const oldToken = generationOfThread.get(oldest)
    generationOfThread.delete(oldest)
    if (oldToken !== undefined) threadOfToken.delete(oldToken)
  }
  return token
}

/** The token of the conversation on screen, or undefined when there is none. */
export function activeViewerGeneration(): string | undefined {
  const active = useThreads.getState().activeThreadId
  return active === null ? undefined : viewerGenerationFor(active)
}

export function threadOfGeneration(token: string): string | null {
  return threadOfToken.get(token) ?? null
}

/** Called every time ViewerPane hands over a `resource`. Remembers the conversation being shown as the owner of that URI. */
export function noteViewerPushed(uri: string): void {
  const threadId = useThreads.getState().activeThreadId
  if (threadId === null) return
  // Drop from the oldest (a Map keeps insertion order). Re-inserting moves it to the end.
  pushedThread.delete(uri)
  pushedThread.set(uri, threadId)
  if (pushedThread.size > 64) pushedThread.delete(pushedThread.keys().next().value as string)
}

/**
 * Remembers the display position the viewer reported (TODO 1146). The caller (ViewerPane) has already validated the value with
 * `acceptViewerPosition`. A URI that is not among the history's steps is not remembered (`setPosition`). Whose history it goes to:
 *
 * - **The file on screen (`selectedUri`) → the conversation on screen.** Switching to a conversation that shows the same file does
 *   not hand it to the viewer again, so the conversation it was handed over in can be another one (TODO 1334 review Y: after a
 *   handoff and back, and any two conversations showing the same file).
 * - Any other file (the previous file's last report, sent when the next `resource` arrives) → the conversation it was handed over
 *   in (`pushedThread`), else the conversation on screen.
 */
export function recordViewerPosition(uri: string, position: ViewerScrollPosition, generation?: string): void {
  const active = useThreads.getState().activeThreadId
  const onScreen = active !== null && useStore.getState().selectedUri === uri
  // A generation the host gave names the conversation the scroll was made in; the guesses above are for a viewer that does not echo it.
  const stamped = typeof generation === 'string' ? threadOfGeneration(generation) : null
  const threadId = stamped ?? (onScreen ? active : (pushedThread.get(uri) ?? active))
  if (threadId === null) return
  const history = historyOf(threadId)
  const next = setPosition(history, uri, position)
  if (next !== history) useStore.getState().setViewerHistory(threadId, next)
}

export function runViewerNav(id: ViewerNavId): void {
  navigateViewer(id === 'viewerBack' ? 'back' : 'forward')
}

/** Whether the heading's buttons are enabled or disabled (ViewerPane). The selector returns only booleans (avoiding the React #185 pitfall). */
export function useViewerNavState(): { readonly back: boolean; readonly forward: boolean } {
  const threadId = useThreads((state) => state.activeThreadId)
  // Select only booleans: with the position reports (TODO 1146) the history value changes on every scroll, but the buttons are not redrawn.
  const historyIn = (state: ReturnType<typeof useStore.getState>): ViewerHistory =>
    threadId === null ? EMPTY_HISTORY : (state.viewerHistories[threadId] ?? EMPTY_HISTORY)
  const back = useStore((state) => canStep(historyIn(state), state.selectedUri, 'back'))
  const forward = useStore((state) => canStep(historyIn(state), state.selectedUri, 'forward'))
  return { back, forward }
}

/** Placed in App only once. Call it **after `useViewerMemory()`** (record after the restore on a thread switch). */
export function useViewerHistory(): void {
  const activeThreadId = useThreads((state) => state.activeThreadId)

  // The thread was switched: make the display after the memory restore (the `useViewerMemory` effect, which runs first) a step of that thread's
  // history. If the restore's `select` already pushed it, it is the same URI so nothing happens. This guards against a miss
  // when the display is the same file as the previous thread and no `select` occurred.
  useEffect(() => {
    if (activeThreadId === null) return
    recordCurrent(activeThreadId)
    void hydrateViewerHistory(activeThreadId)
  }, [activeThreadId])

  // When the history changes, write it to main throttled per conversation (TODO 772). Only conversations whose read-back has finished.
  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.viewerHistories === previous.viewerHistories) return
      for (const [threadId, history] of Object.entries(state.viewerHistories)) {
        if (history === previous.viewerHistories[threadId] || !hydrated.has(threadId)) continue
        writer.schedule(threadId, () => historyOf(threadId))
      }
    })
    // Right before the window closes or reloads, send what is waiting for the throttle.
    const onHide = (): void => writer.flushAll()
    window.addEventListener('pagehide', onHide)
    return () => {
      unsubscribe()
      window.removeEventListener('pagehide', onHide)
    }
  }, [])

  // The file changed (the search term changed) -> to the history of the thread being shown. Closing (null) is not pushed.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (isNavigating()) return
        if (state.selectedUri === previous.selectedUri && state.highlightQuery === previous.highlightQuery) return
        const threadId = useThreads.getState().activeThreadId
        if (threadId !== null) recordCurrent(threadId)
      }),
    []
  )

  // Keys (Ctrl+- / Ctrl+Shift+-, otherwise Alt+Left / Alt+Right) and the mouse's back / forward buttons (mac). Those pressed inside the viewer (OOPIF)
  // are sent back by the bridge and come from `runViewerShortcut` to the same `runViewerNav`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const id = viewerNavShortcut(event, PLATFORM)
      if (id === null) return
      event.preventDefault()
      runViewerNav(id)
    }
    const onMouse = (event: MouseEvent): void => {
      const id = viewerNavMouseButton(event.button, PLATFORM)
      if (id === null) return
      // Stop the default action (moving through the document's history). It moves only on release.
      event.preventDefault()
      if (event.type === 'mouseup') runViewerNav(id)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])

  // Gestures the window received (a three-finger swipe on macOS, an app-command on Windows / Linux) arrive from main.
  useEffect(
    () =>
      window.aios.app.onMenuCommand((command) => {
        if (isViewerNavId(command)) runViewerNav(command)
      }),
    []
  )
}
