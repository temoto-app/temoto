/**
 * Files follows the local file the viewer shows (TODO 1300, ARCHITECTURE 5.4 "Files back / forward").
 *
 * The automatic form of "Show in Files" (TODO 1007, `show-in-files.ts`): the shown file becomes the Files selection
 * (the conversation's Files history, TODO 1257 — it **overwrites** whatever row was selected) and the tree opens down to
 * it, scrolling only when the row is out of view. Owner decisions (2026-11-22):
 *
 * - **When**: the viewer gets focus (a click, focus moving into it, including into the viewer's iframe), and the shown
 *   file changes (opened, viewer back / forward, the close button moving to the previous view). The restore on a
 *   conversation switch is not followed: that conversation's own Files selection is shown then (TODO 1257).
 * - **What**: `file://` only (`canShowInFiles`). Web pages, `thread://` and temporary views (diff, a file inside a zip,
 *   Help) leave Files alone.
 * - **The sidebar mode is never switched**: only the tree's selection and expansion change, so Files shows it when opened.
 * - It never opens anything in the viewer (item 80), and the Files selection does not drive the viewer, so there is no loop.
 */
import { useEffect } from 'react'
import { useStore } from './store.js'
import { canShowInFiles } from './show-in-files.js'
import { pickFilerRow } from './filerHistory.js'
import { isRestoringViewer } from './viewerMemory.js'

/** The file to mirror into Files, or null. A temporary view in front hides the file behind it. */
export function filesFollowTarget(selectedUri: string | null, hasTransient: boolean): string | null {
  if (hasTransient || !canShowInFiles(selectedUri)) return null
  return selectedUri
}

/**
 * Make `uri` the Files selection. `reveal` also opens the tree down to it (scrolling only when out of view); the change
 * path skips it because `select` already did the same auto reveal (item 264).
 */
export function followInFiles(uri: string, options: { readonly reveal: boolean }): void {
  pickFilerRow(uri)
  const store = useStore.getState()
  // While the file-name search's results are shown the tree is not, and `FileMode` reveals on leaving it (same rule as item 264).
  if (options.reveal && store.results === null) void store.reveal(uri, { auto: true })
}

/** The viewer got focus: mirror what it shows now. */
export function followShownFile(): void {
  const { selectedUri, transient } = useStore.getState()
  const target = filesFollowTarget(selectedUri, transient !== null)
  if (target !== null) followInFiles(target, { reveal: true })
}

/**
 * Calls `onEnter` when focus goes into the viewer's iframe. The iframe is cross-origin (OOPIF), so the parent only sees
 * its own window `blur`; if `activeElement` is the iframe one tick later, focus went into it (`watchFrameFocusLoss` in
 * `viewer-auto-save.ts` reads it the same way).
 */
export function watchFrameFocusEnter(
  win: Window,
  frame: () => HTMLIFrameElement | null,
  onEnter: () => void
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null
  const onBlur = (): void => {
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      const target = frame()
      if (target !== null && win.document.activeElement === target) onEnter()
    }, 0)
  }
  win.addEventListener('blur', onBlur)
  return () => {
    win.removeEventListener('blur', onBlur)
    if (pending !== null) clearTimeout(pending)
  }
}

/** Placed in App once, after `useFilerHistory()`. Follows changes of the shown file. */
export function useFilesFollowViewer(): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.selectedUri === previous.selectedUri) return
        if (isRestoringViewer()) return
        const target = filesFollowTarget(state.selectedUri, state.transient !== null)
        if (target === null) return
        // Out of the `select` call: back / forward run under the `navigating` marker, which would make the pick a no-op.
        queueMicrotask(() => {
          const now = useStore.getState()
          if (filesFollowTarget(now.selectedUri, now.transient !== null) === target) followInFiles(target, { reveal: false })
        })
      }),
    []
  )
}
