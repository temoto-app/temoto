/**
 * State of search mode (ARCHITECTURE.md 6.1).
 *
 * **Do not build values in a selector** (a Phase 2 pitfall): `state.x[id] ?? []` returns a new array
 * every time, and `useSyncExternalStore` goes into an infinite re-render (React #185). Make the empty default a
 * module constant, and build combined arrays with `useMemo` in the component.
 */
import { create } from 'zustand'
import type {
  IndexStatus,
  ScopeBuildResult,
  SearchHit,
  SearchResponse,
  SearchScope,
  SearchSection
} from '@shared/search.js'
import type { FileSearchResult } from '@shared/types.js'
import { uriBasename } from '@shared/uri.js'
import { parseReason } from '@shared/reason.js'
import type { SearchTarget } from './shortcuts.js'
import { activeCwdUri } from './active-cwd.js'

/** The empty result is a module constant, so that selectors do not build `[]`. */
export const NO_HITS: readonly SearchHit[] = []

const LIMIT = 50

/**
 * Per-scope query number (P6). If it is monotonically increasing and passed to main, main returns `stale`
 * **without running the search with an old number**. better-sqlite3 has no interrupt, so a statement already running
 * cannot be stopped, but ones waiting in the queue do not run.
 * The index side compares numbers per window (webContents) (TODO 497), so each window may count from 0.
 *
 * It is **not put** in the store's state: it is a value unrelated to rendering, and there is no reason to
 * cause a re-render on every update.
 */
const seq: Record<SearchScope, number> = { files: 0, conversation: 0 }

function nextSeq(scope: SearchScope): number {
  seq[scope] += 1
  return seq[scope]
}

/**
 * The request number of the file-name search. When a response arrives, check whether it is the latest request (item 100).
 * The request is redone when the cwd changes even for the same query, so "did the query move on" alone
 * cannot tell apart a response for an old cwd.
 */
let nameRequest = 0

/** The cwd when the in-file / file-name search was last run (item 100). `undefined` means not run yet. */
let queriedCwd: string | null | undefined

/**
 * The cwd when the conversation search was last run (TODO 1096). Held separately from the File side (`queriedCwd`): when the thread
 * changes after only the conversation was searched, only the conversation search is redone. `undefined` means not run yet.
 */
let queriedConversationCwd: string | null | undefined

/**
 * Map one file-name search result into the `SearchHit` shape (6.6.6, TODO 46).
 *
 * A conversion so that the results of the 3 windows line up in the **same virtual list**; what arrives from main is
 * a `FileEntry` (only the URI and name; no path, per the 6.6 convention). The parent directory's
 * **name** is taken from the last element of `parentUri`, the same presentation as the `context` of body search.
 * `snippet` is empty (the body was not searched). `id` is the URI, not the `documents` rowid, and is not
 * passed to `getDocument` (`SearchMode` uses only the URI).
 */
function toNameHit(entry: FileSearchResult['entries'][number]): SearchHit {
  return {
    id: entry.uri,
    uri: entry.uri,
    title: entry.name,
    source: 'fs',
    kind: entry.isDirectory ? 'directory' : 'file',
    updatedAt: entry.mtimeMs,
    score: 0,
    snippet: '',
    threadId: null,
    eventId: null,
    context: entry.parentUri === null ? '' : uriBasename(entry.parentUri),
    contextCode: null
  }
}

/** Why a file-name search was cut off (6.6.4 "do not drop silently"). Shown in the heading. */
export interface NameSearchOutcome {
  readonly total: number
  readonly truncated: boolean
  readonly scanTruncated: boolean
}

const NO_NAME_OUTCOME: NameSearchOutcome = { total: 0, truncated: false, scanTruncated: false }

/** The "this working folder" section of the file-name search (item 100). */
export interface NameSearchSection extends NameSearchOutcome {
  readonly uri: string
  readonly hits: readonly SearchHit[]
}

/**
 * The scope of the Search screen (TODO 437). Decided by the 🔎 on a folder in the Files tree / the right-click "Search in this folder…".
 * **Per window** (this store lives in each window's renderer), and it disappears when the app restarts (not written to the DB, by default).
 * It applies to body search and file-name search, and is not applied to conversation search.
 */
export interface SearchRange {
  readonly uri: string
  /** The build (`search.buildScope`) at the time the scope was set has not finished. */
  readonly building: boolean
  /** The bodies still pending after the build (the answer of `buildScope`). null if there is no answer yet. */
  readonly pending: ScopeBuildResult | null
}

/** The request number of the scope. Discards the answer of a `buildScope` that arrives after ✕ / switching to another scope. */
let rangeRequest = 0

/** How long (ms) to keep "the index is busy" in the status bar (item 87). The next response clears it earlier. */
const BUSY_NOTICE_MS = 15_000
let busyTimer: ReturnType<typeof setTimeout> | null = null

/**
 * TODO 1199: true while the conversation search (⌘K) has a term (either the draft or the committed term has one). While true, the body search (⌘⇧F) and
 * file-name search (⌘P) fields are gray, and `requestFocus` / shortcuts do nothing either. One direction only (not the reverse).
 */
export function isConversationLocked(state: { readonly conversationDraft: string; readonly conversationQuery: string }): boolean {
  return state.conversationDraft.trim() !== '' || state.conversationQuery.trim() !== ''
}

interface SearchState {
  fileQuery: string
  conversationQuery: string
  /**
   * TODO 1199: the draft (before debounce) of the conversation search (⌘K) field. `SearchMode` mirrors it only while mounted, and on unmount aligns it with `conversationQuery`.
   * "Whether to gray out body search / file-name search" is not an independent flag but derived from this draft and `conversationQuery` (`isConversationLocked`).
   */
  conversationDraft: string
  setConversationDraft(draft: string): void
  /** File-name search (6.6, TODO 46). Searched by a different route (`fs.searchFiles`) from body search. */
  nameQuery: string
  fileHits: readonly SearchHit[]
  conversationHits: readonly SearchHit[]
  nameHits: readonly SearchHit[]
  nameOutcome: NameSearchOutcome
  /**
   * The "this working folder" section (item 100). Hits inside the active thread's cwd, which
   * do not overlap `fileHits` / `nameHits` (everywhere). null if there is no cwd (not searched). The section is kept even with 0 hits (item 292).
   */
  fileCwd: SearchSection | null
  nameCwd: NameSearchSection | null
  /**
   * The "this working folder" section of the conversation search (TODO 1096). Messages of threads whose cwd is (under) the active thread's cwd,
   * which do not overlap `conversationHits` (everywhere). null if there is no cwd (not searched). The section is kept even with 0 hits (item 292).
   */
  conversationCwd: SearchSection | null
  fileTookMs: number
  conversationTookMs: number
  /** When not searched because the term is too short, how many more characters are needed (P8 / item 41). 0 means it was searched. */
  fileMissingChars: number
  conversationMissingChars: number
  /**
   * The results now shown were searched case-sensitively (smart case, TODO 291). The basis for the `Aa` badge
   * to the right of the search field. The decision is carried on the result by the index process (the renderer does not decide).
   */
  fileCaseSensitive: boolean
  nameCaseSensitive: boolean
  conversationCaseSensitive: boolean

  nameTookMs: number
  searching: boolean
  status: IndexStatus | null
  /**
   * "Focus this field" from a shortcut (item 48). `seq` is a number that makes the effect run even when the same field
   * is requested repeatedly. The consumer does not clear it (the next request advances `seq`, so they can be told apart).
   * `seed` rewrites the field's contents and also runs the search (TODO 630, right-click on a viewer selection).
   * If omitted, the contents are not touched (focus + select all, as before).
   */
  focusRequest: { readonly target: SearchTarget; readonly seq: number; readonly seed?: string } | null
  /**
   * The index process did not answer within the limit (item 87). Holds as is the text that main's `IndexClient` rejected with the reason code
   * `index-busy`, and the status bar shows it with `describeReason`.
   */
  indexBusy: string | null
  /** The scope of the Search screen (TODO 437). null means everywhere (and the cwd section, item 100). */
  range: SearchRange | null

  init(): Promise<void>
  /** A query to the index failed. If `index-busy`, show it in the status bar (shared by search and listing). */
  noteIndexError(err: unknown): void
  /** The index answered. Clear the "busy" that was shown. */
  noteIndexAnswered(): void
  setFileQuery(query: string): void
  setConversationQuery(query: string): void
  setNameQuery(query: string): void
  /**
   * If the active thread's cwd differs from when it was last searched, redo the already-typed in-file / file-name
   * search (item 100) and conversation search (TODO 1096). If the same, do nothing.
   */
  refreshForCwd(): void
  /**
   * Set the scope (TODO 437). Redo the already-typed body / file-name searches with the scope, and ask for the build of that subtree
   * (`search.buildScope`). If main's choke point refuses, drop the scope (no badge is shown).
   */
  setRange(uri: string): void
  /** Drop the scope (the badge's ✕). Redo the search over everywhere (and the cwd section). */
  clearRange(): void
  requestFocus(target: SearchTarget, seed?: string): void
  /**
   * The `seed` of `focusRequest` has been used up (wave 29 code-review). Each time SearchMode is reopened, the mount
   * effect reads the same request again, so if it is not consumed the field is overwritten with the old term. Only when `seq` equals the current request,
   * remove `seed` (the focus request itself stays: the focus on reopening is as before).
   */
  consumeFocusSeed(seq: number): void
  pause(): Promise<void>
  resume(): Promise<void>
}

/** The scope (TODO 437) changed. Redo the already-typed searches of the 2 that the scope affects (body, file name). */
function rerunScoped(state: SearchState): void {
  if (state.fileQuery.trim() !== '') state.setFileQuery(state.fileQuery)
  if (state.nameQuery.trim() !== '') state.setNameQuery(state.nameQuery)
}

export const useSearch = create<SearchState>((set, get) => ({
  fileQuery: '',
  conversationQuery: '',
  nameQuery: '',
  fileHits: NO_HITS,
  conversationHits: NO_HITS,
  nameHits: NO_HITS,
  nameOutcome: NO_NAME_OUTCOME,
  fileCwd: null,
  nameCwd: null,
  conversationCwd: null,
  fileTookMs: 0,
  conversationTookMs: 0,
  fileMissingChars: 0,
  conversationMissingChars: 0,
  fileCaseSensitive: false,
  nameCaseSensitive: false,
  conversationCaseSensitive: false,

  nameTookMs: 0,
  searching: false,
  status: null,
  focusRequest: null,
  indexBusy: null,
  range: null,

  noteIndexError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (parseReason(message)?.code !== 'index-busy') return
    set({ indexBusy: message })
    if (busyTimer !== null) clearTimeout(busyTimer)
    busyTimer = setTimeout(() => {
      busyTimer = null
      set({ indexBusy: null })
    }, BUSY_NOTICE_MS)
  },

  noteIndexAnswered(): void {
    if (get().indexBusy === null) return
    if (busyTimer !== null) clearTimeout(busyTimer)
    busyTimer = null
    set({ indexBusy: null })
  },

  async init(): Promise<void> {
    const status = await window.aios.search.getStatus()
    set({ status })
    window.aios.search.onStatus((next) => set({ status: next }))
  },

  setFileQuery(query: string): void {
    set({ fileQuery: query })
    if (query.trim() === '') {
      set({
        fileHits: NO_HITS,
        fileCwd: null,
        fileTookMs: 0,
        fileMissingChars: 0,
        fileCaseSensitive: false
      })
      return
    }
    set({ searching: true })
    const order = nextSeq('files')
    const cwd = activeCwdUri()
    queriedCwd = cwd
    // If there is a scope (TODO 437), main / the index process do not use the cwd and return only what is inside the scope in `hits`.
    const range = get().range?.uri ?? null
    void window.aios.search
      .query(query, 'files', LIMIT, order, cwd, range)
      .then((result: SearchResponse) => {
        get().noteIndexAnswered()
        // An old query that returned without being run (P6). It is not an empty result, so discard it.
        if (result.stale === true) return
        // Discard if the input (or the cwd, item 100) has moved on.
        if (get().fileQuery !== query || seq.files !== order) return
        set({
          fileHits: result.hits,
          // Sections with 0 hits are kept too (item 292): null means "the section was not searched" (no cwd / not in the index),
          // and empty hits means "searched and found 0". Whether to show the heading is decided in `search-regions.ts`.
          fileCwd: result.cwd ?? null,
          fileTookMs: result.tookMs,
          // Not searched because it is too short (P8). Do not lie with 0 hits; show "N more characters".
          fileMissingChars: result.tooShort === true ? (result.missingChars ?? 0) : 0,
          fileCaseSensitive: result.caseSensitive === true,
          searching: false
        })
      })
      .catch((err: unknown) => {
        // The index is busy / went down (item 87). Release "searching"; the reason goes to the status bar.
        if (get().fileQuery === query) set({ searching: false })
        get().noteIndexError(err)
      })
  },

  setConversationQuery(query: string): void {
    set({ conversationQuery: query })
    if (query.trim() === '') {
      set({
        conversationHits: NO_HITS,
        conversationCwd: null,
        conversationTookMs: 0,
        conversationMissingChars: 0,
        conversationCaseSensitive: false
      })
      return
    }
    set({ searching: true })
    const order = nextSeq('conversation')
    // The "this working folder" section (TODO 1096). main searches the threads whose cwd is (under) this cwd and makes their messages the section above.
    const cwd = activeCwdUri()
    queriedConversationCwd = cwd
    void window.aios.search
      .query(query, 'conversation', LIMIT, order, cwd)
      .then((result: SearchResponse) => {
        get().noteIndexAnswered()
        if (result.stale === true) return
        // Discard if the input or the cwd (TODO 1096) has moved on. The same query is redone under another cwd, so check the number too.
        if (get().conversationQuery !== query || seq.conversation !== order) return
        set({
          conversationHits: result.hits,
          // Sections with 0 hits are kept too (item 292). null means "the section was not searched" (no cwd / refused at the choke point).
          conversationCwd: result.cwd ?? null,
          conversationTookMs: result.tookMs,
          conversationMissingChars: result.tooShort === true ? (result.missingChars ?? 0) : 0,
          conversationCaseSensitive: result.caseSensitive === true,
          searching: false
        })
      })
      .catch((err: unknown) => {
        if (get().conversationQuery === query) set({ searching: false })
        get().noteIndexError(err)
      })
  },

  setNameQuery(query: string): void {
    set({ nameQuery: query })
    if (query.trim() === '') {
      set({
        nameHits: NO_HITS,
        nameOutcome: NO_NAME_OUTCOME,
        nameCwd: null,
        nameTookMs: 0,
        nameCaseSensitive: false
      })
      return
    }
    set({ searching: true })
    nameRequest += 1
    const request = nameRequest
    // The generation number is held by the index process (6.6.4): when typing moves on, an old query stops itself
    // at a page boundary and returns `cancelled`, so that response is not shown on screen.
    // The renderer-side "discard if the input has moved on" is applied the same way as for body search.
    const cwdUri = activeCwdUri()
    queriedCwd = cwdUri
    const range = get().range?.uri ?? null
    void window.aios.fs
      .searchFiles(query, LIMIT, cwdUri, range)
      .then((result: FileSearchResult) => {
        get().noteIndexAnswered()
        if (result.cancelled) return
        if (get().nameQuery !== query || request !== nameRequest) return
        const cwd = result.cwd
        set({
          nameHits: result.entries.map(toNameHit),
          nameCwd:
            cwd === null
              ? null
              : {
                  uri: cwd.uri,
                  hits: cwd.entries.map(toNameHit),
                  total: cwd.total,
                  truncated: cwd.truncated,
                  scanTruncated: cwd.scanTruncated
                },
          nameOutcome: {
            total: result.total,
            truncated: result.truncated,
            scanTruncated: result.scanTruncated
          },
          nameTookMs: result.tookMs,
          nameCaseSensitive: result.caseSensitive === true,
          searching: false
        })
      })
      .catch((err: unknown) => {
        if (get().nameQuery === query) set({ searching: false })
        get().noteIndexError(err)
      })
  },

  refreshForCwd(): void {
    // If results for the same cwd are already shown, do not search again (do not run it every time the user returns to search mode).
    const cwd = activeCwdUri()
    if (queriedCwd !== undefined && queriedCwd !== cwd) {
      const { fileQuery, nameQuery } = get()
      if (fileQuery.trim() !== '') get().setFileQuery(fileQuery)
      if (nameQuery.trim() !== '') get().setNameQuery(nameQuery)
    }
    // The conversation search (TODO 1096) is compared against a cwd remembered separately from the File side.
    if (queriedConversationCwd !== undefined && queriedConversationCwd !== cwd) {
      const { conversationQuery } = get()
      if (conversationQuery.trim() !== '') get().setConversationQuery(conversationQuery)
    }
  },

  setRange(uri: string): void {
    rangeRequest += 1
    const request = rangeRequest
    set({ range: { uri, building: true, pending: null } })
    rerunScoped(get())
    void window.aios.search
      .buildScope(uri)
      .then((result) => {
        get().noteIndexAnswered()
        if (request !== rangeRequest || get().range?.uri !== uri) return
        set({ range: { uri, building: false, pending: result } })
        // So that the built part shows up in body search, search again if something is already typed.
        if (result.built > 0) {
          const { fileQuery } = get()
          if (fileQuery.trim() !== '') get().setFileQuery(fileQuery)
        }
      })
      .catch((err: unknown) => {
        if (request !== rangeRequest || get().range?.uri !== uri) return
        const message = err instanceof Error ? err.message : String(err)
        if (parseReason(message)?.code === 'index-busy') {
          // The index is merely busy (item 87). Keep the scope; the reason goes to the status bar.
          set({ range: { uri, building: false, pending: null } })
          get().noteIndexError(err)
          return
        }
        // Refused at main's choke point (hit an exclusion, etc.). No badge is shown (drop the scope).
        set({ range: null })
        rerunScoped(get())
      })
  },

  clearRange(): void {
    if (get().range === null) return
    rangeRequest += 1
    set({ range: null })
    rerunScoped(get())
  },

  conversationDraft: '',

  setConversationDraft(draft: string): void {
    if (get().conversationDraft !== draft) set({ conversationDraft: draft })
  },

  requestFocus(target: SearchTarget, seed?: string): void {
    // TODO 1199: while the conversation search has a term, the body-search and file-name-search fields are disabled. Pass neither focus nor seed.
    if (isConversationLocked(get()) && (target === 'files' || target === 'names')) return
    set({
      focusRequest: {
        target,
        seq: (get().focusRequest?.seq ?? 0) + 1,
        ...(seed === undefined ? {} : { seed })
      }
    })
  },

  consumeFocusSeed(seq: number): void {
    const current = get().focusRequest
    if (current === null || current.seq !== seq || current.seed === undefined) return
    set({ focusRequest: { target: current.target, seq: current.seq } })
  },

  async pause(): Promise<void> {
    await window.aios.search.pause()
  },

  async resume(): Promise<void> {
    await window.aios.search.resume()
  }
}))
