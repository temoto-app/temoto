/**
 * Closing the view in front works like closing a browser tab (TODO 1297 / 1326, ARCHITECTURE 5.5). One rule for a file (⌘W) and a
 * Web tab (⌘W, the Sidebar's open tabs; TODO 1326 owner decision 2026-11-23). The heading's X that started this went away in TODO 1326.
 *
 * ViewerPane is always on screen; there is no "pane closed" state any more. Closing the shown view:
 *
 * - drops every step of the closed URI from the conversation's viewer history (TODO 369 / 772), so pressing close again
 *   never comes back to it (adjacent steps of one URI left behind merge into one), along with the blank-tab steps when no blank
 *   tab is left in the window, and
 * - moves focus to **the view seen just before** (the nearest earlier step of the history, then the nearest later one when
 *   nothing earlier is left). A Web step counts only while its tab is still open in this window; a blank tab never does.
 * - When nothing is left, the pane stays and shows its empty state (`select(null)`). **Never another open tab of the window that
 *   is not in this conversation's history** (the tab row is per window, so it may be another conversation's page).
 *
 * The move is not a new history step (the index is moved to the chosen step, like back / forward), so it is done under the
 * `navigating` marker. `planViewerClose` is pure (`test/viewer-close.test.ts`); `closeViewerUri` in `webStore.ts` wires it to the
 * stores (called by `closeShownView`, `closeWebTab` and the restore of a conversation whose page was closed, `settleClosedWebView`).
 */
import type { ViewerScrollPosition } from '@shared/plugin.js'
import { positionOf, prunePositions } from '@shared/viewer-position.js'
import { WEB_BLANK_URL, isWebPaneUri, type WebTab, type WebTabsState } from '@shared/web-tabs.js'
import { EMPTY_HISTORY, type HistoryEntry, type ViewerHistory } from './viewer-history.js'

export type ViewerCloseTarget =
  | {
      readonly kind: 'file'
      readonly uri: string
      readonly highlight: string | null
      /** The position last seen in that document (TODO 1146). null = from the top. */
      readonly position: ViewerScrollPosition | null
    }
  | { readonly kind: 'tab'; readonly tab: WebTab }
  | { readonly kind: 'empty' }

export interface ViewerClosePlan {
  readonly history: ViewerHistory
  readonly target: ViewerCloseTarget
}

/** The open tab of this window showing `url` (the current tab first). Same matching as `findOpenWebTab`, minus the `#` part. */
function openTabFor(tabs: WebTabsState, url: string): WebTab | null {
  const key = url.split('#', 1)[0]
  const same = (tab: WebTab): boolean => tab.url.split('#', 1)[0] === key
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  if (active !== undefined && same(active)) return active
  return tabs.tabs.find(same) ?? null
}

/** Order in which the remaining steps are tried: the nearest earlier ones first, then the nearest later ones. */
function candidateOrder(length: number, start: number): readonly number[] {
  const order: number[] = []
  for (let i = Math.min(start, length - 1); i >= 0; i -= 1) order.push(i)
  for (let i = Math.max(start + 1, 0); i < length; i += 1) order.push(i)
  return order
}

/**
 * Merges runs of adjacent steps with the same URI, which dropping a step can leave behind ([A, B, A] without B is [A, A],
 * and "forward" would then change nothing). The history never holds two adjacent steps of one URI otherwise (opening the
 * same URI again only replaces the search term, `recordVisit`), so a run keeps one step: `prefer` (the chosen
 * destination) when it is in the run, else the run's last step (the newer search term). Returns the merged steps and,
 * for each kept step, its index in them.
 */
function mergeAdjacent(
  entries: readonly HistoryEntry[],
  prefer: HistoryEntry | null
): { readonly entries: readonly HistoryEntry[]; readonly slot: ReadonlyMap<HistoryEntry, number> } {
  const merged: HistoryEntry[] = []
  const slot = new Map<HistoryEntry, number>()
  for (const entry of entries) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.uri === entry.uri) {
      if (last !== prefer) merged[merged.length - 1] = entry
    } else {
      merged.push(entry)
    }
    slot.set(entry, merged.length - 1)
  }
  return { entries: merged, slot }
}

/**
 * What closing `closedUri` (the view in front) leads to. `tabs` is this window's Web tabs after the close (for a file close,
 * the current tabs).
 */
export function planViewerClose(
  history: ViewerHistory | undefined,
  closedUri: string,
  tabs: WebTabsState
): ViewerClosePlan {
  const source = history ?? EMPTY_HISTORY
  // A blank step stands for a blank tab (it is never persisted, TODO 772); with no blank tab left in the window it leads nowhere,
  // so it goes with the close like the closed view's own steps (TODO 1326 review Y2: the blank step of a tab that was typed into
  // and then closed stayed, and "forward" reached a Web pane with no current tab).
  const blankOpen = tabs.tabs.some((tab) => tab.url === WEB_BLANK_URL)
  const dropped = (uri: string): boolean => uri === closedUri || (uri === WEB_BLANK_URL && !blankOpen)
  const kept = source.entries.filter((entry) => !dropped(entry.uri))
  const positions = prunePositions(
    source.positions,
    kept.map((entry) => entry.uri)
  )
  // The scan starts at the current step (or just before it when it is the closed view itself), on the original indices.
  const current = source.entries[source.index]
  const start = current?.uri === closedUri ? source.index - 1 : source.index
  for (const i of candidateOrder(source.entries.length, start)) {
    const entry = source.entries[i]
    if (entry === undefined || dropped(entry.uri)) continue
    let tab: WebTab | null = null
    if (isWebPaneUri(entry.uri)) {
      if (entry.uri === WEB_BLANK_URL) continue
      tab = openTabFor(tabs, entry.uri)
      if (tab === null) continue
    }
    const merged = mergeAdjacent(kept, entry)
    const index = merged.slot.get(entry) ?? -1
    const next: ViewerHistory =
      positions === undefined
        ? { entries: merged.entries, index }
        : { entries: merged.entries, index, positions }
    if (tab !== null) return { history: next, target: { kind: 'tab', tab } }
    return {
      history: next,
      target: {
        kind: 'file',
        uri: entry.uri,
        highlight: entry.highlight,
        position: positionOf(positions, entry.uri) ?? null
      }
    }
  }
  const rest = mergeAdjacent(kept, null).entries
  const index = rest.length - 1
  const restHistory: ViewerHistory =
    positions === undefined ? { entries: rest, index } : { entries: rest, index, positions }
  return { history: restHistory, target: { kind: 'empty' } }
}
