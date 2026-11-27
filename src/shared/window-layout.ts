/**
 * Which panes a window hides (TODO 1327, ARCHITECTURE 5.5.1 "window layout"). The same two toggles as VS Code's
 * "Toggle Primary Side Bar" (Cmd+B) and "Toggle Secondary Side Bar" (Alt+Cmd+B); in aios the secondary one is ViewerPane.
 *
 * **Per window, not per conversation** (owner decision 2026-11-27): main keeps one value per window (`webContents.id`), so a
 * reload keeps it, the quit record brings it back with the window (item 36), and a new window (Cmd+N) starts from the default.
 * The renderer owns the state and reports every change; main only remembers it (and checks the View menu items).
 */
export interface WindowLayout {
  /** The sidebar (icon bar mode panel) is collapsed. The icon bar stays (5.5.1, T27). */
  readonly sidebarHidden: boolean
  /** ViewerPane is hidden. What it shows (and any draft) is kept; opening something shows it again (5.5). */
  readonly viewerHidden: boolean
}

/** Both shown: a new window, a window with no record, and anything unreadable. */
export const DEFAULT_WINDOW_LAYOUT: WindowLayout = { sidebarHidden: false, viewerHidden: false }

/** Reads a layout sent over IPC or stored. Anything that is not exactly two booleans is null. */
export function parseWindowLayout(value: unknown): WindowLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const sidebarHidden = record['sidebarHidden']
  const viewerHidden = record['viewerHidden']
  if (typeof sidebarHidden !== 'boolean' || typeof viewerHidden !== 'boolean') return null
  return { sidebarHidden, viewerHidden }
}

export function sameWindowLayout(a: WindowLayout, b: WindowLayout): boolean {
  return a.sidebarHidden === b.sidebarHidden && a.viewerHidden === b.viewerHidden
}

/**
 * What the window shows **now** (TODO 1327 review): the checks of View > Sidebar / Viewer and, for the viewer, whether its Web pages
 * may play. Not a remembered value: `viewer` is also false while a window too narrow for both panes folds the viewer to its strip,
 * which `WindowLayout.viewerHidden` (what the user chose, restored after a relaunch) does not say. Null when no window takes the command.
 */
export interface LayoutChecks {
  readonly sidebar: boolean
  readonly viewer: boolean
}
