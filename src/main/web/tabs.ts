/**
 * The per-window owner of web tabs (TODO 522, ARCHITECTURE 5.2.1) (`WebTabs`) and the memory (`WebTabsMemory`, `web.tabs` in `app_settings`)
 * that survives closing a window or quitting. **It does not import electron** (tests use plain objects).
 *
 * - When the tab changes, the renderer does `select(tab.url)` -> `web.load`. In TODO 530 `WebViewHost` started keeping
 *   up to the 3 most recent views per tab alive, and a live tab is swapped in without reloading (the page state is kept).
 *   Older tabs are reloaded. A tab is a label of "URL, title, favicon".
 * - `viewTabId` is "the tab the view is currently loading". It keeps navigation or titles coming from the view right after the tab
 *   changes (before the renderer's `load` arrives) from being attached to the new current tab.
 * - The memory is a list of per-window sets. On its first query (`web.tabs`) a window takes over one ownerless set
 *   (`pickStoredTabSet`). The set of a closed window stays with `closedAt` attached, and the next window opened takes it over. On shutdown
 *   (`shutdown`) pending writes are flushed and nothing is written afterwards (nothing is written after the DB is closed, 12.9).
 */
import {
  EMPTY_WEB_TABS,
  WEB_BLANK_URL,
  cleanWebTitle,
  insertTab,
  patchTab,
  pickStoredTabSet,
  removeTab,
  toStoredTabs,
  upsertStoredTabSet,
  type StoredWebTabSet,
  type WebTab,
  type WebTabsState
} from '@shared/web-tabs.js'
import { isWebViewerUrl } from '@shared/open-external.js'

let nextTabSerial = 0

/** A tab id (unique within a launch. Not written to the memory). */
function newTabId(): string {
  nextTabSerial += 1
  return `t${nextTabSerial}`
}

export interface WebTabsDeps {
  /** The tabs changed (send to this window's renderer). */
  onChange(state: WebTabsState): void
}

export class WebTabs {
  private state: WebTabsState = EMPTY_WEB_TABS
  /** The tab the view is currently loading. If null, notifications from the view are attached to no tab. */
  private viewTabId: string | null = null
  /**
   * Tabs whose URL was copied by `willLoad` (598-3). A "document navigation to the same URL" without this mark is a reload (Cmd+R, the button),
   * and Chromium does not emit `page-title-updated` when the title does not change, so the title is not emptied.
   */
  private readonly urlReplaced = new Set<string>()

  constructor(private readonly deps: WebTabsDeps) {}

  get current(): WebTabsState {
    return this.state
  }

  get activeTab(): WebTab | null {
    return this.state.tabs.find((tab) => tab.id === this.state.activeId) ?? null
  }

  /** Restores from the memory (only the first time). */
  restore(tabs: readonly { url: string; title: string }[], active: number): WebTabsState {
    const restored = tabs.map((tab) => ({ id: newTabId(), url: tab.url, title: tab.title, favicon: null }))
    this.state = { tabs: restored, activeId: restored[active]?.id ?? restored[0]?.id ?? null }
    return this.state
  }

  /** A new tab (to the right of the current tab, and it becomes the current tab). If `url` is not http(s), a blank tab. Null at the limit. */
  open(url: unknown): WebTabsState | null {
    const tab: WebTab = {
      id: newTabId(),
      url: isWebViewerUrl(url) ? url : WEB_BLANK_URL,
      title: '',
      favicon: null
    }
    const next = insertTab(this.state, tab)
    if (next === this.state) return null
    this.set(next)
    return next
  }

  /** Changes the current tab. False for an unknown id. */
  activate(id: unknown): boolean {
    if (typeof id !== 'string' || !this.state.tabs.some((tab) => tab.id === id)) return false
    if (this.state.activeId !== id) this.set({ tabs: this.state.tabs, activeId: id })
    return true
  }

  /** Closes a tab. If the view was showing the closed tab, later notifications from the view are attached to no tab. */
  close(id: unknown): boolean {
    if (typeof id !== 'string') return false
    const next = removeTab(this.state, id)
    if (next === this.state) return false
    if (this.viewTabId === id) this.viewTabId = null
    this.urlReplaced.delete(id)
    this.set(next)
    return true
  }

  /**
   * Right before making the view load `url` (`web.load`). Copies the URL to the current tab and makes it the destination of the view's notifications.
   * If there is no tab at all, creates one (when restoring a thread's memory or opening a page by back / forward).
   */
  willLoad(url: string): string | null {
    let active = this.activeTab
    if (active === null) {
      if (this.open(url) === null) return null
      active = this.activeTab
      if (active === null) return null
    } else if (active.url !== url) {
      this.urlReplaced.add(active.id)
      this.set(patchTab(this.state, active.id, { url, title: active.url === WEB_BLANK_URL ? '' : active.title }))
    }
    this.viewTabId = active.id
    return active.id
  }

  /** The tab with this id (null if none). */
  tab(id: string | null | undefined): WebTab | null {
    if (id === null || id === undefined) return null
    return this.state.tabs.find((item) => item.id === id) ?? null
  }

  /**
   * The view's main frame navigated. `full` is a per-document navigation (`did-navigate`); false is in-page (`#`, pushState).
   * `tabId` is that view's tab (TODO 530: a view per tab). If omitted, `viewTabId`.
   */
  navigated(url: string, full: boolean, tabId?: string | null): void {
    const id = tabId ?? this.viewTabId
    const tab = id === null ? undefined : this.state.tabs.find((item) => item.id === id)
    if (id === null || tab === undefined) return
    const sameHost = hostOf(tab.url) === hostOf(url)
    // 598-3: a document navigation to the same URL (a reload) keeps the title. A navigation after `willLoad` changed the URL empties it.
    const reload = full && url === tab.url && !this.urlReplaced.has(id)
    if (full) this.urlReplaced.delete(id)
    this.set(
      patchTab(this.state, id, {
        url,
        // The title is empty (= show the host name) from when the document changes until the next `page-title-updated`. The favicon, from when the host changes.
        ...(full && !reload ? { title: '' } : {}),
        ...(full && !sameHost ? { favicon: null } : {})
      })
    )
  }

  /** The page title. */
  titled(title: string, tabId?: string | null): void {
    const id = tabId ?? this.viewTabId
    if (id === null || !this.state.tabs.some((item) => item.id === id)) return
    this.set(patchTab(this.state, id, { title: cleanWebTitle(title) }))
  }

  /**
   * TODO 601: loading the tab's view failed. A failed navigation delivers no title, so the label's title becomes the host name of the
   * failed URL (owner decision 2026-10-10. The previous page's title is not kept).
   */
  failed(url: string, tabId?: string | null): void {
    this.titled(hostOf(url) ?? '', tabId)
  }

  /** The favicon (data URL). `forUrl` is the tab's URL at the time of fetching - dropped if the tab moved on while fetching. */
  favicon(tabId: string, forUrl: string, dataUrl: string | null): void {
    const tab = this.state.tabs.find((item) => item.id === tabId)
    if (tab === undefined || hostOf(tab.url) !== hostOf(forUrl)) return
    this.set(patchTab(this.state, tabId, { favicon: dataUrl }))
  }

  /** The tab that is currently the destination of the view's notifications (the marker used when fetching a favicon). */
  get viewTab(): WebTab | null {
    return this.state.tabs.find((tab) => tab.id === this.viewTabId) ?? null
  }

  private set(next: WebTabsState): void {
    if (next === this.state) return
    this.state = next
    this.deps.onChange(next)
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Memory (persistence of the tabs)
// ---------------------------------------------------------------------------

export interface WebTabsMemoryDeps {
  read(): readonly StoredWebTabSet[]
  write(sets: readonly StoredWebTabSet[]): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Interval for batching writes. A tab's title and favicon change a few times on every load. */
export const WEB_TABS_SAVE_DELAY_MS = 500

export class WebTabsMemory {
  private readonly live = new Set<string>()
  private readonly pending = new Map<string, WebTabsState>()
  private timer: unknown = null
  private stopped = false

  constructor(private readonly deps: WebTabsMemoryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Takes over the memory that window `owner` uses (null if none). The taken-over set belongs to that window from then on. */
  adopt(owner: string): StoredWebTabSet | null {
    if (this.stopped) return null
    this.live.add(owner)
    let sets: readonly StoredWebTabSet[]
    try {
      sets = this.deps.read()
    } catch {
      return null
    }
    const picked = pickStoredTabSet(sets, this.live)
    if (picked === null) return null
    const claimed: StoredWebTabSet = { ...picked, owner, closedAt: null }
    const rest = sets.filter((set) => set !== picked)
    this.writeSafely(upsertStoredTabSet(rest, owner, claimed, this.live))
    return claimed
  }

  /** The tabs changed (written in batches). */
  save(owner: string, state: WebTabsState): void {
    if (this.stopped) return
    this.live.add(owner)
    this.pending.set(owner, state)
    if (this.timer !== null) return
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = setTimer(() => {
      this.timer = null
      this.flush()
    }, WEB_TABS_SAVE_DELAY_MS)
  }

  /** The window closed. Attaches the closing time to that window's set and writes at once (the next window opened takes it over). */
  release(owner: string, state: WebTabsState): void {
    if (this.stopped) return
    this.pending.delete(owner)
    this.live.delete(owner)
    this.writeSet(owner, state, this.now())
  }

  /** Flushes pending writes. */
  flush(): void {
    if (this.stopped) return
    const entries = [...this.pending.entries()]
    this.pending.clear()
    if (entries.length === 0) return
    let sets: readonly StoredWebTabSet[]
    try {
      sets = this.deps.read()
    } catch {
      return
    }
    for (const [owner, state] of entries) sets = this.apply(sets, owner, state, null)
    this.writeSafely(sets)
  }

  /** Shutdown (`before-quit`, before the DB is closed). Flushes pending writes and writes nothing afterwards. */
  shutdown(): void {
    if (this.timer !== null) {
      const clear = this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      clear(this.timer)
      this.timer = null
    }
    this.flush()
    this.stopped = true
  }

  private writeSet(owner: string, state: WebTabsState, closedAt: number | null): void {
    let sets: readonly StoredWebTabSet[]
    try {
      sets = this.deps.read()
    } catch {
      return
    }
    this.writeSafely(this.apply(sets, owner, state, closedAt))
  }

  private apply(
    sets: readonly StoredWebTabSet[],
    owner: string,
    state: WebTabsState,
    closedAt: number | null
  ): readonly StoredWebTabSet[] {
    const stored = toStoredTabs(state)
    const set: StoredWebTabSet | null =
      stored.tabs.length === 0
        ? null
        : { owner, tabs: stored.tabs, active: stored.active, updatedAt: this.now(), closedAt }
    return upsertStoredTabSet(sets, owner, set, this.live)
  }

  private writeSafely(sets: readonly StoredWebTabSet[]): void {
    try {
      this.deps.write(sets)
    } catch {
      // Even if writing fails (the DB is unavailable), the tabs themselves are alive. They are written again on the next change.
    }
  }
}
