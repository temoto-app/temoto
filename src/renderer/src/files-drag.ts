/**
 * Remember the URIs carried by a drag in progress from the Files tree (TODO 677 / 443).
 *
 * A row of the Sidebar tree switches to an OS native drag on `dragstart` (`window.aios.fs.startDrag`,
 * main's `webContents.startDrag`), so that a full path / copy is handed as it is to a terminal or Finder.
 * A native drag cannot put its own MIME type (`text/uri-list`) on `DataTransfer`, so a drop that
 * comes back inside aios (the conversation pane's overlay, the viewer's overlay and `.viewer-body`, inside the viewer's iframe, the prompt box's textarea)
 * cannot be told apart from a real file drop from Finder (`dataTransfer.files`, which becomes an attachment).
 *
 * So at `dragstart` it is remembered here that "a drag from the Files tree is now in progress, and the URIs it carries are these", and the drop receivers
 * (`droppedUris` in `drop-uris.ts` / `collectDrop` in `viewer-drop.ts`) look here first.
 * If there is a value, it is treated the same as the former `text/uri-list` (= the remembered URIs are used as they are); if not (a real drop
 * from Finder), `DataTransfer` is read as before. It is always forgotten after dragend / drop (not carried
 * over to the next drag).
 *
 * **Fix from code-review (TODO 677, 2026-10-11)**: because `dragstart` calls `preventDefault()`, Chromium does not
 * fire `dragend` on that row (or anywhere in the document): per spec, a `dragstart` that is `preventDefault()`ed
 * cancels DnD itself. What follows (`webContents.startDrag`) is a call in main and is completely separate, so from the renderer's DOM
 * there is no way at all to see "when it ended". Rather than rely on a single signal, several safeguards are layered:
 * 1. It expires automatically `FILES_DRAG_TTL_MS` (60 seconds) after being remembered (`liveCurrent`).
 * 2. `installFilesDragForgetGuards()` reliably forgets on the document-wide `dragend` / `drop` / `mouseup` / `pointerup` and
 *    on the window's `focus` returning (called once in bootstrap).
 * 3. Each drop receiver (those that call `droppedUris` directly) also uses it up by calling `endFilesDrag()` after using it.
 * 4. If a real `File` (from Finder) is on the drop's `DataTransfer` and its name matches none of the remembered URIs,
 *    the remembered ones are not used and the real one is read (`mismatchesRememberedFiles`, so that stale memory
 *    does not hijack a new real drop).
 */

/** Time (ms) until it expires automatically after being remembered. One of the safeguards (1 above). */
export const FILES_DRAG_TTL_MS = 60_000

let current: readonly string[] | null = null
let startedAt = 0

/** Called on the Sidebar's `dragstart`. An empty array is treated the same as none. */
export function beginFilesDrag(uris: readonly string[]): void {
  current = uris.length > 0 ? [...uris] : null
  startedAt = Date.now()
}

/** Called after `dragend` / a drop has been fully handled. Not left over for the next drag. */
export function endFilesDrag(): void {
  current = null
}

/** Expire `current` by TTL and return it (the side effects are the same however many times it is called). */
function liveCurrent(): readonly string[] | null {
  if (current !== null && Date.now() - startedAt > FILES_DRAG_TTL_MS) {
    current = null
  }
  return current
}

/** The URIs carried by the drag in progress from the Files tree. Null if none. */
export function currentFilesDrag(): readonly string[] | null {
  return liveCurrent()
}

/**
 * Whether a drag from the Files tree is in progress. It has not been confirmed what a native drag puts in `DataTransfer.types`
 * (it can only be checked on a real machine), so some receivers look at this in addition to the `carriesFiles` decision
 * (`carriesFiles(types) || filesDragActive()`).
 */
export function filesDragActive(): boolean {
  return liveCurrent() !== null
}

/** The minimal `File`-like shape (duck typing, an element of `DataTransfer.files`). */
interface NamedFileLike {
  readonly name?: unknown
}

/**
 * Whether the remembered URIs disagree with the names in the `DataTransfer.files` actually dropped (safeguard 4).
 *
 * If no element has a name (test doubles, calls not via `webUtils`, etc.), no decision is made,
 * so as not to break existing callers (fixtures that have only `uri`). If some elements have names and none of them
 * matches the last path element of a remembered URI, it is considered "disagreeing".
 */
export function mismatchesRememberedFiles(files: ArrayLike<unknown>, remembered: readonly string[]): boolean {
  const named = Array.from(files)
    .map((f) => (f as NamedFileLike).name)
    .filter((name): name is string => typeof name === 'string')
  if (named.length === 0) return false
  const basenames = new Set(
    remembered.map((uri) => {
      const last = uri.split('/').pop() ?? ''
      try {
        return decodeURIComponent(last)
      } catch {
        return last
      }
    })
  )
  return !named.some((name) => basenames.has(name))
}

/** The shape that `installFilesDragForgetGuards` needs (tests can also substitute a jsdom-free `EventTarget`). */
export interface DragForgetTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/**
 * Reliably forget on document-wide signals (safeguard 2). Because of `dragstart`'s `preventDefault()`, `dragend` on the row itself
 * is not fired, but on the premise that some other path (drop, mouseup, pointerup, the window's focus returning) can
 * catch it, several are layered. Called once in bootstrap (at renderer startup). The return value is for cleanup.
 */
export function installFilesDragForgetGuards(target: DragForgetTarget = window): () => void {
  const forget = (): void => endFilesDrag()
  // Placed on the bubble side (not capture): so that the individual drop receivers (overlay, Composer, ThreadList, etc.)
  // finish reading `currentFilesDrag()` first, and it is forgotten here last.
  target.addEventListener('dragend', forget)
  target.addEventListener('drop', forget)
  target.addEventListener('mouseup', forget)
  target.addEventListener('pointerup', forget)
  target.addEventListener('focus', forget)
  return () => {
    target.removeEventListener('dragend', forget)
    target.removeEventListener('drop', forget)
    target.removeEventListener('mouseup', forget)
    target.removeEventListener('pointerup', forget)
    target.removeEventListener('focus', forget)
  }
}
