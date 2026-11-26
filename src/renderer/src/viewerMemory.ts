/**
 * ViewerPane's per-thread memory (item 63, ARCHITECTURE.md 5.3 "per-thread display memory").
 *
 * A bridge between two Zustand stores: `useStore` (the viewer's `selectedUri` / `highlightQuery`) and
 * `useThreads` (`activeThreadId` and the thread rows arriving from main). The form is the same as item 49's Sidebar:
 * the component (App) watches both and writes one's changes to the other.
 *
 *   - Selection changed -> write to main, tied to **the `activeThreadId` at that moment** (throttled at 300 ms).
 *     The callers of `select` (tree, search, links in the body, closing with ⌘W) need to know nothing.
 *   - `activeThreadId` changed -> re-open that thread's memory with `select` (close if none).
 *
 * Closing (⌘W, a Web tab's close - the heading's X of item 70 went away in TODO 1326) moves to the previous view, or does
 * `select(null)` when nothing is left (TODO 1297), so it is saved through the same path (the previous view, or "that thread's
 * memory = none"). A closed view is not opened again when the user comes back. A page whose tab was closed while another
 * conversation was in front is settled on the way back (`settleClosedWebView`, TODO 1326). The pure part is `viewer-memory.ts`.
 *
 * TODO 1338 (review Y): an `openDiff` is a temporary view that any `select` closes, so a diff is shown only once the restore of the
 * conversation has settled - synchronously at the end of the effect, or after the asynchronous settling of a closed Web page. Then
 * the window asks main for the diff that waited while no window showed the conversation (`viewer.pendingDiff`), and a `diff` command
 * that arrives while the restore is still in progress is held until then. Both go through `showViewerDiff`.
 */
import { useEffect } from 'react'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import { CLOSED_VIEWER, planViewerCommand, recallViewer, ViewerMemoryWriter } from './viewer-memory.js'
import { acceptDraftConflict } from './draft-conflict.js'
import { planExternalChange } from './viewer-external-change.js'
import { WEB_BLANK_URL } from '@shared/web-tabs.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { isClosedWebPage, openAgentWebUrl } from './webStore.js'
import { settleClosedWebView } from './viewerHistory.js'
import { jumpToSetting } from './settingsJump.js'
import { ViewerShownReporter } from './viewer-shown.js'
import type { DiffPayload } from '@shared/plugin.js'

const writer = new ViewerMemoryWriter({
  send: (threadId, memory) =>
    window.aios.threads.setViewerState(threadId, memory.uri, memory.highlight),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
})

/**
 * A marker so that a `select` during a re-open is not recorded back. `select` does `set` synchronously, and
 * the `subscribe` listener is also called synchronously, so setting it before the call and clearing it after is enough.
 */
let restoring = false

/**
 * Whether the `select` in progress is the restore on a conversation switch (read synchronously from a store listener).
 * TODO 1300: Files does not follow a restored file (the conversation's own Files selection, TODO 1257, is shown instead).
 */
export function isRestoringViewer(): boolean {
  return restoring
}

/**
 * The conversation whose next opening keeps the viewer as it is instead of restoring its memory (TODO 1334, review Y). Set by
 * the handoff's copy when the source is the conversation on screen; consumed by the first switch, whichever conversation it is to.
 */
let keepShownOn: string | null = null

/**
 * TODO 1334: the handoff to a lighter conversation copies the source conversation's view to the new one. A copy: the source keeps
 * its memory. Goes through the usual throttled write, so main re-validates it (`setViewerState`: no `file:` path that hits the
 * exclusion rules, no URL with a visible secret).
 *
 * - When the source is the conversation on screen (the usual case: the button is on its cache strip), **what is on screen is
 *   copied** (`selectedUri` / `highlightQuery`) and the switch to the new conversation keeps the viewer as it is (review Y). A blank
 *   Web tab is never remembered, so then the source's memory is copied as the memory, and the screen still stays on the blank tab
 *   instead of jumping to that remembered file.
 * - Otherwise the source's memory (the pending write first) is copied. Nothing is written when there is nothing to remember.
 */
export function copyViewerMemoryTo(fromId: string, toId: string): void {
  const recalled = recallViewer(useThreads.getState().threadsById, writer.pending, fromId)
  let memory = recalled
  if (useThreads.getState().activeThreadId === fromId) {
    const { selectedUri, highlightQuery } = useStore.getState()
    if (selectedUri !== WEB_BLANK_URL) memory = { uri: selectedUri, highlight: highlightQuery }
    keepShownOn = toId
  }
  if (memory.uri === null) return
  writer.remember(toId, { uri: memory.uri, highlight: memory.highlight })
}

/** TODO 1338 (review Y): counts the restores, so the reply to a pull made for an earlier restore is not shown. */
let restoreSeq = 0
/** The conversation whose viewer restore has settled in this window (null while a restore is in progress or none is shown). */
let settledThreadId: string | null = null
/** A `diff` command for the conversation being restored, held until its restore settles (the restore would erase it). */
let heldDiff: { readonly threadId: string; readonly diff: DiffPayload } | null = null

/**
 * TODO 1338: shows an `openDiff` as a temporary view (item 104) if this window shows `threadId` - the one function for main's `diff`
 * command, a held one and a pulled one. While the conversation's restore has not settled the diff is held instead (the newest wins).
 * Returns whether it is on screen now. The file's viewer (and draft) only stays hidden behind and alive, so showing it is fine even
 * with a draft.
 */
function showViewerDiff(threadId: string, diff: DiffPayload): boolean {
  if (useThreads.getState().activeThreadId !== threadId) return false
  if (settledThreadId !== threadId) {
    heldDiff = { threadId, diff }
    return false
  }
  useStore.getState().openDiff(diff)
  return true
}

/** TODO 1338 (review Y): the restore of `threadId` (number `seq`) is over. Show a held diff, then ask main for a waiting one. */
function settleViewerRestore(threadId: string, seq: number): void {
  if (seq !== restoreSeq || useThreads.getState().activeThreadId !== threadId) return
  settledThreadId = threadId
  const held = heldDiff
  heldDiff = null
  if (held !== null) showViewerDiff(held.threadId, held.diff)
  void pullPendingDiff(threadId, seq)
}

/**
 * TODO 1338 (review Y): asks main for the `openDiff` that waited for `threadId`. Shown only if the window still shows that
 * conversation from the same restore; only then is main told it was shown, so a diff not shown waits for the next opening.
 */
async function pullPendingDiff(threadId: string, seq: number): Promise<void> {
  let pending
  try {
    pending = await window.aios.viewer.pendingDiff(threadId)
  } catch {
    // It stays waiting in main and is asked for again the next time the conversation is opened.
    return
  }
  if (pending === null || seq !== restoreSeq) return
  if (!showViewerDiff(threadId, pending.diff)) return
  void window.aios.viewer.pendingDiffShown(threadId, pending.generation).catch(() => undefined)
}

/** Placed in App only once. */
export function useViewerMemory(): void {
  // The selector returns only a string or null (avoiding the React #185 pitfall).
  const activeThreadId = useThreads((state) => state.activeThreadId)

  // When the thread changes, re-open that thread's memory.
  useEffect(() => {
    // TODO 1338 (review Y): a new restore starts. A diff held for another conversation is dropped (one for this conversation that
    // came between the switch and this effect is kept, it is shown when the restore settles).
    restoreSeq += 1
    const seq = restoreSeq
    settledThreadId = null
    if (heldDiff !== null && heldDiff.threadId !== activeThreadId) heldDiff = null
    // A temporary view (item 104) belongs to the previous thread, so close it on a switch.
    useStore.getState().closeTransient()
    // TODO 1334 (review Y): right after a handoff, the new conversation opens on the screen as it was (its memory is a copy of it).
    const keep = keepShownOn !== null && keepShownOn === activeThreadId
    keepShownOn = null
    // When there is no thread (the last one was deleted, etc.) do not touch anything: there is no owner of the memory.
    if (activeThreadId === null) return
    if (keep) {
      settleViewerRestore(activeThreadId, seq)
      return
    }
    const memory = recallViewer(useThreads.getState().threadsById, writer.pending, activeThreadId)
    const { selectedUri, highlightQuery, select } = useStore.getState()
    // TODO 1326: the remembered page's tab was closed in this window (perhaps while another conversation was in front). Do not
    // load it into whatever tab is current: show nothing, then let the conversation's own history pick (an earlier step still
    // open, else a later one, else nothing), and remember that.
    if (memory.uri !== null && isClosedWebPage(memory.uri)) {
      const threadId = activeThreadId
      restoring = true
      try {
        select(null)
      } finally {
        restoring = false
      }
      void settleClosedWebView(threadId, memory.uri)
        .then((ran) => {
          if (ran && useStore.getState().selectedUri === null) writer.remember(threadId, CLOSED_VIEWER)
        })
        .catch(() => undefined)
        // TODO 1338 (review Y): only now is this restore over (`closeViewerUri` above may `select`, which closes a temporary view).
        .finally(() => settleViewerRestore(threadId, seq))
      return
    }
    if (selectedUri !== memory.uri || highlightQuery !== memory.highlight) {
      restoring = true
      try {
        // Web pages (TODO 400) are also read. Only the current thread's one page is restored (TODO 812 removed TODO 411's
        // "do not read on restore" default. If main keeps the view alive, it just swaps what is shown).
        select(memory.uri, memory.highlight === null ? {} : { highlight: memory.highlight })
      } finally {
        restoring = false
      }
    }
    // TODO 1338 (review Y): the synchronous restore is over. A pulled diff arrives after the other effects of this switch (the global
    // back / forward's `openViewer`, `useNavHistory`), since the pull is a round trip to main.
    settleViewerRestore(activeThreadId, seq)
  }, [activeThreadId])

  // "Open / close" from main and the draft-conflict notification (item 97, the gateway's openFile /
  // closeFile and the write tools).
  useEffect(
    () =>
      window.aios.viewer.onCommand((command) => {
        if (command.kind === 'draftConflict') {
          const { selectedUri, viewerDirty, setDraftConflict } = useStore.getState()
          const notice = acceptDraftConflict(command, {
            activeThreadId: useThreads.getState().activeThreadId,
            selectedUri,
            dirty: viewerDirty
          })
          if (notice !== null) setDraftConflict(notice)
          return
        }
        // TODO 673: an outside tool rewrote the file being viewed. Unrelated to threads (it carries no threadId) -
        // unlike draftConflict, `activeThreadId` is not checked for a match.
        if (command.kind === 'fileChanged') {
          const { selectedUri, viewerDirty, setDraftConflict, requestExternalReload } = useStore.getState()
          const plan = planExternalChange(command, { selectedUri, dirty: viewerDirty })
          if (plan.kind === 'conflict') setDraftConflict({ uri: plan.uri, toolName: null })
          else if (plan.kind === 'reload') requestExternalReload(plan.uri)
          return
        }
        // TODO 826: the gateway's openDiff. Only when it concerns the thread this window is showing, show it as a temporary view (item 104)
        // - held until the restore settles if it is still in progress (TODO 1338 review Y).
        if (command.kind === 'diff') {
          showViewerDiff(command.threadId, command.diff)
          return
        }
        // TODO 1060 stage 2: the gateway's openSettings. Only when it concerns the thread this window is showing, open the settings screen to that item.
        if (command.kind === 'settings') {
          if (useThreads.getState().activeThreadId === command.threadId) jumpToSetting(command.name)
          return
        }
        // TODO 1338 (review Y): a later open / close of the same conversation wins over a diff still held for its restore (main drops
        // its waiting one the same way), so the older diff cannot appear on top of the newer view when the restore settles.
        if (heldDiff !== null && heldDiff.threadId === command.threadId) heldDiff = null
        const { selectedUri, highlightQuery, viewerDirty, select } = useStore.getState()
        const plan = planViewerCommand(command, {
          activeThreadId: useThreads.getState().activeThreadId,
          selectedUri,
          dirty: viewerDirty
        })
        // TODO 832 (1): for an "open" that asked for a reply (the gateway's openFile, only for windows with a draft), return the actual handling.
        // Main puts this in the return value to the AI (removing the case of `opened: true` when the draft was protected and nothing changed).
        if (command.kind === 'open' && command.replyId !== undefined) {
          const outcome = plan.kind === 'ignore' ? 'ignored' : plan.kind === 'keep' ? 'kept' : 'opened'
          void window.aios.viewer.replyCommand(command.replyId, outcome)
        }
        if (plan.kind === 'ignore') return
        if (plan.kind === 'keep') {
          // Main has already rewritten the memory. Put it back to the current display.
          writer.remember(command.threadId, { uri: selectedUri, highlight: highlightQuery })
          return
        }
        // TODO 822: the gateway's openUrl arrives as an http(s) URL. Like a link in an answer, open it in a Web view tab
        // (if a tab for the same page exists just move to it, otherwise a new tab - do not add a tab on every request).
        if (plan.uri !== null && isWebViewerUrl(plan.uri)) {
          openAgentWebUrl(plan.uri)
          return
        }
        // The line (item 273) is only passed as a one-shot instruction and is not written to the memory (the subscription does not look at lines).
        select(plan.uri, {
          ...(plan.highlight === null ? {} : { highlight: plan.highlight }),
          line: plan.line,
          page: plan.page ?? null
        })
      }),
    []
  )

  // TODO 1061 (3): tell main what ViewerPane currently shows in front (file, Web, temporary view, closed; folded counts
  // as nothing shown, TODO 1297 review). Only when it changes. Main uses it as the gateway's listOpenFiles "shown" marker.
  useEffect(() => {
    const reporter = new ViewerShownReporter((report) => {
      void window.aios.viewer.reportShown?.(report)
    })
    const update = (): void => {
      const { selectedUri, transient, viewerPage, viewerSelection, transientSelection, viewerFolded } = useStore.getState()
      reporter.update({
        folded: viewerFolded,
        activeThreadId: useThreads.getState().activeThreadId,
        selectedUri,
        hasTransient: transient !== null,
        page: viewerPage,
        selection: viewerSelection,
        transientSelection,
        transientEntry: transient?.kind === 'file' ? transient.name : null
      })
    }
    update()
    const offStore = useStore.subscribe((state, previous) => {
      if (
        state.selectedUri !== previous.selectedUri ||
        state.transient !== previous.transient ||
        state.viewerPage !== previous.viewerPage ||
        state.viewerSelection !== previous.viewerSelection ||
        state.transientSelection !== previous.transientSelection ||
        state.viewerFolded !== previous.viewerFolded
      )
        update()
    })
    const offThreads = useThreads.subscribe((state, previous) => {
      if (state.activeThreadId !== previous.activeThreadId) update()
    })
    return () => {
      offStore()
      offThreads()
    }
  }, [])

  // When the presence of drafts (URI + whether unsaved) changes, report it to main (item 97 second half).
  // Main remembers it per window and checks it against the target paths of the write tools.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.viewerDirty === previous.viewerDirty && state.selectedUri === previous.selectedUri) {
          return
        }
        void window.aios.viewer.reportDraft(state.viewerDirty ? state.selectedUri : null)
      }),
    []
  )

  // When the selection changes, write it as the current thread's memory.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (restoring) return
        if (
          state.selectedUri === previous.selectedUri &&
          state.highlightQuery === previous.highlightQuery
        ) {
          return
        }
        const threadId = useThreads.getState().activeThreadId
        if (threadId === null) return
        // A blank tab (TODO 522) is not remembered (main also refuses `about:blank`). The memory stays as it was.
        if (state.selectedUri === WEB_BLANK_URL) return
        writer.remember(threadId, { uri: state.selectedUri, highlight: state.highlightQuery })
      }),
    []
  )
}
