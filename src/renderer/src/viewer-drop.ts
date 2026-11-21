/**
 * Drop onto the viewer (TODO 366, wave 20 bundle E / TODO 407, wave 21 bundle B, ARCHITECTURE 7.4.8).
 *
 * Dropping a file onto a viewer being edited inserts it **at the caret**. The format is decided by the plugin (the host's table,
 * `dropInsertFormat`): the Source of `aios.markdown` uses a Markdown link (`![name](file:///…)` / `[name](file:///…)`),
 * everything else (`aios.text`) uses the raw full path (one per line).
 *
 * **The viewer is a sandboxed iframe (OOPIF), and no drag event over it reaches the parent** (same as the pointer in 7.4.2).
 * Also, a plugin cannot know absolute paths (the preload's `webUtils` exists only in the parent window). So the host receives it:
 *
 *   1. When it notices a file drag (the window's dragenter / dragover, or `drag-files` from the viewer's bridge),
 *      it shows a transparent overlay (`.viewer-drop-overlay`) over the iframe and **puts `pointer-events: none` on the iframe**
 *      (`.viewer-dropping .viewer-frame`; 407: the overlay alone could let an in-progress drag keep being delivered to the iframe, so both are used).
 *   2. On drop, it turns the data into URIs with `drop.uriFor` (preload) / `text/uri-list`, and only those that main's `drop.checkLinks` passed through the choke point
 *      (`FsAccess.assertAllowed`, read) become a string via `dropInsertText`.
 *   3. It passes them to the viewer with `insert-text`. The viewer inserts at the caret.
 *   If the drop still lands inside the iframe, the viewer sends the `File` back as is with `drop-files`
 *   (`noticeGuestDrop`). The host runs it through the same path as step 2.
 *
 * Overlay cleanup: any of drop, a dragleave **out of the window** (wait `LEAVE_GRACE_MS`, and only if no dragover arrives meanwhile),
 * pointer movement / press on the overlay (**only when no dragover has arrived for `DRAG_IDLE_MS`**), or no dragover for
 * `DRAG_IDLE_MS` (cancelled with Esc, or left the window over the iframe). A lingering overlay makes the editor
 * unclickable, so the cleanup paths are layered.
 *
 * TODO 429 (wave 22 bundle B): up to 407 the overlay was removed immediately on pointer movement (on the premise that "no pointer events fire during a drag").
 * In Chromium on macOS `pointermove` can fire even during a drag from outside, so the overlay vanished right after appearing and reappeared,
 * and when the finger was released with no overlay present, no drop happened (owner's log: 2 `drag-seen` lines 15 ms apart, 0 drop lines).
 * Now a pointer removes it only when dragover has stopped, and the drag receivers are put on the overlay's parent `.viewer-body`
 * (drags over the overlay bubble up to it; if the overlay is gone at that instant and the drop lands on `.viewer-body`, it flows through the same path).
 *
 * Path logging (407 / 429): each stage tells main only counts via `trace` (`viewer.drop.*`, `shared/drop-link.ts`).
 * It also records the caller that removed the overlay (`end`), the host's first dragover, and why a `drop-files` was discarded.
 *
 * It is separated by location from the conversation pane's Drop (`pane-drop.ts`, attachments): the overlay appears only over `.viewer-body`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DROP_EFFECTS,
  EFFECTS_ALLOWED,
  dropInsertText,
  type DropEndReason,
  type DropInsertFormat,
  type DropLinkCheck,
  type DropLinkDenial,
  type DropTrace,
  type DropTraceTarget
} from '@shared/drop-link.js'
import { carriesFiles, droppedUris, type DroppedData } from './drop-uris.js'
import { currentFilesDrag, endFilesDrag, filesDragActive, mismatchesRememberedFiles } from './files-drag.js'

/** If no dragover arrives for this long, the drag is considered over and the overlay is removed (ms). */
export const DRAG_IDLE_MS = 2000
/** Interval of the watcher above (ms). */
const WATCH_INTERVAL_MS = 500
/**
 * Grace period (ms, TODO 429) from a dragleave out of the window until the overlay is removed. If a dragover (window / overlay / the viewer's
 * `drag-files`) arrives meanwhile, it is not removed. The viewer's `drag-files` is throttled at `DRAG_NOTICE_INTERVAL_MS` (250 ms),
 * so this is longer than that. So that the overlay does not vanish even if a dragleave that merely moved into the iframe carries (0, 0).
 */
export const LEAVE_GRACE_MS = 400

/**
 * Whether a dragleave means "left the window" (407). 366 decided it by `relatedTarget === null` alone, but in Chromium
 * drag events can have a null `relatedTarget` even when moving from child to child, so the dragleave right after landing on the overlay
 * would remove the overlay, and a drag returning over the iframe would be swallowed by the viewer (= nothing happens), going back and forth.
 * So the coordinates are checked too: inside the window (edges excluded) means it has not left. `(0, 0)` is the value Chromium assigns outside the window.
 */
export function leftWindow(
  event: { readonly relatedTarget: EventTarget | null; readonly clientX: number; readonly clientY: number },
  viewport: { readonly width: number; readonly height: number }
): boolean {
  if (event.relatedTarget !== null) return false
  const { clientX: x, clientY: y } = event
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true
  if (x === 0 && y === 0) return true
  return x <= 0 || y <= 0 || x >= viewport.width || y >= viewport.height
}

/** Counts of what was dropped (for logs, 407). */
export interface DropCollect {
  readonly uris: readonly string[]
  /** The number of `dataTransfer.files`. */
  readonly files: number
  /** The number of `File`s for which `uriFor` returned empty (= `webUtils.getPathForFile` returned no path). */
  readonly emptyPaths: number
}

/**
 * Turns the dropped data into a list of URIs and counts for the log. If `remembered` (TODO 677, `currentFilesDrag()`) exists,
 * it is used without reading `DataTransfer` - `files` / `emptyPaths` are 0 (the real `File` was not involved).
 * **Code review fix**: when `data.files` carries real `File`s whose names disagree with `remembered`,
 * the old memory is not used and the real ones are counted again (`mismatchesRememberedFiles`, same as `drop-uris.ts`).
 */
export function collectDrop(
  data: DroppedData,
  uriFor: (file: unknown) => string,
  remembered: readonly string[] | null = null
): DropCollect {
  if (remembered !== null && !mismatchesRememberedFiles(data.files, remembered)) {
    return { uris: [...remembered], files: 0, emptyPaths: 0 }
  }
  let emptyPaths = 0
  const counting = (file: unknown): string => {
    const uri = uriFor(file)
    if (uri === '') emptyPaths += 1
    return uri
  }
  const uris = droppedUris(data, counting)
  return { uris, files: data.files.length, emptyPaths }
}

/** What to insert and what was refused. */
export interface DropInsertPlan {
  readonly text: string
  readonly denied: readonly DropLinkDenial[]
}

/**
 * Decides the string to insert from what was dropped. If there are file URIs, they go through main's choke point and are formatted per `format`;
 * otherwise (a URL from a browser, etc.) the `text/plain` string is used as is (same as when CodeMirror received it inside the iframe).
 */
export async function planDropInsert(
  uris: readonly string[],
  plainText: string,
  check: (uris: readonly string[]) => Promise<DropLinkCheck>,
  format: DropInsertFormat = 'markdown-link'
): Promise<DropInsertPlan> {
  if (uris.length === 0) return { text: plainText, denied: [] }
  const result = await check(uris)
  return { text: dropInsertText(result.allowed, format), denied: result.denied }
}

/** What the viewer reported about whether the current display accepts edits (TODO 587, `accepts-edits`). */
export interface AcceptsEditsReport {
  readonly uri: string
  readonly accepts: boolean
}

/**
 * Whether a drop onto the viewer becomes an insert (TODO 587). If the host's `editable` (an editable viewer, not read-only, not truncated)
 * is false, no insert (563: open). Even if true, if the viewer reported "does not accept now" for the file it is showing (`uri`)
 * (the Preview of `aios.markdown` / `aios.html`), it falls back to open. With no report, or a report for another file,
 * `editable` is used as is (viewers that do not send it and the middle of a switch behave as before).
 */
export function dropInsertable(editable: boolean, report: AcceptsEditsReport | null, uri: string | null): boolean {
  if (!editable) return false
  if (report === null || uri === null || report.uri !== uri) return true
  return report.accepts
}

/** Validates `accepts-edits` from the viewer (TODO 587). Only when it is addressed to the file being shown and well-formed. */
export function acceptAcceptsEdits(
  message: { readonly uri?: unknown; readonly accepts?: unknown },
  drawnUri: string | null
): AcceptsEditsReport | null {
  if (typeof message.uri !== 'string' || message.uri !== drawnUri) return null
  if (typeof message.accepts !== 'boolean') return null
  return { uri: message.uri, accepts: message.accepts }
}

export interface ViewerDropOptions {
  /** Whether to accept drops (since TODO 563, the whole time a viewer is shown). While false no overlay is shown. */
  readonly enabled: boolean
  /**
   * Whether this is a viewer that accepts inserts (being edited) (TODO 563). Default true (the insert of 366 / 407). If false, the dropped files are opened with
   * `open`. Even if true, a drop with ⌥ held opens (owner decision 2026-10-09).
   */
  readonly insertable?: boolean
  /** Opens the dropped files in the viewer (TODO 563). If absent there is no way to open (insert only). */
  readonly open?: (uris: readonly string[]) => void
  /** The format of the inserted string (per plugin, `dropInsertFormat`). */
  readonly format: DropInsertFormat
  /** Sends `insert-text` to the viewer. true if it could be sent. */
  readonly insert: (text: string) => boolean
  /** What the choke point refused (shown on the band). An empty array clears the band. */
  readonly onDenied: (denied: readonly DropLinkDenial[]) => void
  readonly uriFor: (file: unknown) => string
  readonly check: (uris: readonly string[]) => Promise<DropLinkCheck>
  /** Path log (407). Only counts and verdicts. */
  readonly trace?: (trace: DropTrace) => void
  readonly now?: () => number
}

/**
 * The receivers. Since TODO 429 the three drag ones are attached to **the overlay's parent `.viewer-body`** (those over the overlay bubble up;
 * those at the instant the overlay was gone are also received here). The two pointer ones are attached to the overlay.
 */
export interface ViewerDropOverlayHandlers {
  onDragOver(event: React.DragEvent<HTMLElement>): void
  onDragLeave(event: React.DragEvent<HTMLElement>): void
  onDrop(event: React.DragEvent<HTMLElement>): void
  onPointerMove(): void
  onPointerDown(): void
}

/** Whether the element that received the drag event is the overlay (otherwise `.viewer-body` or its children, 429). */
function targetOf(event: React.DragEvent<HTMLElement>): DropTraceTarget {
  const target = event.target
  return target instanceof Element && target.classList.contains('viewer-drop-overlay') ? 'overlay' : 'body'
}

/** Only `dropEffect` / `effectAllowed` in a form that may go in the log (values outside the spec are dropped, 429). */
export function effectsOf(dataTransfer: DataTransfer): { dropEffect?: string; effectAllowed?: string } {
  const out: { dropEffect?: string; effectAllowed?: string } = {}
  if (typeof dataTransfer.dropEffect === 'string' && DROP_EFFECTS.includes(dataTransfer.dropEffect)) {
    out.dropEffect = dataTransfer.dropEffect
  }
  if (typeof dataTransfer.effectAllowed === 'string' && EFFECTS_ALLOWED.includes(dataTransfer.effectAllowed)) {
    out.effectAllowed = dataTransfer.effectAllowed
  }
  return out
}

/** The values the bridge attaches to `drop-files` (TODO 429). The form before validation. */
export interface GuestDropInfo {
  readonly count?: unknown
  readonly cloneFailed?: unknown
}

function viewportOf(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function useViewerDrop(options: ViewerDropOptions): {
  readonly dragging: boolean
  /** `drag-files` arrived from the viewer's bridge (a drag that went straight from outside the window onto the iframe). */
  readonly noticeGuestDrag: () => void
  /**
   * `drop-files` arrived from the viewer's bridge (the overlay was not in time and the drop landed inside the iframe, 407). `files` is the value before validation
   * (if it is not an array it is dropped as `not-array` and logged, 429). `info` is the count the bridge saw and any copy failure.
   */
  readonly noticeGuestDrop: (files: unknown, info?: GuestDropInfo) => void
  readonly handlers: ViewerDropOverlayHandlers
} {
  const { enabled } = options
  const [dragging, setDragging] = useState(false)
  const lastSeen = useRef(Number.NEGATIVE_INFINITY)
  /** Whether `drag-seen` was written for the current drag (one line per drag). Also doubles as "is the overlay shown". */
  const traced = useRef(false)
  /** Whether the host's dragover was written for the current drag (one line per drag, 429). */
  const overTraced = useRef(false)
  /** Timer for the grace period of a dragleave out of the window (429). */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(options)
  latest.current = options
  const now = useCallback((): number => (latest.current.now ?? Date.now)(), [])

  const begin = useCallback(
    (source: 'window' | 'guest') => {
      lastSeen.current = now()
      if (!traced.current) {
        traced.current = true
        latest.current.trace?.({ stage: 'drag-seen', source })
      }
      setDragging(true)
    },
    [now]
  )
  const clearLeave = useCallback(() => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }, [])
  /** Removes the overlay. `reason` is the caller (for the log, 429). Written only once while the overlay was shown. */
  const end = useCallback(
    (reason: DropEndReason) => {
      clearLeave()
      if (traced.current) latest.current.trace?.({ stage: 'end', reason })
      traced.current = false
      overTraced.current = false
      setDragging(false)
    },
    [clearLeave]
  )
  /** Removes it only when no dragover has arrived for `DRAG_IDLE_MS` (the pointer's entry point, 429). A pointer during a drag does not remove it. */
  const endIfIdle = useCallback(
    (reason: DropEndReason) => {
      if (now() - lastSeen.current > DRAG_IDLE_MS) end(reason)
    },
    [end, now]
  )
  /** Dragleave out of the window: removes it if no dragover arrives during the grace period (429). */
  const endAfterLeave = useCallback(() => {
    clearLeave()
    const leftAt = now()
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      if (lastSeen.current <= leftAt) end('leave')
    }, LEAVE_GRACE_MS)
  }, [clearLeave, end, now])

  /**
   * The common path after a drop (both from the overlay and from inside the viewer). `alt` is whether ⌥ was held (only a drop on the overlay knows this; it is not carried by
   * a `drop-files` that landed inside the viewer). If the viewer does not accept inserts, or ⌥, it opens (TODO 563).
   */
  const deliver = useCallback((uris: readonly string[], plainText: string, alt = false) => {
    const current = latest.current
    if (current.open !== undefined && (current.insertable === false || alt)) {
      if (uris.length > 0) current.open(uris)
      return
    }
    if (current.insertable === false) return
    void planDropInsert(uris, plainText, current.check, current.format).then(
      (plan) => {
        const after = latest.current
        after.onDenied(plan.denied)
        if (plan.text === '') return
        const sent = after.insert(plan.text)
        after.trace?.({ stage: 'insert', format: after.format, lines: plan.text.split('\n').length, sent })
      },
      () => undefined
    )
  }, [])

  useEffect(() => {
    if (!enabled) {
      end('disabled')
      return
    }
    const onDrag = (event: DragEvent): void => {
      if (event.dataTransfer === null) return
      if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
      begin('window')
    }
    const onLeave = (event: DragEvent): void => {
      if (leftWindow(event, viewportOf())) endAfterLeave()
    }
    // The window's capture-phase drop only removes the overlay. React state is reflected later, so the same drop reaches the overlay / `.viewer-body`
    // receivers unchanged. Drops outside the viewer (conversation pane etc.) belong to their own receivers.
    const onDropAnywhere = (): void => end('drop')
    const onDragEnd = (): void => end('dragend')
    window.addEventListener('dragenter', onDrag, true)
    window.addEventListener('dragover', onDrag, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDropAnywhere, true)
    window.addEventListener('dragend', onDragEnd, true)
    const watch = setInterval(() => {
      if (now() - lastSeen.current > DRAG_IDLE_MS) end('idle')
    }, WATCH_INTERVAL_MS)
    return () => {
      window.removeEventListener('dragenter', onDrag, true)
      window.removeEventListener('dragover', onDrag, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDropAnywhere, true)
      window.removeEventListener('dragend', onDragEnd, true)
      clearInterval(watch)
      clearLeave()
    }
  }, [enabled, begin, end, endAfterLeave, clearLeave, now])

  const noticeGuestDrag = useCallback(() => {
    if (latest.current.enabled) begin('guest')
  }, [begin])

  const noticeGuestDrop = useCallback(
    (files: unknown, info?: GuestDropInfo) => {
      const current = latest.current
      // Accept only a drop inside the viewer during a drag (the bridge's `drag-files` arrived just before).
      const live = now() - lastSeen.current <= DRAG_IDLE_MS
      end('guest-drop')
      // TODO 443 / 677: when a native drag from the Files tree lands inside the iframe, the host does not read the `File` the bridge
      // sent but inserts the URI it remembered at dragstart as is (keeping 443's decision that
      // URIs are neither given to nor received from the plugin).
      const remembered = currentFilesDrag()
      if (remembered !== null) {
        // Use it up (code review fix): having decided this drop uses the remembered URI, forget it here without waiting for the window's fallback
        // (`installFilesDragForgetGuards`).
        endFilesDrag()
        const skip = !current.enabled ? 'not-enabled' : !live ? 'stale' : null
        if (skip !== null) {
          current.trace?.({ stage: 'guest-drop-skipped', reason: skip })
          return
        }
        current.trace?.({ stage: 'guest-drop', files: 0, uris: remembered.length, emptyPaths: 0 })
        deliver(remembered, '')
        return
      }
      const count =
        typeof info?.count === 'number' && Number.isInteger(info.count) && info.count >= 0 ? info.count : undefined
      const cloneFailed = info?.cloneFailed === true
      const skip = !current.enabled ? 'not-enabled' : !live ? 'stale' : !Array.isArray(files) ? 'not-array' : null
      if (skip !== null) {
        // Record why it was discarded (429). 407 discarded silently, so the log could not tell whether the drop landed in the iframe.
        current.trace?.({
          stage: 'guest-drop-skipped',
          reason: skip,
          ...(count === undefined ? {} : { files: count }),
          ...(cloneFailed ? { cloneFailed } : {})
        })
        return
      }
      const collected = collectDrop({ files: files as readonly unknown[], getData: () => '' }, current.uriFor)
      current.trace?.({
        stage: 'guest-drop',
        // When the copy failed the `File` does not arrive, so write the count the viewer saw.
        files: cloneFailed && count !== undefined ? count : collected.files,
        uris: collected.uris.length,
        emptyPaths: collected.emptyPaths,
        ...(cloneFailed ? { cloneFailed } : {})
      })
      if (collected.uris.length > 0) deliver(collected.uris, '')
    },
    [deliver, end, now]
  )

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!latest.current.enabled) return
      if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
      if (!overTraced.current) {
        // Only the first time per drag (429). The value is from before it was overwritten.
        overTraced.current = true
        latest.current.trace?.({ stage: 'overlay-dragover', target: targetOf(event), ...effectsOf(event.dataTransfer) })
      }
      // Without this the drop does not happen. Also stop it over `.viewer-body` at the instant the overlay was gone (429).
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      lastSeen.current = now()
    },
    [now]
  )

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (leftWindow(event, viewportOf())) endAfterLeave()
    },
    [endAfterLeave]
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      end('drop')
      if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
      const current = latest.current
      if (!current.enabled) return
      event.preventDefault()
      // DataTransfer can be read only during the event, so copy it here.
      const data: DroppedData = event.dataTransfer
      const collected = collectDrop(data, current.uriFor, currentFilesDrag())
      // Use it up in this drop (code review fix): forget it here without waiting for the window's fallback.
      endFilesDrag()
      const opens = current.open !== undefined && (current.insertable === false || event.altKey === true)
      current.trace?.({
        stage: 'overlay-drop',
        target: targetOf(event),
        files: collected.files,
        uris: collected.uris.length,
        emptyPaths: collected.emptyPaths,
        action: opens ? 'open' : 'insert'
      })
      const plainText = collected.uris.length === 0 ? data.getData('text/plain') : ''
      deliver(collected.uris, plainText, event.altKey === true)
    },
    [deliver, end]
  )

  // Do not remove on pointer events during a drag (Chromium on macOS can fire them even during a drag from outside, 429).
  const onPointerMove = useCallback(() => endIfIdle('pointer'), [endIfIdle])

  return {
    dragging: enabled && dragging,
    noticeGuestDrag,
    noticeGuestDrop,
    handlers: { onDragOver, onDragLeave, onDrop, onPointerMove, onPointerDown: onPointerMove }
  }
}
