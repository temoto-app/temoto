/**
 * The height allocation of the Sidebar's web mode three windows (from the top: History / Favorite / Open tabs, TODO 522).
 * Same shape as the VS Code Explorer: windows collapse by their heading, and the boundaries between open windows are moved by dragging. A pure function independent of the DOM
 * (`test/web-tabs.test.ts`).
 *
 * - The heading is always shown (`SECTION_HEADER_PX`). A collapsed window is just its heading.
 * - The open-tabs window is **small and pinned at the very bottom** (`tabsHeight`, default 168px - the open question in TODO 522 -> as recommended).
 *   If both of the upper two are collapsed it takes all the rest (no empty space is left below).
 * - History and Favorite split the rest by `historyRatio`. If only one is open it takes all the rest.
 */
import type { WebSectionId, WebSectionsLayout } from '@shared/web-tabs.js'

/** The height of a window's heading (the same value as the CSS `.web-section-header`). */
export const SECTION_HEADER_PX = 22
/** The minimum body height of an open window (2 rows). */
export const SECTION_MIN_PX = 48

export type SectionHeights = Readonly<Record<WebSectionId, number>>

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

/** The body height (px, headings not included). `total` is the height of the box holding the three windows. */
export function layoutWebSections(total: number, layout: WebSectionsLayout): SectionHeights {
  const { collapsed } = layout
  const available = Math.max(0, (Number.isFinite(total) ? total : 0) - 3 * SECTION_HEADER_PX)
  const upperOpen = (collapsed.history ? 0 : 1) + (collapsed.favorites ? 0 : 1)
  let tabs = 0
  if (!collapsed.tabs) {
    tabs = upperOpen === 0 ? available : clamp(layout.tabsHeight, SECTION_MIN_PX, available - upperOpen * SECTION_MIN_PX)
    tabs = Math.min(tabs, available)
  }
  const rest = Math.max(0, available - tabs)
  if (upperOpen === 2) {
    const history = Math.round(clamp(rest * layout.historyRatio, SECTION_MIN_PX, rest - SECTION_MIN_PX))
    return { history: Math.min(history, rest), favorites: Math.max(0, rest - history), tabs }
  }
  return {
    history: collapsed.history ? 0 : rest,
    favorites: collapsed.favorites ? 0 : rest,
    tabs
  }
}

/** The kind of boundary drag. `upper` is the boundary between History and Favorite, `lower` the boundary between Favorite (or History) and Open tabs. */
export type SectionSplitter = 'upper' | 'lower'

/** Whether that boundary can be dragged (the windows on both sides must be open. For the lower boundary, either of the upper two being open is enough). */
export function splitterActive(splitter: SectionSplitter, layout: WebSectionsLayout): boolean {
  const { collapsed } = layout
  if (splitter === 'upper') return !collapsed.history && !collapsed.favorites
  return !collapsed.tabs && (!collapsed.history || !collapsed.favorites)
}

/**
 * The result of a drag. `start` is the height when grabbed (the result of `layoutWebSections`), `dy` is the vertical movement since grabbing (down is positive).
 * The upper boundary changes History's share, and the lower boundary changes the tabs' height.
 */
export function dragWebSections(
  layout: WebSectionsLayout,
  start: SectionHeights,
  splitter: SectionSplitter,
  dy: number
): WebSectionsLayout {
  if (!splitterActive(splitter, layout) || !Number.isFinite(dy)) return layout
  if (splitter === 'upper') {
    const rest = start.history + start.favorites
    if (rest <= 0) return layout
    const history = clamp(start.history + dy, SECTION_MIN_PX, rest - SECTION_MIN_PX)
    return { ...layout, historyRatio: Math.min(0.9, Math.max(0.1, history / rest)) }
  }
  const room = start.history + start.favorites + start.tabs
  const upperOpen = (layout.collapsed.history ? 0 : 1) + (layout.collapsed.favorites ? 0 : 1)
  const tabs = clamp(start.tabs - dy, SECTION_MIN_PX, room - upperOpen * SECTION_MIN_PX)
  return { ...layout, tabsHeight: Math.round(tabs) }
}

/** A heading was pressed: collapse / expand. */
export function toggleWebSection(layout: WebSectionsLayout, id: WebSectionId): WebSectionsLayout {
  return { ...layout, collapsed: { ...layout.collapsed, [id]: !layout.collapsed[id] } }
}

/** The time of a history row: hours:minutes if today, month/day if earlier (the display language's notation is left to Intl). */
export function historyTimeLabel(at: number, now: number = Date.now()): string {
  const date = new Date(at)
  if (date.toDateString() === new Date(now).toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

/** The destination index of a Favorite row reordered by drag (the `from`-th was dropped above the `over`-th row). null if it does not move. */
export function favoriteDropIndex(from: number, over: number, count: number): number | null {
  if (from < 0 || from >= count || over < 0) return null
  const to = Math.min(count - 1, over)
  return to === from ? null : to
}
