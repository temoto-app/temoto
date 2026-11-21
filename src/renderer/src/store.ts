/**
 * Renderer state (Zustand).
 *
 * The renderer holds neither file scans nor the index. It receives only diffs from main
 * (ARCHITECTURE.md chapter 3). What lives here is the minimal copy needed for display.
 */
import { create } from 'zustand'
import type { AppInfo, FileEntry, FileSearchResult, ScanStatus } from '@shared/types.js'
import type { ViewerSelection } from '@shared/thread.js'
import type { DiffLayout, DiffPayload, DiffSide, ViewerScrollPosition } from '@shared/plugin.js'
import type { DraftConflictNotice } from './draft-conflict.js'
import type { TransientFileView } from './transient-file.js'
import { helpUri } from '@shared/help.js'
import type { Locale } from '@shared/locale.js'
import { withDraft, withoutDraft, type DraftTable, type StoredDraft } from './viewer-drafts.js'
import type { ViewerHistory } from './viewer-history.js'
import {
  viewerLineRequest,
  viewerRestoreRequest,
  viewerPageRequest,
  viewerRecenterRequest,
  type ViewerRevealRequest,
  type ViewerRecenterRequest
} from './viewer-line.js'
import { revealChain } from './reveal.js'
import { isAppBundle } from '@shared/app-bundle.js'
import {
  createdChain,
  expandChain,
  limitChildren,
  limitedAncestors,
  moreRowEntry,
  moreRowKey,
  replaceUriPrefix,
  shouldAutoReveal
} from './file-tree.js'
import { renameHistoryUrisIn } from '@shared/viewer-history.js'
import { useSearch } from './searchStore.js'
import { activeCwdUri } from './active-cwd.js'
import { initFileSort } from './fileSortStore.js'
import { initHiddenFiles, listOptionsFor, pinForExpand } from './hiddenFilesStore.js'
import { parentUri } from './hidden-files.js'
import { createSubscriptionSlot } from './subscription-slot.js'
import type { ListDirectoryOptions } from '@shared/types.js'

export interface TreeRow {
  readonly entry: FileEntry
  /**
   * Row identifier (TODO 520). Shortcuts (such as `~/Downloads`) appear twice with the same folder under `~/`,
   * so the URI alone does not make a row unique. The root's order is prefixed (`<root index>|<URI>`).
   * Open/closed and listing state are still keyed by URI (the same folder has the same state).
   */
  readonly key: string
  readonly depth: number
  readonly expanded: boolean
  readonly loading: boolean
  /**
   * For an "... N more" row (TODO 904), its contents. `entry` is a look-alike shaped like the other rows
   * (it matches no URI); the paths for pressing the row and for Enter check `more` first. Absent on ordinary rows.
   */
  readonly more?: {
    readonly parentUri: string
    /** Number of omitted entries. */
    readonly hidden: number
    /** Where to move the key position when pressed (the key of the first omitted child's row). */
    readonly nextKey: string
  }
}

interface AppState {
  appInfo: AppInfo | null
  scan: ScanStatus | null
  roots: readonly FileEntry[]
  children: Record<string, readonly FileEntry[]>
  expanded: ReadonlySet<string>
  /**
   * Folders decided to show everything even beyond 10 entries (TODO 904). Entered by pressing "... N more",
   * and dropped when that folder is closed (reopening shows 10 again).
   */
  showAll: ReadonlySet<string>
  loading: ReadonlySet<string>
  selectedUri: string | null
  /** The search term when opened from an in-file search hit (TODO 56). null for a normal selection. */
  highlightQuery: string | null
  /**
   * One-shot instruction for ViewerPane to jump to a line (item 273). `select` sets it from a `foo.ts:42` link in
   * the body and from the gateway's `openFile` `line`. A `select` without a line clears it. **Not written to the
   * memory (item 63)** (owner decision 2026-10-01).
   */
  viewerLine: ViewerRevealRequest | null
  /**
   * One-shot instruction for ViewerPane to re-center on a search hit (TODO 446). The number advances on every
   * `select` with a search term, so pressing the same hit in the same file again makes the viewer re-center.
   * Not written to the memory.
   */
  viewerRecenter: ViewerRecenterRequest | null
  /**
   * The range currently selected in ViewerPane (item 97). ViewerPane validates the viewer (iframe)'s
   * notification and stores it here. A candidate the Composer attaches on send. **Not persisted**: it is
   * cleared when the file changes.
   */
  viewerSelection: ViewerSelection | null
  /**
   * The range currently selected in a temporary-view diff (`aios.diff`) (TODO 1091 part 2). A value only for
   * `inView` of `listOpenFiles` (not an attachment candidate). Cleared when the temporary view changes or
   * closes. Not persisted.
   */
  transientSelection: ViewerSelection | null
  /** The current page reported by the PDF viewer (TODO 1061 part 2, 1-based). Cleared when the file changes. Not persisted. */
  viewerPage: { uri: string; page: number } | null
  /**
   * ViewerPane has unsaved edits (item 97). While this is set, "open / close" requests from main (the gateway's
   * `openFile` / `closeFile`) are not obeyed (so the draft is not thrown away).
   */
  viewerDirty: boolean
  /**
   * A temporary view with no URI (the diff of item 104; the extension details / audit log of TODO 367 moved to
   * the ThreadPane location in 458). While set, ViewerPane draws this and keeps the `selectedUri` file behind it
   * (closing returns to it). **Not written to the per-thread memory (item 63)**: the memory's listener only
   * watches `selectedUri`, so structurally it cannot be written. Cleared by choosing a file (`select`) or
   * switching threads (`viewerMemory.ts`).
   */
  transient: TransientView | null
  /**
   * The model tried to write to the file for which there is currently a draft (item 97 second half).
   * A notification after main has checked, but a mismatch while it travels (the thread / file was switched) is
   * re-checked in `acceptDraftConflict`. Cleared by changing the file, saving, or discarding.
   */
  draftConflict: DraftConflictNotice | null
  /**
   * An external tool rewrote the file currently shown (TODO 673). A one-shot instruction that main sends only
   * when there is no draft; ViewerPane sees it and silently reloads from disk (`reloadFromDisk`).
   * When there is a draft, `draftConflict` is set instead (the conflict band). Not written to the memory (item 63).
   */
  externalReload: ExternalReloadRequest | null
  /**
   * Unsaved drafts per file (a small observation of TODO 312, wave 18 bundle B). The key is the URI only, and it
   * is shared across threads. **Renderer memory only** (not written to the DB, gone on restart). Details in
   * `viewer-drafts.ts`.
   */
  viewerDrafts: DraftTable
  /**
   * The viewer's back / forward (TODO 369, wave 20 bundle D). Keyed by thread id. The renderer's memory is the
   * source of truth; since 772, `ViewerHistoryWriter` also persists it to main (`thread_viewer_history`) and
   * reads it back at launch (the position is 1146). How entries are stacked is in `viewer-history.ts`; the
   * wiring (recording, back / forward, keys) is in `viewerHistory.ts`.
   */
  viewerHistories: Readonly<Record<string, ViewerHistory>>
  /**
   * Whether the last `select` was a consecutive open by up/down keys (item 356) (TODO 369). Used for the
   * history's 1-second grouping. Written in the same `set` as `selectedUri`, so the `subscribe` listener sees
   * both together.
   */
  selectByKeys: boolean
  /**
   * Whether the last `select` was a "replace the current step" of a web page (TODO 400: a redirect, an in-page
   * navigation, or the URL of the loaded result). Like `selectByKeys`, written in the same `set` as `selectedUri`.
   */
  selectReplace: boolean
  /**
   * Whether the current `selectedUri` (a web page) is **not loaded yet** (the default of TODO 400 / 411: when
   * restoring the memory after switching threads, only the heading is shown and the page loads when pressed).
   * Has no effect on files.
   */
  viewerDeferred: boolean

  /**
   * The directory that `reveal` opened and showed (item 49). Used for row highlighting and the scroll target.
   * **Separate from `selectedUri`**: that one is the file ViewerPane opens, and putting a directory there would
   * make the viewer open it with a "directory" error. Cleared when the user presses a row.
   * Since TODO 1257 the row highlight belongs to the Files selection (`filerHistory.ts`, per conversation): an
   * explicit reveal is recorded there as a pick, and this value only remains the key-position fallback and the
   * hidden-file pin.
   */
  revealedUri: string | null
  /**
   * The Files row a `row` reveal (back / forward, conversation switch) is showing (TODO 1257). Not a highlight
   * (that is the Files selection in `filerHistory.ts`): it only keeps the way to a dot-file row open while hidden
   * files are hidden (TODO 261), like `revealedUri` does for an explicit reveal.
   */
  rowRevealUri: string | null
  /** Advances every time `reveal` completes. A signal to scroll again even when the same cwd is opened once more. */
  revealTick: number
  /**
   * The row `reveal` last aligned to (item 264). `FileMode` scrolls here. When `always` is false (auto reveal),
   * it does not scroll if that row is already visible.
   */
  revealTarget: RevealTarget | null
  query: string
  /** File name search results (6.6). Held together with the count and the truncation flag. */
  results: FileSearchResult | null
  searching: boolean

  init(): Promise<void>
  /** Releases the `init()` subscriptions (TODO 571, the cleanup of `App`'s `useEffect`). */
  dispose(): void
  toggle(uri: string): Promise<void>
  expand(uri: string): Promise<void>
  select(uri: string | null, options?: SelectOptions): void
  setViewerSelection(selection: ViewerSelection | null): void
  setTransientSelection(selection: ViewerSelection | null): void
  setViewerPage(page: { uri: string; page: number } | null): void
  setViewerDirty(dirty: boolean): void
  /** Shows before and after temporarily in the diff viewer (item 104). The body is not saved anywhere. */
  openDiff(input: DiffInput): void
  /** Temporarily shows a file inside an archive (zip) (TODO 905). The contents are only held in memory and saved nowhere. */
  openTransientFile(input: { readonly name: string; readonly source: string; readonly data: Uint8Array }): void
  /**
   * Shows Help (TODO 1174, 7.4.13) as a temporary view. `lang` is the app's display language (passed by the
   * entry point). The viewer of the file behind it stays alive but hidden; closing with the close button, back,
   * or ⌘W returns to the previous display (the same temporary-view frame as diffs and files inside a zip).
   */
  openHelp(lang: Locale): void
  /** Closes the temporary view and returns to showing the `selectedUri` behind it. */
  closeTransient(): void
  setDraftConflict(conflict: DraftConflictNotice | null): void
  /** TODO 673: a one-shot instruction making a window with no draft silently reload after an external tool's rewrite. */
  requestExternalReload(uri: string): void
  /** Remember / forget a draft (TODO 312). Only ViewerPane calls it. */
  rememberDraft(uri: string, draft: StoredDraft): void
  forgetDraft(uri: string): void
  /** Replaces a thread's viewer history (TODO 369). Only `viewerHistory.ts` calls it. */
  setViewerHistory(threadId: string, history: ViewerHistory): void

  /**
   * Expands the ancestors from `roots` down to `uri` in order, also opens `uri` itself and puts it in
   * `revealedUri` (item 49). Does nothing if it is under none of the roots. If another `reveal` starts midway,
   * the older one is dropped (a deep path keeps `listDirectory` round trips going).
   *
   * With `auto` (item 264, following the file opened in the viewer) it does not open `uri` itself (no
   * `listDirectory` on a file), does not set `revealedUri` (the highlight is done by `selectedUri`), and does not
   * scroll if the row is already visible.
   *
   * `row` (TODO 1257, Files back / forward and the per-conversation Files selection): opens the ancestors only (a folder
   * row itself stays as it is), leaves `revealedUri` alone (the highlight is the Files selection, `filerHistory.ts`),
   * scrolls only when the row is out of view and clears the Files filter so the tree is shown.
   */
  reveal(uri: string, options?: RevealOptions): Promise<void>
  clearReveal(): void
  /** "... N more" was pressed (TODO 904): lifts the omission for that folder. Remembered until it is closed. */
  showAllChildren(uri: string): void
  setQuery(query: string): void
  rescan(): Promise<void>
  refresh(uri: string): Promise<void>
  /**
   * "Show hidden files" changed (TODO 261). Re-fetches the open listings and discards the cached copies of
   * closed ones (they are fetched the new way next time they open).
   */
  relist(): Promise<void>
  /**
   * Reflection right after creating from the Files tree (TODO 370). Re-fetches the cached listings from
   * `parentUri` up to one level above the created item (main answers after putting it in the index, so the new
   * row is always included). A file is opened in the viewer (`select`; even a hidden file stays in the listing as
   * the selected row), and a folder opens its ancestors and then itself (pinned if hidden, the `expand` path).
   */
  noteCreated(parentUri: string, uri: string, isDirectory: boolean): Promise<void>
  /**
   * Re-keying cached state after a rename (code-review of TODO 1145). Copies drafts, open folders and listings
   * of the old URI (and below it) to the new URI and removes the old keys. Folders that were open are re-fetched
   * at the new location.
   */
  noteRenamed(from: string, to: string): Promise<void>
}

export interface SelectOptions {
  /** The in-file search term (TODO 56). */
  readonly highlight?: string
  /** Line to jump to (1-based, item 273). One-shot, not kept in the memory. */
  readonly line?: number | null
  /** Column to jump to (1-based). Only effective when `line` is given. */
  readonly column?: number | null
  /** Page to jump to (1-based, TODO 1009 stage 2, PDF). Only effective when `line` is absent. One-shot, not kept in the memory. */
  readonly page?: number | null
  /**
   * A consecutive open by up/down keys (item 356) (TODO 369). In the viewer history, it is grouped into one
   * step with the previous up/down step within 1 second.
   */
  readonly byKeys?: boolean
  /**
   * Restores a previous position (TODO 1146, viewer back / forward). Only effective when `line` / `page` are
   * absent. One-shot; not kept in the memory (item 63) (the position is held by the left/right history).
   */
  readonly restore?: ViewerScrollPosition | null
  /** A "replace the current step" of web page navigation (TODO 400). Does not push a new step onto the history. */
  readonly replace?: boolean
  /** Shows only the heading without loading the web page (TODO 400, memory restore). */
  readonly deferLoad?: boolean
}

/** Source of `viewerLine.nonce`. Advances per instruction (pressing the same line twice still jumps). */
let viewerLineNonce = 0
/** Source of `viewerRecenter.nonce` (TODO 446). */
let viewerRecenterNonce = 0
/** Source of `externalReload.nonce` (TODO 673). Even consecutive instructions for the same URI always arrive as new ones. */
let externalReloadNonce = 0

/** One-shot instruction to silently reload after an external tool's rewrite (TODO 673). */
export interface ExternalReloadRequest {
  readonly uri: string
  readonly nonce: number
}

/** How to show a listing when requesting one (TODO 261). The selected file and the reveal row keep their path even if hidden. */
function listingOptions(
  uri: string,
  state: Pick<AppState, 'selectedUri' | 'revealedUri' | 'rowRevealUri'>
): ListDirectoryOptions {
  return listOptionsFor(uri, [state.selectedUri, state.revealedUri, state.rowRevealUri])
}

const SEARCH_LIMIT = 300
export interface RevealTarget {
  readonly uri: string
  /** If true, scroll even when already visible (item 49's "open the working folder in the tree"). */
  readonly always: boolean
  /** Clear the Files filter so the tree (and this row) is shown (TODO 1257 `row` reveal). `always` implies it. */
  readonly clearFilter?: boolean
}

export interface RevealOptions {
  /** Follow the file opened in the viewer (item 264). */
  readonly auto?: boolean
  /** Show a row picked in Files without changing `revealedUri` (TODO 1257). */
  readonly row?: boolean
  /**
   * Only open the ancestors (TODO 1257 fix Y): no highlight, no scroll target, and it does not take over the
   * generation of a running reveal, so it cannot cut another reveal short (and is not cut short by one).
   */
  readonly quiet?: boolean
}

/** Generation of the `reveal` in progress. When a newer call comes, the older chain exits at its next await. */
let revealSeq = 0

/** The `init()` subscriptions (TODO 571). Only one set even with StrictMode's second init. */
const subscriptions = createSubscriptionSlot()

export const useStore = create<AppState>((set, get) => ({
  appInfo: null,
  scan: null,
  roots: [],
  children: {},
  expanded: new Set<string>(),
  showAll: new Set<string>(),
  loading: new Set<string>(),
  selectedUri: null,
  highlightQuery: null,
  viewerLine: null,
  viewerRecenter: null,
  viewerSelection: null,
  transientSelection: null,
  viewerPage: null,
  viewerDirty: false,
  transient: null,
  draftConflict: null,
  externalReload: null,
  viewerDrafts: {},
  viewerHistories: {},
  selectByKeys: false,
  selectReplace: false,
  viewerDeferred: false,

  revealedUri: null,
  rowRevealUri: null,
  revealTick: 0,
  revealTarget: null,
  query: '',
  results: null,
  searching: false,

  async init(): Promise<void> {
    const token = subscriptions.begin()
    const [appInfo, roots, scan] = await Promise.all([
      window.aios.app.getInfo(),
      window.aios.fs.roots(),
      window.aios.fs.getScanStatus()
    ])
    set({ appInfo, roots, scan })
    // Read how hidden files are shown (TODO 261) before the first listing.
    await initHiddenFiles(() => void get().relist())
    // Same for the sort order (TODO 872). If it changes, the open listings are re-fetched (open state and selection are kept).
    await initFileSort(() => void get().relist())

    // If a later init (StrictMode's second) or a dispose has come, leave the subscriptions and the first expansion to it.
    if (!subscriptions.claim(token)) return
    subscriptions.add(window.aios.fs.onScanStatus((status) => set({ scan: status })))
    // TODO 1138: state that arrived between the first fetch and the subscription was discarded, so fetch once more after subscribing.
    void window.aios.fs.getScanStatus().then((status) => {
      if (subscriptions.isCurrent(token)) set({ scan: status })
    })
    subscriptions.add(
      window.aios.fs.onFileChanges((batch) => {
        // Re-fetch only once per batch. main already coalesces them into 16 ms.
        const open = get().expanded
        const parents = new Set<string>()
        for (const change of batch.changes) {
          if (change.parentUri !== null && open.has(change.parentUri)) parents.add(change.parentUri)
        }
        for (const parent of parents) void get().refresh(parent)
      })
    )

    // What opens first is the first root that is not a shortcut (TODO 520) (= home). Shortcuts are listed closed.
    const first = roots.find((root) => root.shortcut === undefined) ?? roots[0]
    if (first !== undefined) await get().expand(first.uri)
    // Also align to a file that was already selected before the window opened (restoring a thread's viewer, item 63) (item 264).
    // If the restore ran first, `roots` was still empty and nothing happened, so recover once here.
    const { selectedUri, results } = get()
    if (shouldAutoReveal(selectedUri, results !== null)) void get().reveal(selectedUri, { auto: true })
  },

  dispose(): void {
    subscriptions.dispose()
  },

  async expand(uri: string): Promise<void> {
    // Opening a dot-prefixed entry while hidden files are off = the reveal path (TODO 261). Remember it and re-show it in the parent's listing.
    if (pinForExpand(uri)) {
      const parent = parentUri(uri)
      if (parent !== null && get().children[parent] !== undefined) void get().refresh(parent)
    }
    if (get().children[uri] !== undefined) {
      set((state) => ({ expanded: new Set(state.expanded).add(uri) }))
      return
    }
    set((state) => ({
      loading: new Set(state.loading).add(uri),
      expanded: new Set(state.expanded).add(uri)
    }))
    let listing: Awaited<ReturnType<typeof window.aios.fs.listDirectory>>
    try {
      listing = await window.aios.fs.listDirectory(uri, listingOptions(uri, get()))
      useSearch.getState().noteIndexAnswered()
    } catch (err) {
      // The index is busy / down (item 87). Do not leave it stuck at "..."; close it and revert
      // (pressing again retries). The reason goes to the status bar.
      set((state) => {
        const loading = new Set(state.loading)
        loading.delete(uri)
        const expanded = new Set(state.expanded)
        expanded.delete(uri)
        return { loading, expanded }
      })
      useSearch.getState().noteIndexError(err)
      return
    }
    // Observation of item 333 (wave 18): for things like under an exclusion, main returns a `reason` instead of throwing (`entries` stays
    // empty). Match the previous appearance (when main threw): revert instead of leaving it open.
    if (listing.reason) {
      set((state) => {
        const loading = new Set(state.loading)
        loading.delete(uri)
        const expanded = new Set(state.expanded)
        expanded.delete(uri)
        return { loading, expanded }
      })
      return
    }
    set((state) => {
      const loading = new Set(state.loading)
      loading.delete(uri)
      return { children: { ...state.children, [uri]: listing.entries }, loading }
    })
  },

  async reveal(uri: string, options?: RevealOptions): Promise<void> {
    const row = options?.row === true
    // A `row` reveal opens only the ancestors, like `auto`.
    const quiet = options?.quiet === true
    const auto = options?.auto === true || row || quiet
    const chain = revealChain(
      get().roots.map((root) => root.uri),
      uri
    )
    if (chain === null) return
    const seq = quiet ? revealSeq : ++revealSeq
    // Set before the listings below are asked for, so a hidden dot-file on the way is kept in them.
    if (row) set({ rowRevealUri: chain[chain.length - 1] ?? null })
    try {
      for (const ancestor of expandChain(chain, auto)) {
        // If it is open and has a listing, no round trip (when a row was pressed to open, almost everything is this).
        if (get().expanded.has(ancestor) && get().children[ancestor] !== undefined) continue
        await get().expand(ancestor)
        if (!quiet && seq !== revealSeq) return
        // It could not be opened (the index is busy, item 87). Do not follow further.
        if (!get().expanded.has(ancestor)) return
      }
    } catch {
      // An intermediate directory was gone / unreadable. Stop at where it could be opened.
      return
    }
    if (quiet) return
    // A row that is missing from its parent's cached listing (a dot-file while hidden files are hidden, listed
    // before the pin above existed): ask for the parent again so the row shows up.
    if (row) {
      const target = chain[chain.length - 1]
      const parent = target === undefined ? null : parentUri(target)
      const listed = parent === null ? undefined : get().children[parent]
      if (parent !== null && listed !== undefined && !listed.some((child) => child.uri === target)) {
        await get().refresh(parent)
        if (seq !== revealSeq) return
      }
    }
    // When aligning to a row beyond the 10 omitted entries, lift the omission of its parent (TODO 904).
    const hiddenParents = limitedAncestors(chain, get().children)
    if (hiddenParents.length > 0) {
      set((state) => ({ showAll: new Set([...state.showAll, ...hiddenParents]) }))
    }
    const last = chain[chain.length - 1] ?? null
    set((state) => ({
      // With auto, the highlight is left to `selectedUri` (not held twice).
      revealedUri: auto ? state.revealedUri : last,
      revealTarget: last === null ? null : row ? { uri: last, always: false, clearFilter: true } : { uri: last, always: !auto },
      revealTick: state.revealTick + 1
    }))
  },

  clearReveal(): void {
    if (get().revealedUri !== null) set({ revealedUri: null })
  },

  async toggle(uri: string): Promise<void> {
    if (get().expanded.has(uri)) {
      set((state) => {
        const expanded = new Set(state.expanded)
        expanded.delete(uri)
        // Closing also resets "show all" (TODO 904).
        const showAll = new Set(state.showAll)
        showAll.delete(uri)
        return { expanded, showAll }
      })
      return
    }
    await get().expand(uri)
  },

  showAllChildren(uri: string): void {
    if (get().showAll.has(uri)) return
    set((state) => ({ showAll: new Set(state.showAll).add(uri) }))
  },

  async refresh(uri: string): Promise<void> {
    try {
      const listing = await window.aios.fs.listDirectory(uri, listingOptions(uri, get()))
      useSearch.getState().noteIndexAnswered()
      // Observation of item 333 (wave 18): when refused (`reason !== null`), keep the previous listing
      // (the same appearance as the earlier "exception -> catch does nothing").
      if (listing.reason) return
      set((state) => ({ children: { ...state.children, [uri]: listing.entries } }))
    } catch (err) {
      // Keep the previous listing (item 87).
      useSearch.getState().noteIndexError(err)
    }
  },

  async relist(): Promise<void> {
    const open = get().expanded
    set((state) => ({
      children: Object.fromEntries(Object.entries(state.children).filter(([uri]) => open.has(uri)))
    }))
    await Promise.all([...open].map((uri) => get().refresh(uri)))
  },

  async noteRenamed(from: string, to: string): Promise<void> {
    if (from === to) return
    const move = (uri: string): string => replaceUriPrefix(uri, from, to) ?? uri
    const inside = (uri: string): boolean => move(uri) !== uri
    // The draft table is keyed by URI. If not moved, the edit would become invisible and the old URI's draft would stay dirty.
    const drafts = get().viewerDrafts
    if (Object.keys(drafts).some(inside)) {
      set({ viewerDrafts: Object.fromEntries(Object.entries(drafts).map(([uri, draft]) => [move(uri), draft])) })
    }
    // Also re-key the old URI in the viewer's left/right history (369). Do not leave steps that fall into `fs.stat` (TODO 1149).
    // Recent files (999) are re-fetched by main on every open, so there is nothing to carry over.
    const histories = get().viewerHistories
    const renamedHistories = Object.entries(histories).map(([threadId, history]) => {
      return [threadId, renameHistoryUrisIn(history, from, to)] as const
    })
    if (renamedHistories.some(([threadId, history]) => history !== histories[threadId])) {
      set({ viewerHistories: Object.fromEntries(renamedHistories) })
    }
    const reopened = [...get().expanded].filter(inside).map(move)
    set((state) => ({
      expanded: new Set([...state.expanded].filter((uri) => !inside(uri)).concat(reopened)),
      children: Object.fromEntries(Object.entries(state.children).filter(([uri]) => !inside(uri))),
      loading: new Set([...state.loading].filter((uri) => !inside(uri)))
    }))
    await Promise.all(reopened.map((uri) => get().refresh(uri)))
  },

  async noteCreated(parentUri: string, uri: string, isDirectory: boolean): Promise<void> {
    // Select a file first: it enters the re-fetched listing's `keep` (TODO 261), so it is visible on the spot even if dot-prefixed.
    if (!isDirectory) get().select(uri)
    for (const dir of createdChain(parentUri, uri)) {
      if (get().children[dir] !== undefined) await get().refresh(dir)
    }
    if (!get().expanded.has(parentUri)) await get().expand(parentUri)
    // So that what was created is visible even if it sits beyond the 10 entries (TODO 904).
    const created = limitedAncestors([parentUri, uri], get().children)
    if (created.length > 0) set((state) => ({ showAll: new Set([...state.showAll, ...created]) }))
    if (!isDirectory) return
    await get().reveal(uri, { auto: true })
    await get().expand(uri)
  },

  select(uri: string | null, options?: SelectOptions): void {
    const highlight = options?.highlight?.trim() ?? ''
    const line =
      viewerLineRequest(uri, options, viewerLineNonce + 1) ??
      viewerPageRequest(uri, options, viewerLineNonce + 1) ??
      viewerRestoreRequest(uri, options, viewerLineNonce + 1)
    if (line !== null) viewerLineNonce = line.nonce
    const recenter = viewerRecenterRequest(uri, highlight, viewerRecenterNonce + 1)
    if (recenter !== null) viewerRecenterNonce = recenter.nonce
    set((state) => ({
      selectedUri: uri,
      // The selected file becomes the owner of the highlight (the working folder's highlight `revealedUri` has done its job).
      revealedUri: uri === null ? state.revealedUri : null,
      highlightQuery: uri !== null && highlight !== '' ? highlight : null,
      // The instruction for a line is one-shot (item 273). A selection without a line clears it.
      viewerLine: line,
      // Instruction to re-center on a search hit (TODO 446). A selection without a search term clears it.
      viewerRecenter: recenter,
      // Whether it is a consecutive up/down open (TODO 369, the history's 1-second grouping).
      selectByKeys: options?.byKeys === true,
      // Web page (TODO 400): whether it is a replace step / not yet loaded.
      selectReplace: options?.replace === true,
      viewerDeferred: options?.deferLoad === true,
      // Choosing a file closes the temporary view (item 104). It would be a problem if what was chosen were not visible.
      transient: null,
      transientSelection: null,
      // When switching to another file, do not attach the previous file's selection (item 97).
      viewerSelection: state.selectedUri === uri ? state.viewerSelection : null,
      viewerPage: state.selectedUri === uri ? state.viewerPage : null,
      // When switching to another file, the previous file's draft-conflict notice is also cleared (item 97 second half).
      draftConflict: state.selectedUri === uri ? state.draftConflict : null,
      // Likewise for the external-rewrite reload instruction (TODO 673).
      externalReload: state.selectedUri === uri ? state.externalReload : null
    }))
    // Align the tree to the file shown in the viewer (item 264, VS Code's `explorer.autoReveal`). Pressing a tree row,
    // a search result, a link in the body, `openFile`, and the viewer restore when switching threads all pass
    // through here. Ancestors are opened behind the scenes even when the sidebar is not the tree (so it is aligned when switched to the tree).
    if (shouldAutoReveal(uri, get().results !== null)) void get().reveal(uri, { auto: true })
  },

  setViewerSelection(selection: ViewerSelection | null): void {
    set({ viewerSelection: selection })
  },

  setTransientSelection(selection: ViewerSelection | null): void {
    if (get().transientSelection !== selection) set({ transientSelection: selection })
  },

  setViewerPage(page: { uri: string; page: number } | null): void {
    set({ viewerPage: page })
  },

  setViewerDirty(dirty: boolean): void {
    if (get().viewerDirty !== dirty) set({ viewerDirty: dirty })
    // When saving / discarding removes the draft, its notice goes away too.
    if (!dirty && get().draftConflict !== null) set({ draftConflict: null })
  },

  setDraftConflict(conflict: DraftConflictNotice | null): void {
    set({ draftConflict: conflict })
  },

  requestExternalReload(uri: string): void {
    externalReloadNonce += 1
    set({ externalReload: { uri, nonce: externalReloadNonce } })
  },

  rememberDraft(uri: string, draft: StoredDraft): void {
    const next = withDraft(get().viewerDrafts, uri, draft)
    if (next !== get().viewerDrafts) set({ viewerDrafts: next })
  },

  forgetDraft(uri: string): void {
    const next = withoutDraft(get().viewerDrafts, uri)
    if (next !== get().viewerDrafts) set({ viewerDrafts: next })
  },

  setViewerHistory(threadId: string, history: ViewerHistory): void {
    if (get().viewerHistories[threadId] === history) return
    set((state) => ({ viewerHistories: { ...state.viewerHistories, [threadId]: history } }))
  },

  openDiff(input: DiffInput): void {
    set({ transient: toDiffPayload(input), transientSelection: null })
  },

  openTransientFile(input): void {
    transientFileNonce += 1
    set({
      transient: { kind: 'file', name: input.name, source: input.source, data: input.data, nonce: transientFileNonce },
      transientSelection: null
    })
  },

  openHelp(lang: Locale): void {
    helpNonce += 1
    set({ transient: { kind: 'help', uri: helpUri(lang), nonce: helpNonce }, transientSelection: null })
  },

  closeTransient(): void {
    if (get().transient !== null) set({ transient: null, transientSelection: null })
  },

  setQuery(query: string): void {
    set({ query })
    if (query.trim() === '') {
      set({ results: null, searching: false })
      return
    }
    set({ searching: true })
    void window.aios.fs
      .searchFiles(query, SEARCH_LIMIT, activeCwdUri())
      .then((results) => {
        useSearch.getState().noteIndexAnswered()
        // Discard if the input has moved on. main also stops the scan midway on the same judgment and returns with
        // `cancelled` set (6.6), so that response is not shown.
        if (get().query !== query || results.cancelled) return
        set({ results: cwdFirst(results), searching: false })
      })
      .catch((err: unknown) => {
        if (get().query === query) set({ searching: false })
        useSearch.getState().noteIndexError(err)
      })
  },

  async rescan(): Promise<void> {
    await window.aios.fs.rescan()
    // Re-fetch only the open directories. Closed ones are read the next time they open.
    for (const uri of get().expanded) void get().refresh(uri)
  }
}))

/**
 * ViewerPane's temporary view (no URI, 7.4.6). A diff (item 104, drawn in the `aios.diff` plugin's iframe) and a
 * file inside an archive (zip) (TODO 905, drawn in the viewer iframe resolved by the name's extension).
 * The extension details / audit log added in TODO 367 moved to the ThreadPane location (`mainPanel.ts`) in TODO 458.
 */
export type TransientView = DiffPayload | TransientFileView | HelpView

/**
 * Help's temporary view (TODO 1174, 7.4.13). It holds only the `help://` URI; ViewerPane asks main for the body
 * (`help.open`). **Not stacked in the per-thread memory (63) nor in the viewer history (369)**: like other
 * temporary views, it is the topmost single sheet that "back" closes.
 */
export interface HelpView {
  readonly kind: 'help'
  /** The form `help://index?lang=ja`. */
  readonly uri: string
  /** A number that advances on every open. Reopening recreates the iframe (does not inherit the previous language selection or position). */
  readonly nonce: number
}

/** A number that advances on every Help open (`HelpView.nonce`). */
let helpNonce = 0

/** A number that advances on every temporary-view file open (TODO 905, `TransientFileView.nonce`). */
let transientFileNonce = 0

/** Argument of `openDiff` (item 104). `language` may be omitted (otherwise it is looked up by the name's extension). */
export interface DiffInput {
  readonly before: DiffSideInput
  readonly after: DiffSideInput
  /** Initial layout (TODO 826). A diff opened by the AI is 'split'. If absent, the viewer's current layout is kept. */
  readonly layout?: DiffLayout
}

export interface DiffSideInput {
  readonly name: string
  readonly text: string
  readonly language?: string | null
}

function toDiffSide(side: DiffSideInput): DiffSide {
  const language = side.language?.trim() ?? ''
  return { name: side.name, text: side.text, language: language === '' ? null : language }
}

/** Converts `openDiff`'s argument into the form passed to the viewer (pure function). */
export function toDiffPayload(input: DiffInput): DiffPayload {
  return {
    kind: 'diff',
    before: toDiffSide(input.before),
    after: toDiffSide(input.after),
    ...(input.layout === undefined ? {} : { layout: input.layout })
  }
}

/** The state `selectRows` reads (item 88). FileMode subscribes to only this with `useShallow`. */
export type TreeState = Pick<AppState, 'roots' | 'children' | 'expanded' | 'loading'> & {
  /** Folders whose omission was lifted (TODO 904). If absent, everything is cut to 10 entries. */
  readonly showAll?: ReadonlySet<string>
}

/** The form of `TreeRow.key` (TODO 520). A URI starts with `file://`, so it is not confused with the URI itself. */
export function treeRowKey(rootIndex: number, uri: string): string {
  return `${rootIndex}|${uri}`
}

/** Flattens the tree into a 1-D array in display order. The virtual list draws this array. */
export function selectRows(state: TreeState): readonly TreeRow[] {
  const rows: TreeRow[] = []

  const push = (entry: FileEntry, depth: number, rootIndex: number): void => {
    // TODO 871: do not show the contents of an `.app` even if open (even if an open state from before / as a reveal path remains).
    const expanded = state.expanded.has(entry.uri) && !isAppBundle(entry)
    rows.push({
      entry,
      key: treeRowKey(rootIndex, entry.uri),
      depth,
      expanded,
      loading: state.loading.has(entry.uri)
    })
    if (!expanded || !entry.isDirectory) return
    const children = state.children[entry.uri] ?? []
    const shown = limitChildren(children, state.showAll?.has(entry.uri) === true)
    for (const child of shown) push(child, depth + 1, rootIndex)
    // TODO 904: a folder over 10 entries ends with an "... N more" row.
    if (shown.length < children.length) {
      const next = children[shown.length]
      rows.push({
        entry: moreRowEntry(entry.uri),
        key: moreRowKey(rootIndex, entry.uri),
        depth: depth + 1,
        expanded: false,
        loading: false,
        more: {
          parentUri: entry.uri,
          hidden: children.length - shown.length,
          nextKey: next === undefined ? moreRowKey(rootIndex, entry.uri) : treeRowKey(rootIndex, next.uri)
        }
      })
    }
  }

  state.roots.forEach((root, index) => push(root, 0, index))
  return rows
}

/**
 * In File mode's filter (a single list chosen with the cursor), sections (item 100) are not separated by
 * headings; they are chained into one list in the order "inside cwd -> everywhere". The count and the
 * truncation flag are reported as the sum of the 2 sections. Separation by headings is on the search mode
 * (`SearchMode`) side.
 */
function cwdFirst(results: FileSearchResult): FileSearchResult {
  const cwd = results.cwd
  if (cwd === null || cwd.entries.length === 0) return results
  return {
    ...results,
    entries: [...cwd.entries, ...results.entries],
    total: cwd.total + results.total,
    truncated: cwd.truncated || results.truncated,
    scanTruncated: cwd.scanTruncated || results.scanTruncated
  }
}
