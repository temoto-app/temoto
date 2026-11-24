/**
 * Pages whose tab was closed in this window (TODO 1326, ARCHITECTURE 5.5). Pure; `webStore.ts` holds the one instance per window.
 *
 * The tab row is per window but the viewer's memory is per conversation, so a tab shown by conversation A can be closed while B
 * is in front; coming back to A must not reload the closed page into whatever tab is current. Only pages this window closed
 * count: a remembered page that simply has no tab here (another window, a fresh start) still loads as before (TODO 812).
 *
 * **A page stops counting as closed as soon as a tab of this window shows it again** (review Y1 of TODO 1326): the mark is about
 * "the user closed it and has not opened it since", not "it was once closed". Without this, a page reopened in another
 * conversation and then replaced in its tab (another conversation's restore loads into the current tab) was still taken as
 * closed, and coming back dropped it from that conversation's history - against TODO 812. Pages are keyed like
 * `findOpenWebTab` (the URL without `#`). Newest last, bounded (`CLOSED_WEB_PAGES_LIMIT`); memory only.
 */
import { WEB_BLANK_URL, type WebTabsState } from '@shared/web-tabs.js'
import { isWebViewerUrl } from '@shared/open-external.js'

export const CLOSED_WEB_PAGES_LIMIT = 64

/** The URL with everything after `#` dropped (TODO 560's "same page" check). null if it cannot be parsed. */
export function withoutFragment(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return null
  }
}

/** The key of a page that can be marked (an http(s) page; never a blank tab or a file). */
function pageKey(url: string | null): string | null {
  if (url === null || url === WEB_BLANK_URL || !isWebViewerUrl(url)) return null
  return withoutFragment(url)
}

function shownKeys(tabs: WebTabsState): Set<string> {
  const keys = new Set<string>()
  for (const tab of tabs.tabs) {
    const key = withoutFragment(tab.url)
    if (key !== null) keys.add(key)
  }
  return keys
}

export class ClosedWebPages {
  private readonly keys: string[] = []

  constructor(private readonly limit: number = CLOSED_WEB_PAGES_LIMIT) {}

  get size(): number {
    return this.keys.length
  }

  /** A tab showing `url` was closed; `tabsAfter` is the window's tabs after the close. Not marked while another tab still shows it. */
  note(url: string, tabsAfter: WebTabsState): void {
    const key = pageKey(url)
    if (key === null || shownKeys(tabsAfter).has(key)) return
    this.drop(key)
    this.keys.push(key)
    if (this.keys.length > this.limit) this.keys.shift()
  }

  /** `url` is being shown or loaded again: it is no longer a closed page. */
  forget(url: string): void {
    const key = pageKey(url)
    if (key !== null) this.drop(key)
  }

  /** The window's tabs changed: every page a tab shows now is no longer closed (whichever path opened it). */
  forgetShown(tabs: WebTabsState): void {
    if (this.keys.length === 0) return
    const shown = shownKeys(tabs)
    for (let i = this.keys.length - 1; i >= 0; i -= 1) {
      if (shown.has(this.keys[i]!)) this.keys.splice(i, 1)
    }
  }

  /** Whether `url` is a page this window closed and that no tab shows now. */
  has(url: string | null, tabs: WebTabsState): boolean {
    const key = pageKey(url)
    if (key === null || !this.keys.includes(key)) return false
    return !shownKeys(tabs).has(key)
  }

  clear(): void {
    this.keys.length = 0
  }

  private drop(key: string): void {
    const at = this.keys.indexOf(key)
    if (at >= 0) this.keys.splice(at, 1)
  }
}
