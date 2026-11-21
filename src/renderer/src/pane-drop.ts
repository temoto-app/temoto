/**
 * The drop target for the whole conversation pane (items 253 / 258, "the bigger one").
 *
 * Wherever in the pane it is dropped, it becomes an **attachment** of that thread (same as the VS Code extension). The route is the same single
 * path as paste / clip (item 161): the URI from `window.aios.drop.uriFor`, or `text/uri-list` from aios's file list, is fed to `attachUris`.
 * If it is outside the reference range, the band above the Composer (`dropStore.ts`) asks. It is accepted even while the Composer is hidden
 * by an approval (an attachment is only queued in the store).
 *
 * The smaller one (the prompt field's textarea) is taken first by `Composer`, which inserts the full path and calls `preventDefault`.
 * The Drop bubbles here too, but this checks `defaultPrevented` and does not attach (it only clears the overlay). While over the textarea,
 * the overlay is hidden with CSS `:has()`.
 *
 * Anti-flicker: `dragleave` fires every time the pointer crosses a child element, so if `relatedTarget` is inside the pane,
 * it is not treated as having left. The overlay is a single `pointer-events: none` layer and does not steal events.
 *
 * Route logging (TODO 489): for each drag, the first dragover (`drop.pane-dragover`, `dropEffect` / `effectAllowed`) and
 * the drop (`drop.pane-drop`, count only) are reported to main. Whether the attachment is allowed is in main's `attach.*` lines. 489 could not
 * tell where it fell through because "the log had no drop / attach stage at all".
 *
 * TODO 563 once split this into two ("left: attach / right: open in viewer"), but TODO 913 (wave 48) reverted it. The pane is a separate region from the ViewerPane,
 * so the overlay does not distinguish. The `action` of `drop.pane-drop` is always `attach`.
 */
import { useCallback, useRef, useState } from 'react'
import type { DropTrace } from '@shared/drop-link.js'
import { attachUris } from './dropStore.js'
import { carriesFiles } from './drop-uris.js'
import { currentFilesDrag, endFilesDrag, filesDragActive } from './files-drag.js'
import { collectDrop, effectsOf } from './viewer-drop.js'

/** Send the route log to main. Does nothing in an environment without preload (the fake in tests). */
function trace(entry: DropTrace): void {
  const send = (window.aios?.drop as { trace?: unknown } | undefined)?.trace
  if (typeof send === 'function') (send as (trace: DropTrace) => void)(entry)
}

export interface PaneDropHandlers {
  onDragOver(event: React.DragEvent<HTMLElement>): void
  onDragLeave(event: React.DragEvent<HTMLElement>): void
  onDrop(event: React.DragEvent<HTMLElement>): void
}

/** true if `leftTo` (the relatedTarget of dragleave) is outside `pane` (= really left the pane). */
export function leftPane(pane: Element, leftTo: EventTarget | null): boolean {
  return !(leftTo instanceof Node) || !pane.contains(leftTo)
}

export function usePaneDrop(threadId: string | null): {
  readonly dragging: boolean
  readonly handlers: PaneDropHandlers
} {
  const [dragging, setDragging] = useState(false)
  /** Whether this drag's dragover has been logged (once per drag, TODO 489). */
  const overTraced = useRef(false)

  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
    if (!overTraced.current) {
      overTraced.current = true
      // The values are those before the default handling rewrites them.
      trace({ stage: 'pane-dragover', ...effectsOf(event.dataTransfer) })
    }
    // Without this no drop happens, and Electron tries to open the file (main's `will-navigate` swallows it).
    event.preventDefault()
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (leftPane(event.currentTarget, event.relatedTarget)) {
      setDragging(false)
      overTraced.current = false
    }
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // A Drop already taken by the textarea (the smaller target) is `defaultPrevented`. Only clear the overlay; do not attach.
      setDragging(false)
      overTraced.current = false
      if (event.defaultPrevented) return
      if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
      event.preventDefault()
      // DataTransfer is readable only during the event, so copy it out here.
      const collected = collectDrop(event.dataTransfer, window.aios.drop.uriFor, currentFilesDrag())
      // Used up by this drop (code-review fix, TODO 677).
      endFilesDrag()
      trace({
        stage: 'pane-drop',
        files: collected.files,
        uris: collected.uris.length,
        emptyPaths: collected.emptyPaths,
        action: 'attach'
      })
      if (threadId === null) return
      // The first `resolveAttachment` goes out to main within this event (so it reads before the temp file is deleted).
      if (collected.uris.length > 0) void attachUris(threadId, collected.uris)
    },
    [threadId]
  )

  return { dragging, handlers: { onDragOver, onDragLeave, onDrop } }
}
