/**
 * Sidebar collapsing (ARCHITECTURE.md 5.5.1 "Collapsing", T27 / TODO 38).
 *
 * **Dragging never shrinks it to 0** (T24). A zero-width divider cannot be grabbed and leaves no way back.
 * Collapsing is the job of the **icon bar toggle**: `.activity-bar` (48px) stays visible when collapsed,
 * so "press again to restore" is always in view. Same shape as VSCode.
 *
 * This file holds **only the decision logic and persistence**; it knows nothing about the DOM or React
 * (same convention as `sidebarWidth.ts`).
 *
 * - Width and collapsed state are **separate values**. The pre-collapse width stays in `aios.sidebarWidth`
 *   as is, so opening goes back to it. **Never store 0 as a width**: it would fall outside
 *   `loadSidebarWidth`'s range, drop to the default 320px, and the remembered width would be lost.
 * - Whether it is collapsed is "how this window is being used right now", not a setting. It used to be in `localStorage`
 *   (`aios.sidebarCollapsed`), which all windows of the profile share; since TODO 1327 main keeps it **per window** with the
 *   viewer's (`windowLayout.ts`, `WindowLayouts`): a new window starts open, a restored one as it was. No migration.
 */

/** The icon bar mode and whether the sidebar is collapsed. Part of the state `threadStore` holds. */
export interface SidebarView<M> {
  readonly mode: M
  readonly collapsed: boolean
}

/**
 * The next state after an icon is pressed.
 *
 * - Pressing the **icon of the mode currently shown** toggles collapse / open.
 * - Pressing the **icon of another mode** opens that mode even if collapsed (if only the mode changed
 *   behind a collapsed sidebar, the next open would surprise the user with a different screen).
 *
 * `M` is a type parameter because `SidebarMode` lives in `threadStore.ts` (to avoid a circular import).
 */
export function pressMode<M>(view: SidebarView<M>, pressed: M): SidebarView<M> {
  if (pressed === view.mode) return { mode: pressed, collapsed: !view.collapsed }
  return { mode: pressed, collapsed: false }
}

/** Toggle from ⌘B (menu). Does not change the mode. */
export function toggleCollapsed<M>(view: SidebarView<M>): SidebarView<M> {
  return { mode: view.mode, collapsed: !view.collapsed }
}
