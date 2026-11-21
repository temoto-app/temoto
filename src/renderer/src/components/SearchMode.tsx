/**
 * Search mode (ARCHITECTURE.md 6.1). The third mode of the left column.
 *
 * There are three search boxes (in order from the top; TODO 46 put the file-name box in the middle):
 * - **In-file search**: the body of local files (`source = fs`)
 * - **File-name search**: file names only (6.6, qlm's Quick Open style). The body is not queried
 * - **In-conversation search**: the messages of all threads and imported transcripts (`source = conversation / transcript`)
 *
 * Body and conversation differ only by the `source` filter on the same index, and p50 is 40 ms even with 1 million documents
 * (spike 11b), so it is an incremental search. File names take a separate route
 * (`fs.searchFiles`, which walks the name coverage index inside the index process), but
 * **all three results are laid out in one single virtual list** divided into sections.
 * Snippets arrive from main **generated from the canonical copy** (6.5).
 * File-name rows have no snippet (and the row height is smaller too).
 *
 * Shortcuts (items 48 / 189): Cmd+Shift+F (and Cmd+F outside the viewer) / Cmd+P / Cmd+K are caught by `App.tsx`, and
 * focus comes to the input field here through `searchStore.requestFocus`.
 *
 * Icons (item 47, 5.5.3): **the emoji at the head of the placeholder** doubles as the box's icon
 * (document / magnifier / speech balloon, the strings are identical to qlm). An SVG in the input field would take up width, so
 * none is placed; qlm also removed its SVG for the same reason.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SearchHit } from '@shared/search.js'
import { displayPath } from '@shared/uri.js'
import { NewChatButton } from './NewChatButton.js'
import { conversationSnippet } from '../search-snippet.js'
import { NO_HITS, isConversationLocked, useSearch, type SearchRange } from '../searchStore.js'
import { useStore } from '../store.js'
import { useThreads } from '../threadStore.js'
import { selectActiveCwd } from '../active-cwd.js'
import { useEditor } from '../editorStore.js'
import { useT } from '../i18n/index.js'
import type { Translate } from '../i18n/index.js'
import { threadTitleLabel } from '../thread/title.js'
import { OpenExternalIcon } from '../icons/OpenExternalIcon.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { keyPlatformOf } from '../composer-keys.js'
import { searchKeyLabel, type SearchTarget } from '../shortcuts.js'
import { activeIndex, listKeyStep, navKey } from '../list-keys.js'
import { clearContentSearches, returnToThreadsAfterNameOpen, revealFolderInFiles } from '../shortcut-actions.js'
import { regionRows, type RegionNoteRow } from '../search-regions.js'
import { PathActions } from './PathActions.js'
import { Tooltip } from './Tooltip.js'
import { isDraggableHit, startHitDrag } from '../search-drag.js'
import { TranscriptContinueDialog } from './TranscriptContinue.js'
import { SearchCaseBadge } from './SearchCaseBadge.js'
import { ContextMenu, useContextMenuState } from './ContextMenu.js'
import { openButtonLabelKey, pathContextMenuItems } from '../path-context-menu.js'
import { FileIcon } from '../icons/file-icons/FileIcon.js'
import { AppBundleIcon } from '../icons/file-icons/AppBundleIcon.js'
import { isAppBundle } from '@shared/app-bundle.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { recentKindOf } from '@shared/recent-files.js'
import { useThumbnail } from './RecentFiles.js'
import { useSearchHistory } from '../searchHistoryStore.js'
import type { SearchHistoryEntry } from '@shared/search-history.js'
import { SearchHistoryList } from './SearchHistoryList.js'
import { usePluginList } from '../extensions.js'
import { openSavedWebUrl } from '../webStore.js'
import {
  IDLE_PROVIDER,
  openPluginResult,
  pluginSearchProviders,
  pluginSearchRows,
  pluginSearchTarget,
  usePluginSearch,
  type PluginSearchProvider,
  type PluginSearchRow,
  type PluginSearchTarget
} from '../pluginSearch.js'

const KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)
const SEARCH_DEBOUNCE_MS = 150
/** TODO 1244: the wait before the top file-name hit is opened automatically in the viewer. It does not open on every keystroke. */
const NAME_AUTO_OPEN_MS = 300
/**
 * An fs hit is two rows (item 55): the file name in the first, the `displayPath` path in the second.
 * A body-search row additionally has a snippet row. A conversation hit has no path (`context` is the thread name),
 * so it stays one row as before.
 */
const ROW_HEIGHT = 72
const CONVERSATION_ROW_HEIGHT = 56
/** A file-name search row. Two rows (file name + path), no snippet. */
const NAME_ROW_HEIGHT = 40
const HEADER_HEIGHT = 24
/** The small heading "this working folder" / "everywhere" (item 100). Placed one row below the box's heading. */
const REGION_HEIGHT = 22
/** The one-line notice when the cwd section has 0 hits (item 292). */
const NOTE_HEIGHT = 22

type Row =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'region'
      readonly id: string
      readonly label: string
      /** For the cwd section only. A display path folded to `~` (if long, the head side is cut with `…`). */
      readonly path: string | null
      readonly count: string
    }
  | RegionNoteRow
  | {
      readonly kind: 'hit'
      readonly id: string
      readonly hit: SearchHit
      /** Which box the result belongs to (TODO 357: the row its Up/Down moves): body (`files`) or conversation (`conversation`). */
      readonly section: SearchTarget
    }
  | { readonly kind: 'name'; readonly id: string; readonly hit: SearchHit; readonly section: 'names' }
  // TODO 896: rows of a plugin's search section (heading, notice, results).
  | PluginSearchRow

/** The field with focus: one of the three local boxes, or a plugin section's field (TODO 896). */
type FocusTarget = SearchTarget | PluginSearchTarget

/** Whether a row can be pointed at by that box's (`target`) Up/Down / Enter (TODO 357). Heading, sub-heading and notice rows are skipped. */
export function selectableFor(rows: readonly Row[], target: FocusTarget | null): boolean[] {
  return rows.map((row) => (row.kind === 'hit' || row.kind === 'name' || row.kind === 'plugin') && row.section === target)
}

export function SearchMode(): React.JSX.Element {
  const fileHits = useSearch((state) => state.fileHits)
  const nameHits = useSearch((state) => state.nameHits)
  const nameOutcome = useSearch((state) => state.nameOutcome)
  const fileCwd = useSearch((state) => state.fileCwd)
  const nameCwd = useSearch((state) => state.nameCwd)
  const refreshForCwd = useSearch((state) => state.refreshForCwd)
  const cwdUri = useThreads(selectActiveCwd)
  const conversationHits = useSearch((state) => state.conversationHits)
  const conversationCwd = useSearch((state) => state.conversationCwd)
  const fileMissingChars = useSearch((state) => state.fileMissingChars)
  const conversationMissingChars = useSearch((state) => state.conversationMissingChars)
  const fileCaseSensitive = useSearch((state) => state.fileCaseSensitive)
  const nameCaseSensitive = useSearch((state) => state.nameCaseSensitive)
  const conversationCaseSensitive = useSearch((state) => state.conversationCaseSensitive)
  const setFileQuery = useSearch((state) => state.setFileQuery)
  const setNameQuery = useSearch((state) => state.setNameQuery)
  const setConversationQuery = useSearch((state) => state.setConversationQuery)
  const focusRequest = useSearch((state) => state.focusRequest)
  const consumeFocusSeed = useSearch((state) => state.consumeFocusSeed)
  // TODO 437: the range (decided by the magnifier / right-click on a folder in the Files tree). It affects body and file-name search.
  const range = useSearch((state) => state.range)
  const clearRange = useSearch((state) => state.clearRange)
  const rangeUri = range?.uri ?? null
  const select = useStore((state) => state.select)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const platform = useStore((state) => state.appInfo?.platform)
  const jumpToEvent = useThreads((state) => state.jumpToEvent)
  const createThreadInFolder = useThreads((state) => state.createThreadInFolder)
  const t = useT()
  // Item 115: open an fs hit in the external editor. Main holds the settings including the default (VS Code).
  const openInEditor = useEditor((state) => state.open)
  // TODO 1214: the one button on a hit row is dispatched by extension, and the right-click has two rows, "open in the default app" and "open in the editor".
  const openFile = useEditor((state) => state.openFile)
  const openDefault = useEditor((state) => state.openDefault)
  // TODO 299: the right-click menu on an fs hit row.
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()

  // TODO 809: all three take their seed from the store's search term (a safeguard). `jumpToEvent`, which a conversation hit press triggers, passes
  // `keepMode` to `selectThread`, so this component is no longer unmounted (TODO 828).
  const [fileDraft, setFileDraft] = useState(() => useSearch.getState().fileQuery)
  // TODO 371: after Cmd+P the sidebar goes back to Threads (this component is unmounted), so
  // the previous search term is seeded from `searchStore.nameQuery` (it survives unmounting) and kept.
  // The next Cmd+P shows the previous term selected (all selected), the same as VS Code's Quick Open.
  const [nameDraft, setNameDraftRaw] = useState(() => useSearch.getState().nameQuery)
  // TODO 1244 (wave 88 code-review): the top hit is opened automatically only after the user has touched the name field during this mount (typed, history, a Cmd+P seed).
  // It is not opened for the previous result that was left in the store at mount.
  const [nameTouched, setNameTouched] = useState(false)
  const setNameDraft = useCallback((value: string): void => {
    setNameTouched(true)
    setNameDraftRaw(value)
  }, [])
  const [conversationDraft, setConversationDraft] = useState(() => useSearch.getState().conversationQuery)
  // TODO 1199: while the conversation search has even one character, the body-search and file-name fields are grayed out (their contents are kept).
  const filesLocked = useSearch(isConversationLocked)
  // Copy the draft into the store (so it is grayed out even for a term before the debounce). On unmount, align to the confirmed term (so the lock does not stay when there is no term).
  useEffect(() => {
    useSearch.getState().setConversationDraft(conversationDraft)
  }, [conversationDraft])
  useEffect(
    () => () => useSearch.getState().setConversationDraft(useSearch.getState().conversationQuery),
    []
  )
  // "Continue this conversation" on a transcript hit (item 111). Shows a small window for the `uri` of the pressed row.
  const [continuing, setContinuing] = useState<string | null>(null)
  const parentRef = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)
  const conversationInput = useRef<HTMLInputElement | null>(null)
  // TODO 357 (VS Code's Quick Open): focus stays on the box, Up/Down move the result highlight, and Enter opens.
  // `focused` is the box that has focus now (it points only at that box's results), and `cursor` is the position moved with Up/Down (a row number).
  // When the list changes it goes back to -1 and the first candidate is highlighted (`activeIndex`).
  const [focused, setFocused] = useState<FocusTarget | null>(null)
  const [cursor, setCursor] = useState(-1)
  // Whether IME composition is in progress (the same gate as the filter field in `Sidebar.tsx`. `navKey` also looks at isComposing / 229).
  const composing = useRef(false)
  // TODO 900: search history (one list for the three boxes). The box that is open, and the highlighted suggestion (-1 = no suggestion chosen).
  const history = useSearchHistory((state) => state.items)
  const [historyOpen, setHistoryOpen] = useState<SearchTarget | null>(null)
  const [historyCursor, setHistoryCursor] = useState(-1)
  // TODO 896: plugin search sections (only those that are bundled and enabled. Main puts them in the summary).
  const pluginList = usePluginList()
  const providers = useMemo(() => pluginSearchProviders(pluginList), [pluginList])
  const pluginSearch = usePluginSearch((state) => state.byPlugin)
  const setPluginDraft = usePluginSearch((state) => state.setDraft)
  const submitPluginSearch = usePluginSearch((state) => state.submit)
  const listId = useId()
  const rowDomId = (index: number): string => `${listId}-r${index}`

  // Do not hit the DB on every character. Also calm down during Japanese IME composition.
  useEffect(() => {
    const timer = setTimeout(() => setFileQuery(fileDraft), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [fileDraft, setFileQuery])

  useEffect(() => {
    const timer = setTimeout(() => setNameQuery(nameDraft), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [nameDraft, setNameQuery])

  useEffect(() => {
    const timer = setTimeout(() => setConversationQuery(conversationDraft), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [conversationDraft, setConversationQuery])

  // When the thread is switched and cwd changes, re-run an already-typed search with the new cwd (item 100).
  // The same applies when switching outside search mode and coming back (comparing with the last cwd used is on the store's side).
  useEffect(() => {
    refreshForCwd()
  }, [cwdUri, refreshForCwd])

  // Focus from a shortcut (item 48). It is mounted by the same render as the mode switch, so
  // this effect always runs once after the request is raised. Select all so that it can be retyped.
  useEffect(() => {
    if (focusRequest === null) return
    const target =
      focusRequest.target === 'files'
        ? fileInput.current
        : focusRequest.target === 'names'
          ? nameInput.current
          : conversationInput.current
    // TODO 630: the viewer's right-click "Search" also rewrites the field's contents (the focus-only requests so far
    // have no `seed`). Rewriting `fileDraft` makes the debounced effect call `setFileQuery`.
    // The used `seed` is consumed (so a re-open mount does not go back to the old term). The request generation is not changed, so
    // the re-run for the `focusRequest` that changed through this consumption has no seed and only applies focus once more.
    if (focusRequest.seed !== undefined) {
      // A body / file-name seed arrives only when the lock (TODO 1199) is off: the right-click on a selection asks after clearing the conversation search
      // term in the store (`searchSelection`). If the local draft is not emptied too, the write-back brings the lock back.
      if (focusRequest.target !== 'conversation') setConversationDraft('')
      if (focusRequest.target === 'files') setFileDraft(focusRequest.seed)
      // TODO 816: "search by name" in the strip for a link that could not be opened puts the name in the file-name search field.
      else if (focusRequest.target === 'names') setNameDraft(focusRequest.seed)
      // TODO 1030: "search in conversations" from the right-click on a selection puts it in the conversation search field.
      else setConversationDraft(focusRequest.seed)
      consumeFocusSeed(focusRequest.seq)
    }
    target?.focus()
    target?.select()
  }, [focusRequest, consumeFocusSeed, setNameDraft])

  // **Build the combined array here, not in a selector** (the Phase 2 zustand pitfall).
  const localRows = useMemo<readonly Row[]>(() => {
    const out: Row[] = []
    /**
     * Two sections, "this working folder" then "everywhere" (item 100). When there is no cwd section (no cwd, or 0 hits),
     * only the "everywhere" sub-heading is shown. If everywhere has 0 hits, its sub-heading is not shown.
     */
    const regions = (
      prefix: string,
      cwd: { readonly uri: string; readonly count: string } | null,
      cwdRows: readonly Row[],
      allCount: string,
      allRows: readonly Row[],
      /** The one line when the cwd section has 0 hits (item 292). For conversations (TODO 1096) the wording says "in conversations". */
      cwdEmpty: (path: string) => string = (path) => t('search.region.cwdEmpty', { path })
    ): void => {
      out.push(
        ...regionRows<Row>({
          prefix,
          cwd: cwd === null ? null : { path: folderLabel(cwd.uri, homeUri), count: cwd.count },
          cwdRows,
          allCount,
          allRows,
          labels: {
            cwd: t('search.region.cwd'),
            all: t('search.region.all'),
            cwdEmpty
          }
        })
      )
    }

    /**
     * When there is a range (TODO 437), the two sections of 100 are not shown and there is one section. The sub-heading is "range" + the range path.
     * Main returns only what is inside the range to the "everywhere" side (`hits` / `entries`) and does not make a cwd section.
     */
    const scoped = (prefix: string, count: string, hitRows: readonly Row[]): void => {
      if (rangeUri === null || hitRows.length === 0) return
      out.push({
        kind: 'region',
        id: `${prefix}-r-range`,
        label: t('search.region.range'),
        path: folderLabel(rangeUri, homeUri),
        count
      })
      out.push(...hitRows)
    }

    const fileCwdHits = fileCwd?.hits ?? NO_HITS
    if (rangeUri !== null && fileHits.length > 0) {
      out.push({ kind: 'header', id: 'h-files', label: t('search.section.files', { count: fileHits.length }) })
      scoped(
        'f',
        `${fileHits.length}`,
        fileHits.map((hit) => ({ kind: 'hit', id: `f-${hit.id}`, hit, section: 'files' }))
      )
    } else if (rangeUri === null && fileHits.length + fileCwdHits.length > 0) {
      out.push({
        kind: 'header',
        id: 'h-files',
        label: t('search.section.files', { count: fileHits.length + fileCwdHits.length })
      })
      regions(
        'f',
        fileCwd === null ? null : { uri: fileCwd.uri, count: `${fileCwdHits.length}` },
        fileCwdHits.map((hit) => ({ kind: 'hit', id: `fc-${hit.id}`, hit, section: 'files' })),
        `${fileHits.length}`,
        fileHits.map((hit) => ({ kind: 'hit', id: `f-${hit.id}`, hit, section: 'files' }))
      )
    }
    const nameCwdHits = rangeUri === null ? (nameCwd?.hits ?? NO_HITS) : NO_HITS
    if (nameHits.length + nameCwdHits.length > 0) {
      // A cutoff is declared in the heading (6.6.4 "do not drop silently").
      const countOf = (shown: number, total: number): string =>
        total > shown
          ? t('search.section.topOfTotal', { shown, total: total.toLocaleString() })
          : `${shown}`
      const shown = nameHits.length + nameCwdHits.length
      const total = nameOutcome.total + (nameCwd?.total ?? 0)
      const note =
        nameOutcome.scanTruncated || nameCwd?.scanTruncated === true
          ? t('search.section.truncatedSuffix')
          : ''
      out.push({
        kind: 'header',
        id: 'h-names',
        label: `${t('search.section.names', { count: countOf(shown, total) })}${note}`
      })
      if (rangeUri !== null) {
        scoped(
          'n',
          countOf(nameHits.length, nameOutcome.total),
          nameHits.map((hit) => ({ kind: 'name', id: `n-${hit.id}`, hit, section: 'names' }))
        )
      } else regions(
        'n',
        nameCwd === null
          ? null
          : { uri: nameCwd.uri, count: countOf(nameCwdHits.length, nameCwd.total) },
        nameCwdHits.map((hit) => ({ kind: 'name', id: `nc-${hit.id}`, hit, section: 'names' })),
        countOf(nameHits.length, nameOutcome.total),
        nameHits.map((hit) => ({ kind: 'name', id: `n-${hit.id}`, hit, section: 'names' }))
      )
    }
    // Conversations also use the two sections "this working folder" then "everywhere" (TODO 1096). The cwd is the active thread's cwd, and
    // messages of threads that ran under it come first. The range (TODO 437) is not applied to conversations.
    const conversationCwdHits = conversationCwd?.hits ?? NO_HITS
    if (conversationHits.length + conversationCwdHits.length > 0) {
      out.push({
        kind: 'header',
        id: 'h-conv',
        label: t('search.section.conversation', { count: conversationHits.length + conversationCwdHits.length })
      })
      regions(
        'c',
        conversationCwd === null ? null : { uri: conversationCwd.uri, count: `${conversationCwdHits.length}` },
        conversationCwdHits.map((hit) => ({ kind: 'hit', id: `cc-${hit.id}`, hit, section: 'conversation' })),
        `${conversationHits.length}`,
        conversationHits.map((hit) => ({ kind: 'hit', id: `c-${hit.id}`, hit, section: 'conversation' })),
        (path) => t('search.region.cwdConversationEmpty', { path })
      )
    }
    return out
  }, [fileHits, fileCwd, nameHits, nameOutcome, nameCwd, conversationHits, conversationCwd, homeUri, t, rangeUri])

  // TODO 896 (review fix): plugin sections come after the three local ones (external searches arrive late, so they must not push earlier rows down).
  // Keep it in a separate memo from the local rows so a plugin response or typing in a field does not reset the cursor of the local results.
  const pluginRows = useMemo<readonly Row[]>(
    () =>
      pluginSearchRows(providers, pluginSearch, {
        section: (title, count) => t('search.plugin.section', { title, count }),
        searching: t('search.plugin.searching'),
        empty: t('search.plugin.empty'),
        dropped: (n) => t('search.plugin.dropped', { n }),
        error: (code) => t(`search.plugin.error.${code}`)
      }),
    [providers, pluginSearch, t]
  )
  const rows = useMemo<readonly Row[]>(() => [...localRows, ...pluginRows], [localRows, pluginRows])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (row === undefined) return ROW_HEIGHT
      if (row.kind === 'header') return HEADER_HEIGHT
      if (row.kind === 'region') return REGION_HEIGHT
      if (row.kind === 'note') return NOTE_HEIGHT
      if (row.kind === 'name') return NAME_ROW_HEIGHT
      if (row.kind === 'plugin') return row.result.snippet === undefined ? NAME_ROW_HEIGHT : CONVERSATION_ROW_HEIGHT
      // A conversation hit has no path row, so it stays short (item 55).
      return row.hit.source === 'fs' ? ROW_HEIGHT : CONVERSATION_ROW_HEIGHT
    },
    overscan: 10
  })

  // Only a body-search hit carries the search term to the viewer (item 56). A File-name search (item 46) hit is also
  // `file://`, but it was only found by name, so the body is not highlighted.
  const open = (hit: SearchHit, highlight: boolean): void => {
    if (hit.threadId !== null && hit.eventId !== null) {
      void jumpToEvent(hit.threadId, hit.eventId)
      return
    }
    // TODO 436: a folder row in file-name search is not opened in the viewer; the folder is selected in the Files tree.
    if (hit.source === 'fs' && hit.kind === 'directory') {
      revealFolderInFiles(hit.uri)
      return
    }
    if (hit.uri.startsWith('file://')) {
      // A PDF hit goes to its page (TODO 1009 stage 2). A file-name search hit has no `page`.
      const options = {
        ...(highlight ? { highlight: useSearch.getState().fileQuery } : {}),
        ...(highlight && hit.page !== undefined ? { page: hit.page } : {})
      }
      select(hit.uri, Object.keys(options).length > 0 ? options : undefined)
    }
  }

  /**
   * Opens a row. Only for a file-name search (`'name'`) row, **only when it was opened by keyboard (Enter)**,
   * the sidebar goes back to Threads (TODO 410, a revision of 371). When opened by a mouse click it stays on the search
   * screen with focus left in the search field, so the next candidate can be pressed (owner request 2026-10-04).
   * A body hit (`'hit'`, files / conversation) stays in search mode with either, as before.
   * A folder row (TODO 436) is switched to Files by `open`, so it does not go back to Threads.
   */
  const openRow = (row: Row, via: 'keyboard' | 'pointer'): void => {
    // TODO 896: a plugin section's result is opened according to the section's `openWith` (staying on the search screen).
    if (row.kind === 'plugin') {
      openPluginResult(row.openWith, row.result.open, {
        web: (url) => openSavedWebUrl(url, false),
        external: (url) => void window.aios.app.openExternal(url),
        viewer: (uri) => select(uri)
      })
      return
    }
    if (row.kind !== 'hit' && row.kind !== 'name') return
    // TODO 900: when a result is opened, leave that box's search term in the history (not on every keystroke).
    const asked = useSearch.getState()
    void useSearchHistory
      .getState()
      .add(
        row.kind === 'name'
          ? asked.nameQuery
          : row.hit.source === 'fs'
            ? asked.fileQuery
            : asked.conversationQuery,
        row.kind === 'name' ? 'names' : row.hit.source === 'fs' ? 'files' : 'conversation'
      )
    open(row.hit, row.kind === 'hit')
    if (row.kind === 'name' && via === 'keyboard' && row.hit.kind !== 'directory') {
      returnToThreadsAfterNameOpen()
    }
  }

  // TODO 1244: show the top file-name hit (the first `name` row in screen order) in the viewer once the results settle.
  // The search field's focus, the term and the sidebar display are not moved (it does not go through `openRow`, and nothing is left in the history).
  // A folder row would switch to Files, so it is not opened automatically. If there is an unsaved draft, do not replace it.
  const topNameUri = useMemo(() => {
    const first = localRows.find((row) => row.kind === 'name')
    return first !== undefined && first.kind === 'name' && first.hit.kind !== 'directory' ? first.hit.uri : null
  }, [localRows])
  useEffect(() => {
    if (!nameTouched || filesLocked) return
    if (topNameUri === null || !topNameUri.startsWith('file://')) return
    const timer = setTimeout(() => {
      const state = useStore.getState()
      if (state.viewerDirty || state.selectedUri === topNameUri) return
      // A temporary view (diff etc.) and a web page are treated like unsaved edits and are not replaced automatically (`select` clears a temporary view).
      if (state.transient !== null) return
      if (state.selectedUri !== null && !state.selectedUri.startsWith('file://')) return
      state.select(topNameUri)
    }, NAME_AUTO_OPEN_MS)
    return () => clearTimeout(timer)
  }, [topNameUri, nameTouched, filesLocked])

  // When the results change, the highlight returns to the first candidate (as in Quick Open).
  // TODO 896 (review fix): reset only when the local results change. A plugin response or typing in a field does not move
  // the cursor on a local row (only when on a plugin row, that row is replaced, so it is reset).
  useEffect(() => {
    setCursor(-1)
  }, [localRows])
  useEffect(() => {
    setCursor((current) => (current >= localRows.length ? -1 : current))
  }, [pluginRows, localRows.length])

  const selectable = useMemo(() => selectableFor(rows, focused), [rows, focused])
  const active = focused === null ? -1 : activeIndex(cursor, selectable)

  /**
   * The keydown common to the three boxes (TODO 357). Up/Down cycle within that box's results (section headings are skipped), and
   * Enter is the same as pressing the highlighted row (`open`). Esc and other keys are not touched (the field's default behavior).
   * Home / End are left to the text cursor of the field.
   */
  const onInputKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    target: SearchTarget,
    draft: string
  ): void => {
    // Up / Enter during IME composition is used for neither history nor results (`navKey` looks at isComposing / 229).
    const key = navKey(event, composing.current)
    if (key === null) return
    // TODO 900: while the history suggestions are open, Up/Down / Enter / Esc belong to the suggestions.
    if (historyOpen === target && history.length > 0) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        const last = history.length - 1
        setHistoryCursor((at) =>
          key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : at <= 0 ? last : at - 1
        )
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        setHistoryOpen(null)
        return
      }
      const picked = history[historyCursor]
      if (key === 'Enter' && picked !== undefined) {
        event.preventDefault()
        pickHistory(picked)
        return
      }
    } else if (key === 'ArrowUp' && history.length > 0 && (draft.trim() === '' || rows.length === 0)) {
      // When closed, Up opens it (only when the field is empty or there are no results to move; if there are results, Up works on the results as before).
      event.preventDefault()
      setHistoryOpen(target)
      setHistoryCursor(0)
      return
    }
    if (key === 'Enter') {
      // A term for which Enter was pressed without choosing a result is also left in the history.
      void useSearchHistory.getState().add(draft, target)
      setHistoryOpen(null)
      const row = rows[active]
      if (row === undefined || (row.kind !== 'hit' && row.kind !== 'name')) return
      event.preventDefault()
      openRow(row, 'keyboard')
      return
    }
    const next = listKeyStep(key, active, rows.length, { wrap: true, homeEnd: false, selectable })
    if (next === null) return
    event.preventDefault()
    setCursor(next)
    virtualizer.scrollToIndex(next)
  }

  /**
   * keydown of a plugin section's field (TODO 896). Enter does "if the field's term has not been sent yet, send it (do not wait the 500 ms),
   * and if the result for the sent term is shown, open the highlighted row". Up/Down move within that section's results. History suggestions are not shown.
   */
  const onPluginKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, provider: PluginSearchProvider): void => {
    const key = navKey(event, composing.current)
    if (key === null) return
    if (key === 'Enter') {
      event.preventDefault()
      const state = usePluginSearch.getState().byPlugin[provider.pluginId] ?? IDLE_PROVIDER
      const row = rows[active]
      if (state.draft.trim() === state.query && !state.searching && row?.kind === 'plugin') {
        openRow(row, 'keyboard')
        return
      }
      submitPluginSearch(provider.pluginId)
      return
    }
    if (key === 'Escape') return
    const next = listKeyStep(key, active, rows.length, { wrap: true, homeEnd: false, selectable })
    if (next === null) return
    event.preventDefault()
    setCursor(next)
    virtualizer.scrollToIndex(next)
  }

  /**
   * Choose a history suggestion (TODO 900 / 1157): put it into the field of the box for the mode the entry holds, and move focus to that field.
   * Re-querying is left to the field's debounce. Move focus first and close the suggestions last (the field's onFocus opens them when the field is empty).
   */
  const pickHistory = (entry: SearchHistoryEntry): void => {
    const { query, mode } = entry
    if (mode === 'files') setFileDraft(query)
    else if (mode === 'names') setNameDraft(query)
    else setConversationDraft(query)
    const input = mode === 'files' ? fileInput : mode === 'names' ? nameInput : conversationInput
    input.current?.focus()
    setHistoryOpen(null)
    void useSearchHistory.getState().add(query, mode)
  }

  /** The focus / IME entry points common to the three boxes, and `aria-*` for screen readers. */
  const inputProps = (
    target: SearchTarget,
    draft: string
  ): Pick<
    React.InputHTMLAttributes<HTMLInputElement>,
    | 'onKeyDown'
    | 'onFocus'
    | 'onBlur'
    | 'onCompositionStart'
    | 'onCompositionEnd'
    | 'aria-controls'
    | 'aria-activedescendant'
  > => ({
    onKeyDown: (event) => onInputKeyDown(event, target, draft),
    onFocus: () => {
      if (focused !== target) setCursor(-1)
      setFocused(target)
      // TODO 900: if the field receives focus while empty, show recent search terms.
      void useSearchHistory.getState().load()
      if (draft.trim() === '') {
        setHistoryOpen(target)
        setHistoryCursor(-1)
      }
    },
    onBlur: () => {
      setFocused((at) => (at === target ? null : at))
      setHistoryOpen((at) => (at === target ? null : at))
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: () => {
      composing.current = false
    },
    'aria-controls': listId,
    'aria-activedescendant': focused === target && active >= 0 ? rowDomId(active) : undefined
  })

  // TODO 299: show the right-click menu only for fs hits (body search, file-name search).
  const onContextMenu = (event: React.MouseEvent, row: Row): void => {
    if (row.kind !== 'hit' && row.kind !== 'name') return
    if (row.hit.source !== 'fs') return
    const asDirectory = row.hit.kind === 'directory'
    openMenu(
      event,
      pathContextMenuItems(row.hit.uri, asDirectory, t, platform, {
        openInEditor,
        openInDefaultApp: openDefault,
        reveal: (uri, dir) => window.aios.editor.reveal(uri, dir),
        createThreadInFolder
      })
    )
  }

  return (
    <>
      {continuing !== null ? (
        <TranscriptContinueDialog uri={continuing} onClose={() => setContinuing(null)} />
      ) : null}
      <div className="sidebar-header search-header">
        {range !== null && <RangeBadge range={range} homeUri={homeUri} t={t} onClear={clearRange} />}
        <div className="search-input-wrap">
          <input
            ref={fileInput}
            className="search-input"
            type="search"
            {...ASCII_INPUT}
            placeholder={t('search.placeholder.files', { key: searchKeyLabel('files', KEY_PLATFORM) })}
            title={filesLocked ? t('search.locked') : t('search.title.files')}
            disabled={filesLocked}
            value={fileDraft}
            onChange={(event) => {
              setFileDraft(event.target.value)
              setHistoryOpen(null)
            }}
            {...inputProps('files', fileDraft)}
          />
          {historyOpen === 'files' && history.length > 0 ? (
            <SearchHistoryList
              items={history}
              cursor={historyCursor}
              onPick={pickHistory}
            />
          ) : null}
          <SearchCaseBadge shown={fileCaseSensitive && fileDraft.trim() !== ''} />
        </div>
        {fileMissingChars > 0 && (
          <div className="search-hint">{t('search.hint.missingChars', { n: fileMissingChars })}</div>
        )}
        <div className="search-input-wrap">
          <input
            ref={nameInput}
            className="search-input"
            type="search"
            {...ASCII_INPUT}
            placeholder={t('search.placeholder.names', { key: searchKeyLabel('names', KEY_PLATFORM) })}
            title={filesLocked ? t('search.locked') : t('search.title.names')}
            disabled={filesLocked}
            value={nameDraft}
            onChange={(event) => {
              setNameDraft(event.target.value)
              setHistoryOpen(null)
              clearContentSearches()
            }}
            {...inputProps('names', nameDraft)}
          />
          {historyOpen === 'names' && history.length > 0 ? (
            <SearchHistoryList
              items={history}
              cursor={historyCursor}
              onPick={pickHistory}
            />
          ) : null}
          <SearchCaseBadge shown={nameCaseSensitive && nameDraft.trim() !== ''} />
        </div>
        <div className="search-input-wrap">
          <input
            ref={conversationInput}
            className="search-input"
            type="search"
            {...ASCII_INPUT}
            placeholder={t('search.placeholder.conversation', { key: searchKeyLabel('conversation', KEY_PLATFORM) })}
            title={t('search.title.conversation')}
            value={conversationDraft}
            onChange={(event) => {
              setConversationDraft(event.target.value)
              setHistoryOpen(null)
            }}
            {...inputProps('conversation', conversationDraft)}
          />
          {historyOpen === 'conversation' && history.length > 0 ? (
            <SearchHistoryList
              items={history}
              cursor={historyCursor}
              onPick={pickHistory}
            />
          ) : null}
          <SearchCaseBadge
            shown={conversationCaseSensitive && conversationDraft.trim() !== ''}
          />
        </div>
        {conversationMissingChars > 0 && (
          <div className="search-hint">
            {t('search.hint.missingChars', { n: conversationMissingChars })}
          </div>
        )}
        {/* TODO 896: a plugin search section's field. It queries on Enter or 500 ms after typing stops (separate from the local boxes). */}
        {providers.map((provider) => {
          const target = pluginSearchTarget(provider.pluginId)
          return (
            <div className="search-input-wrap" key={provider.pluginId}>
              <input
                className="search-input"
                type="search"
                data-plugin-search={provider.pluginId}
                placeholder={provider.placeholder ?? t('search.plugin.placeholder', { title: provider.title })}
                title={t('search.plugin.title', { title: provider.title })}
                value={(pluginSearch[provider.pluginId] ?? IDLE_PROVIDER).draft}
                onChange={(event) => setPluginDraft(provider.pluginId, event.target.value)}
                onKeyDown={(event) => onPluginKeyDown(event, provider)}
                onFocus={() => {
                  if (focused !== target) setCursor(-1)
                  setFocused(target)
                  setHistoryOpen(null)
                }}
                onBlur={() => setFocused((at) => (at === target ? null : at))}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                aria-controls={listId}
                aria-activedescendant={focused === target && active >= 0 ? rowDomId(active) : undefined}
              />
            </div>
          )
        })}
      </div>

      {/* TODO 357: focus stays on the box, and the box's `aria-activedescendant` points at the row here. */}
      <div
        className="sidebar-list"
        ref={parentRef}
        id={listId}
        role="listbox"
        aria-label={t('sidebar.mode.search')}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            if (row === undefined) return null
            const option = row.kind === 'hit' || row.kind === 'name' || row.kind === 'plugin'
            const highlighted = option && virtualRow.index === active
            const measured = option
            return (
              <div
                key={row.id}
                id={rowDomId(virtualRow.index)}
                // TODO 870: hit and file-name rows are measured rather than given a fixed height (so the second row is not cut off when the contents grow
                // with enlarged text or Japanese line height). Headings etc. stay fixed.
                data-index={measured ? virtualRow.index : undefined}
                ref={measured ? virtualizer.measureElement : undefined}
                role={option ? 'option' : 'presentation'}
                aria-selected={option ? highlighted : undefined}
                className={`${
                  row.kind === 'header'
                    ? 'search-section'
                    : row.kind === 'region'
                      ? 'search-region'
                      : row.kind === 'note'
                        ? 'search-region-note'
                      : row.kind === 'name' || (row.kind === 'plugin' && row.result.snippet === undefined)
                      ? 'search-hit search-hit-name-only'
                      : 'search-hit'
                }${highlighted ? ' active' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: measured ? undefined : `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`
                }}
                // An fs file hit is a drop source for the prompt field and so on (TODO 288).
                draggable={
                  (row.kind === 'hit' || row.kind === 'name') && isDraggableHit(row.hit)
                }
                onDragStart={
                  (row.kind === 'hit' || row.kind === 'name') && isDraggableHit(row.hit)
                    ? (event) => startHitDrag(event, row.hit.uri)
                    : undefined
                }
                // 428-2 (the 26th proxy verification): pressing a row moved focus by the mousedown default to the ancestor `.sidebar-panel`
                // (`tabIndex={-1}`), so continued typing did not go into the search field. Only the mousedown default is stopped to
                // keep the search field's focus (click and draggable are not hindered in Chromium). jsdom does not move focus on click,
                // so the regression test looks at `defaultPrevented`.
                onMouseDown={
                  row.kind === 'header' || row.kind === 'region' || row.kind === 'note'
                    ? undefined
                    : (event) => event.preventDefault()
                }
                onClick={
                  row.kind === 'header' || row.kind === 'region' || row.kind === 'note'
                    ? undefined
                    : () => openRow(row, 'pointer')
                }
                onContextMenu={
                  (row.kind === 'hit' || row.kind === 'name') && row.hit.source === 'fs'
                    ? (event) => onContextMenu(event, row)
                    : undefined
                }
                title={
                  row.kind === 'header' || row.kind === 'note'
                    ? undefined
                    : row.kind === 'region'
                      ? (row.path ?? undefined)
                      : row.kind === 'plugin'
                        ? row.result.title
                        : hitTitle(row.hit, homeUri)
                }
              >
                {row.kind === 'header' ? (
                  <span className="search-section-label">{row.label}</span>
                ) : row.kind === 'note' ? (
                  <span className="search-region-note-text">{row.text}</span>
                ) : row.kind === 'region' ? (
                  <>
                    <span className="search-region-label">{row.label}</span>
                    {row.path !== null && <span className="search-region-path">{row.path}</span>}
                    <span className="search-region-count">
                      {t('search.region.count', { count: row.count })}
                    </span>
                  </>
                ) : row.kind === 'plugin' ? (
                  <>
                    {/* TODO 896: a plugin section's result. The title, supplement and excerpt are plain text (main dropped control characters and trimmed the length). */}
                    <div className="search-hit-title">
                      <span className="search-hit-name">{row.result.title}</span>
                      {row.result.description === undefined ? null : (
                        <span className="search-hit-source">{row.result.description}</span>
                      )}
                    </div>
                    {row.result.snippet === undefined ? null : (
                      <div className="search-hit-snippet">{row.result.snippet}</div>
                    )}
                  </>
                ) : row.kind === 'name' ? (
                  <>
                    <div className="search-hit-title">
                      {/* TODO 404: the same kind of icon as the Files tree (Seti, colored).
  TODO 585: `.app` has the same OS icon as the Files tree (562, the cache is shared). */}
                      {isAppBundle({ name: row.hit.title, isDirectory: row.hit.kind === 'directory' }) ? (
                        <AppBundleIcon uri={row.hit.uri} name={row.hit.title} mtimeMs={row.hit.updatedAt} />
                      ) : (
                        <FileIcon name={row.hit.title} isDirectory={row.hit.kind === 'directory'} />
                      )}
                      <span className="search-hit-name">{row.hit.title}</span>
                      <span className="search-hit-actions">
                        {/* TODO 820: a folder row shows "new thread in this folder" on hover (no dialog). */}
                        {row.hit.source === 'fs' && row.hit.kind === 'directory' ? (
                          <NewChatButton
                            uri={row.hit.uri}
                            className="search-hit-new-chat"
                            label={t('threads.newInFolder', { name: row.hit.title })}
                          />
                        ) : null}
                        <OpenInEditorButton
                          uri={row.hit.uri}
                          asDirectory={row.hit.kind === 'directory'}
                          t={t}
                          // A folder goes to the editor as before (the way of passing is also unchanged); a file is dispatched by extension.
                          open={row.hit.kind === 'directory' ? openInEditor : openFile}
                        />
                        <PathActions uri={row.hit.uri} asDirectory={row.hit.kind === 'directory'} />
                      </span>
                    </div>
                    {/* An fs hit shows the full name (a relative path with the home folded) in the second row (item 55). */}
                    <div className="search-hit-path">{displayPath(row.hit.uri, homeUri)}</div>
                  </>
                ) : row.hit.source === 'fs' && isImageHit(row.hit) ? (
                  // TODO 998: an image hit puts a thumbnail on the left (to recognize an image matched by its contents). The excerpt is the matched label's term.
                  <div className="search-hit-image">
                    <HitThumbnail hit={row.hit} />
                    <div className="search-hit-image-text">
                      <div className="search-hit-title">
                        <span className="search-hit-name">{row.hit.title}</span>
                        <span className="search-hit-actions">
                          <OpenInEditorButton uri={row.hit.uri} asDirectory={false} t={t} open={openFile} />
                          <PathActions uri={row.hit.uri} />
                        </span>
                      </div>
                      <div className="search-hit-path">{displayPath(row.hit.uri, homeUri)}</div>
                      <div className="search-hit-snippet">{row.hit.snippet}</div>
                    </div>
                  </div>
                ) : row.hit.source === 'fs' ? (
                  <>
                    <div className="search-hit-title">
                      <FileIcon name={row.hit.title} isDirectory={false} />
                      <span className="search-hit-name">{row.hit.title}</span>
                      <span className="search-hit-actions">
                        <OpenInEditorButton uri={row.hit.uri} asDirectory={false} t={t} open={openFile} />
                        <PathActions uri={row.hit.uri} />
                      </span>
                    </div>
                    <div className="search-hit-path">{displayPath(row.hit.uri, homeUri)}</div>
                    <div className="search-hit-snippet">{row.hit.snippet}</div>
                  </>
                ) : (
                  <>
                    <div className="search-hit-title">
                      {/* The title of a conversation hit is the thread name. A provisional title arrives as an empty string (TODO 66). */}
                      <span className="search-hit-name">
                        {row.hit.source === 'conversation'
                          ? threadTitleLabel(t, row.hit.title)
                          : row.hit.title}
                      </span>
                      {/* A conversation hit has no path. The thread name is added (as the context).
  For the fixed labels (you / answer / tool / transcript), the code (`contextCode`) is turned into text
  with the dictionary; main does not know the language (TODO 66). */}
                      <span className="search-hit-source">{contextLabel(t, row.hit)}</span>
                      {row.hit.source === 'transcript' ? (
                        <button
                          type="button"
                          className="link-button search-hit-continue"
                          onClick={(event) => {
                            event.stopPropagation()
                            setContinuing(row.hit.uri)
                          }}
                        >
                          {t('search.continueTranscript')}
                        </button>
                      ) : null}
                    </div>
                    <div className="search-hit-snippet">{conversationSnippet(t, row.hit)}</div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </>
  )
}

/** Whether an fs hit of body search is an image (TODO 998, judged by extension. An image matched by its contents is shown as a thumbnail). */
export function isImageHit(hit: Pick<SearchHit, 'source' | 'kind' | 'title'>): boolean {
  if (hit.source !== 'fs' || hit.kind === 'directory') return false
  const dot = hit.title.lastIndexOf('.')
  return dot > 0 && recentKindOf(hit.title.slice(dot + 1)) === 'image'
}

/** A thumbnail for an image hit (TODO 998). The same entry point as "Recent files" (main makes it with QuickLook and keeps it in memory). */
function HitThumbnail({ hit }: { readonly hit: SearchHit }): React.JSX.Element {
  const dot = hit.title.lastIndexOf('.')
  const thumbnail = useThumbnail({ uri: hit.uri, ext: hit.title.slice(dot + 1), mtimeMs: hit.updatedAt })
  return (
    <span className="search-hit-thumb" aria-hidden="true">
      {thumbnail !== null ? (
        <img src={thumbnail} alt="" draggable={false} />
      ) : (
        <FileIcon name={hit.title} isDirectory={false} />
      )}
    </span>
  )
}

/**
 * The range badge (TODO 437). "Range: `~/src/app/` x" and the number of waiting-for-body entries left after the build (never leaked silently).
 * The x returns to everywhere (and the cwd section, item 100).
 */
function RangeBadge({
  range,
  homeUri,
  t,
  onClear
}: {
  readonly range: SearchRange
  readonly homeUri: string
  readonly t: Translate
  readonly onClear: () => void
}): React.JSX.Element {
  const path = folderLabel(range.uri, homeUri)
  const pending = range.pending
  return (
    <div className="search-range">
      <span className="search-range-label">{t('search.range.label')}</span>
      <code className="search-range-path" title={path}>
        {path}
      </code>
      <Tooltip content={t('search.range.clear')}>
        <button
          type="button"
          className="icon-button search-range-clear"
          aria-label={t('search.range.clear')}
          onClick={onClear}
        >
          <CloseIcon />
        </button>
      </Tooltip>
      {range.building ? (
        <span className="search-range-note">{t('search.range.building')}</span>
      ) : pending !== null && pending.pending > 0 ? (
        <span className="search-range-note">
          {t(pending.pendingCapped ? 'search.range.pendingMore' : 'search.range.pending', {
            count: pending.pending.toLocaleString()
          })}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The button that opens an fs hit in the external editor (item 115). It calls `stopPropagation` so it is not
 * caught up in the click on the whole row (open). TODO 1214: dispatched by extension (`.xlsx` / `.pdf` ... go to the OS default app,
 * folders and text files go to the chosen editor), and the wording also matches the destination.
 */
function OpenInEditorButton({
  uri,
  asDirectory,
  t,
  open
}: {
  readonly uri: string
  readonly asDirectory: boolean
  readonly t: Translate
  readonly open: (uri: string) => Promise<boolean>
}): React.JSX.Element {
  const label = t(openButtonLabelKey(uri, { asDirectory }, 'search.openInEditor'))
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="icon-button"
        onClick={(event) => {
          event.stopPropagation()
          void open(uri)
        }}
        aria-label={label}
      >
        <OpenExternalIcon />
      </button>
    </Tooltip>
  )
}

/**
 * The path shown in the "this working folder" heading (item 100). The home is folded to `~`, and a trailing `/` is added
 * so it is clear that it is a folder (`~/src/app/`).
 */
export function folderLabel(uri: string, homeUri: string): string {
  const path = displayPath(uri, homeUri)
  return path.endsWith('/') ? path : `${path}/`
}

/**
 * The `title` attribute (the full text on hover, item 55). An fs hit shows the full name, and
 * a conversation hit shows the thread name (`context`) as before.
 */
function hitTitle(hit: SearchHit, homeUri: string): string {
  return hit.source === 'fs' ? displayPath(hit.uri, homeUri) : hit.context
}

/**
 * Supplementary display of a conversation / transcript hit (the "thread name" row of item 55). If `contextCode` is a code for
 * a fixed label (you / answer / tool / transcript), it is turned into text with the dictionary; otherwise
 * (e.g. from a plugin) `context` is shown as it is (TODO 66).
 */
function contextLabel(t: Translate, hit: SearchHit): string {
  if (hit.contextCode === null) return hit.context
  return t(`search.role.${hit.contextCode}`)
}
