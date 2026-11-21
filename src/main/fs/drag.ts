/**
 * Native drag from the Files tree to other apps (terminal, Finder, etc.) (TODO 677,
 * ARCHITECTURE.md 5.x).
 *
 * The renderer calls `preventDefault` on `dragstart` and passes only URIs to main (`fs.startDrag`, a fire-and-forget
 * that does not throw). Main passes each through `FsAccess.assertAllowed` (read, 12.7), turns it back into a logical path,
 * and starts the OS drag with `WebContents.startDrag` - the rule stays that only main holds paths
 * (the same shape as `drop-links.ts`). A URI that did not pass is silently dropped (no reply to the renderer).
 *
 * The icon is a small default image to satisfy Electron's requirement (macOS needs a non-empty `NativeImage`).
 * It is a 16x16 gray square (corners slightly transparent) that does not matter in content, embedded in the file.
 *
 * Only electron's `nativeImage` / `WebContents` types are used. `statSync` is used to decide whether something is a folder
 * (the same idea as `statKind` in `drop-links.ts`. Kept separate to avoid duplication - so the direction of dependencies does not grow).
 */
import { statSync } from 'node:fs'
import { nativeImage, type NativeImage, type WebContents } from 'electron'
import type { PathAccess } from '../../common/fs-policy.js'
import { log } from '../../common/logger.js'

/** Cap on the number of items passed in one drag (do not run `stat` without limit). */
export const MAX_DRAG_ITEMS = 64

export interface DragGate {
  assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string
}

/** true if the path is a folder, false if a file, null if it does not exist (symlinks are followed). */
function statKind(path: string): boolean | null {
  try {
    return statSync(path).isDirectory()
  } catch {
    return null
  }
}

export interface ResolveDragPathsDeps {
  readonly gate: DragGate
  readonly kindOf?: (path: string) => boolean | null
}

/**
 * Resolves a list of URIs to paths that really exist. Ones refused by `assertAllowed` and ones not found are silently dropped
 * (it does not throw - this is a one-way call that returns nothing to the renderer).
 */
export function resolveDragPaths(uris: unknown, deps: ResolveDragPathsDeps): string[] {
  if (!Array.isArray(uris)) return []
  const kindOf = deps.kindOf ?? statKind
  const paths: string[] = []
  for (const value of uris.slice(0, MAX_DRAG_ITEMS)) {
    if (typeof value !== 'string' || value.length > 8192) continue
    try {
      // First pass it "as a file" (the same reasoning as `drop-links.ts`: some exclusion rules apply only to folders),
      // and once it is known to be a folder, pass it again as a folder.
      const path = deps.gate.assertAllowed(value, false, 'read')
      const kind = kindOf(path)
      if (kind === null) continue
      if (kind) deps.gate.assertAllowed(value, true, 'read')
      if (!paths.includes(path)) paths.push(path)
    } catch {
      continue
    }
  }
  return paths
}

/** The default 16x16 drag icon (TODO 677). macOS requires a non-empty image. */
const DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGOYN29ZBSWYAcq4QyYeNWDUgFEDqG0A2RgAa3amr6Tafb4AAAAASUVORK5CYII='

let cachedIcon: NativeImage | null = null

function dragIcon(): NativeImage {
  if (cachedIcon === null) cachedIcon = nativeImage.createFromDataURL(DRAG_ICON_DATA_URL)
  return cachedIcon
}

export interface StartDragDeps extends ResolveDragPathsDeps {
  /** Replaced for tests. The default is the default icon made from `electron.nativeImage`. */
  readonly icon?: () => NativeImage
  /** Replaced for tests. The default is `sender.startDrag`. */
  readonly startDrag?: (sender: WebContents, item: { file: string; files: string[]; icon: NativeImage }) => void
}

/** The body of `fs.startDrag`. Re-validates the URIs from the renderer and starts the OS drag with only those that passed. */
export function startFilesDrag(sender: WebContents, uris: unknown, deps: StartDragDeps): void {
  const paths = resolveDragPaths(uris, deps)
  if (paths.length === 0) {
    log.info('fs.drag.empty', { requested: Array.isArray(uris) ? uris.length : 0 })
    return
  }
  log.info('fs.drag.start', { count: paths.length })
  const icon = (deps.icon ?? dragIcon)()
  const start = deps.startDrag ?? ((s, item) => s.startDrag(item))
  start(sender, { file: paths[0] ?? '', files: paths, icon })
}

/**
 * Wraps `startFilesDrag` so it can be called directly from `ipcMain.on` (a code-review fix, severe 3).
 * `ipcMain.on` is a one-way call that does not go through `guarded` in this file's `handlers.ts` (which wraps only `.handle`, TODO 572), so
 * if `sender.startDrag` throws (the file vanished, the window closed, etc.) it becomes an uncaught exception in main.
 * The try / catch was split out of the body so it can be validated directly here.
 */
export function startFilesDragGuarded(sender: WebContents, uris: unknown, deps: StartDragDeps): void {
  try {
    startFilesDrag(sender, uris, deps)
  } catch (err) {
    log.warn('ipc.fsStartDrag.failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
