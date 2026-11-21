/**
 * Window-received gestures to the viewer's back / forward (TODO 369, wave 20 bundle D, ARCHITECTURE 5.4).
 * A pure function independent of electron, which `createWindow` in `index.ts` connects to `swipe` / `app-command`.
 *
 * - **macOS `swipe`** (an event of `BrowserWindow`). As Electron's note says, it arrives only as a **three-finger** swipe when the system setting
 *   "Swipe between pages" is "Swipe with two or three fingers" (or three fingers).
 *   The two-finger swipe (the current macOS default) is Chromium's "history swipe" (a browser-side implementation), and
 *   Electron has no entry point for it, so it was passed over (bundle D of `docs/notes/wave20.md`).
 *   The direction is the same as Safari: fingers to the right = back, to the left = forward. Electron's `right` is NSEvent's
 *   `deltaX == -1` (fingers moved to the right).
 * - **`app-command` on Windows / Linux**. The mouse back / forward buttons come here too (the renderer's
 *   `mouseup` 3 / 4 is picked up only on mac - picking up both would move two steps).
 */
import type { MenuCommand } from '@shared/ipc.js'

export type ViewerNavCommand = Extract<MenuCommand, 'viewerBack' | 'viewerForward'>

export function navFromSwipe(direction: string): ViewerNavCommand | null {
  if (direction === 'right') return 'viewerBack'
  if (direction === 'left') return 'viewerForward'
  return null
}

export function navFromAppCommand(command: string): ViewerNavCommand | null {
  if (command === 'browser-backward') return 'viewerBack'
  if (command === 'browser-forward') return 'viewerForward'
  return null
}
