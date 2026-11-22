/**
 * Sidebar (ARCHITECTURE.md chapter 5).
 *
 * The left edge is a **single vertical icon bar** like VS Code's Activity Bar (5.3, T14). From the top it has the mode switches
 * "threads / files / search / scheduled runs (TODO 372) / extensions (TODO 367)", and "settings" set apart at the bottom. To its right is
 * the contents of each mode (320px). The approval display **was moved to the end of ThreadPane** (5.4, T13), so
 * all that remains here is "N awaiting approval" on a thread row.
 * The mode state (`mode`) stays in threadStore; only the placement changed.
 * **Collapsing (width 0) is also here** (5.5.1, T27): if `sidebarCollapsed` is true,
 * `.sidebar-panel` is not drawn and only the icon bar is left.
 * File mode can have hundreds of thousands of entries under the home, so a **virtual list is required** (chapter 3).
 * Search is by file name only (body search is Phase 3).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import type { FileEntry } from '@shared/types.js'
import { useStore, selectRows, type TreeRow } from '../store.js'
import { useThreads } from '../threadStore.js'
import { workingCwdUri } from '@shared/thread.js'
import { useEditor } from '../editorStore.js'
import { ThreadList } from './ThreadList.js'
import { NewChatButton } from './NewChatButton.js'
import { NewThreadDialog } from './NewThreadDialog.js'
import { PathActions } from './PathActions.js'
import { Tooltip } from './Tooltip.js'
import { ContextMenu, useContextMenuState } from './ContextMenu.js'
import {
  hasSourceControlExtension,
  newEntryMenuItems,
  pathContextMenuItems,
  renameMenuItem,
  searchInFolderMenuItem,
  sourceControlMenuItem
} from '../path-context-menu.js'
import { openSearchInFolder } from '../shortcut-actions.js'
import { SearchInFolderIcon } from '../icons/SearchInFolderIcon.js'
import { startLogin } from './AuthExpiredBar.js'
import { beginFilesDrag, endFilesDrag } from '../files-drag.js'
import {
  anchorUri,
  findTreeIndex,
  fromViewIndex,
  insideReadOnlyRoot,
  newChatFolderName,
  newChatTarget,
  newEntryParent,
  newEntryProblem,
  renameProblem,
  replaceUriPrefix,
  planFolderReveal,
  readOnlyRootUris,
  unindexedRootUris,
  rowInView,
  shortcutLabelKey,
  toViewIndex,
  treeKeyAction
} from '../file-tree.js'
import { InlineNameInput, type InlineNameCancel } from './InlineNameInput.js'
import { NewFileIcon } from '../icons/NewFileIcon.js'
import { NewFolderIcon } from '../icons/NewFolderIcon.js'
import type { NewEntryKind } from '@shared/new-entry.js'
import { formatReason, isReasonCode, type ReasonParams } from '@shared/reason.js'
import { listKeyStep, navKey } from '../list-keys.js'
import { SearchMode } from './SearchMode.js'
import { HiddenFilesToggle } from './HiddenFilesToggle.js'
import { FilerNavButtons } from './FilerNavButtons.js'
import { pickFilerRow, renameFilerRows, useFilerSelection } from '../filerHistory.js'
import { SearchCaseBadge } from './SearchCaseBadge.js'
import { openSettingsEditor, useSettingsEditor } from '../settingsEditorStore.js'
import { useSearch } from '../searchStore.js'
import type { SidebarMode } from '../threadStore.js'
import { ThreadsIcon } from '../icons/ThreadsIcon.js'
import { FilesIcon } from '../icons/FilesIcon.js'
import { SearchIcon } from '../icons/SearchIcon.js'
import { ExtensionsIcon } from '../icons/ExtensionsIcon.js'
import { ExtensionsMode } from './ExtensionsMode.js'
import { PluginViewMode } from './PluginViewMode.js'
import { initPluginSurfaces, usePluginSurfaces } from '../pluginView.js'
import { SettingsIcon } from '../icons/SettingsIcon.js'
import { HelpIcon } from '../icons/HelpIcon.js'
import { toggleHelp } from '../help.js'
import { ScheduleIcon } from '../icons/ScheduleIcon.js'
import { ScheduleList } from './ScheduleList.js'
import { ComposeIcon } from '../icons/ComposeIcon.js'
import { initSchedule, scheduleDot, useSchedule } from '../scheduleStore.js'
import { initTriggers } from '../triggerStore.js'
import { initRoles } from '../roleStore.js'
import { describeReason, useT, type MessageKey, type Translate } from '../i18n/index.js'
import { anyThreadRunning, maxAttention } from '../thread-sort.js'
import { keyPlatformOf } from '../composer-keys.js'
import { modeKeyLabel, newThreadKeyLabel } from '../shortcuts.js'
import { FileIcon } from '../icons/file-icons/FileIcon.js'
import { AppBundleIcon } from '../icons/file-icons/AppBundleIcon.js'
import { specialFolderFor } from '../file-icons.js'
import { isAppBundle } from '@shared/app-bundle.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { WebIcon } from '../icons/WebIcon.js'
import { WebMode } from './WebMode.js'
import { initWeb, openSavedWebUrl } from '../webStore.js'
import { PluginIcon } from './PluginIcon.js'
import { activityBarPlugins, usePluginList } from '../extensions.js'

const ROW_HEIGHT = 24
const SEARCH_DEBOUNCE_MS = 150
/**
 * The wait before opening in the viewer when the user moves in the tree with Up/Down (TODO 356). When a key is held, only the last row is opened.
 * Longer than the key auto-repeat (about 80 ms by default on macOS), and short enough that a single press does not feel like a wait.
 */
export const TREE_OPEN_DEBOUNCE_MS = 120
/** Do not make a new array every time, even outside a selector (the React error #185 case). */
const NO_ENTRIES: readonly FileEntry[] = []
/** The key style attached to an icon's title (item 195). */
const KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)
/**
 * The last `revealTick` that FileMode handled (item 264). **It lives in the module** because when the sidebar is in a mode other than "Files",
 * FileMode is detached, and when the user returns it must not scroll again on the same signal (progress made in the background
 * is applied just once).
 */
let handledRevealTick = 0

/**
 * The expand / collapse mark (right / down triangle). Empty for files (in TODO 404 the kind icon doubles as the mark at the start of the row, so the old `·` was dropped.
 * The mark column (`.row-icon`, 10px) is kept so the indent position does not change; the same as the twistie of VS Code's tree).
 */
function icon(entry: FileEntry, expanded: boolean): string {
  // A `.app` (TODO 562) is not opened, so no triangle is shown (like Finder, it is shown as a single app).
  if (isAppBundle(entry)) return ''
  if (entry.isDirectory) return expanded ? '▾' : '▸'
  return ''
}

/**
 * The wording of main's `CreateEntryResult` refusal (TODO 370). A reason code goes through the dictionary; anything else (a raw exception message) is shown as it is.
 */
function describeCreateRefusal(t: Translate, reason: string | null, params: ReasonParams | undefined): string {
  if (reason !== null && isReasonCode(reason)) return describeReason(t, formatReason(reason, params))
  return reason ?? t('reason.create-failed', { code: '?' })
}

/** The order of the icon bar (from the top). To add one, add a line here. */
const MODES: readonly { mode: SidebarMode; label: MessageKey; Icon: () => React.JSX.Element }[] = [
  { mode: 'threads', label: 'sidebar.mode.threads', Icon: ThreadsIcon },
  { mode: 'files', label: 'sidebar.mode.files', Icon: FilesIcon },
  { mode: 'search', label: 'sidebar.mode.search', Icon: SearchIcon },
  // TODO 372 (wave 20 bundle B): scheduled runs. No key is assigned (VS Code has no corresponding view, and instead of
  // looking for a free key and adding an original one, only a tooltip is used).
  { mode: 'schedule', label: 'sidebar.mode.schedule', Icon: ScheduleIcon },
  // Extensions (TODO 367, Cmd+Shift+X). The order is threads, files, search, (scheduled runs), extensions.
  { mode: 'extensions', label: 'sidebar.mode.extensions', Icon: ExtensionsIcon },
  // TODO 522 (wave 26 bundle A): Web (history / Favorites / open tabs). No key is assigned (same as scheduled runs).
  { mode: 'web', label: 'sidebar.mode.web', Icon: WebIcon }
]

export function Sidebar(): React.JSX.Element {
  const t = useT()
  const mode = useThreads((state) => state.mode)
  const setMode = useThreads((state) => state.setMode)
  // Whether it is collapsed (5.5.1, T27). The icon bar stays, so only the panel is removed here.
  const collapsed = useThreads((state) => state.sidebarCollapsed)
  // At the moment "Files" is pressed, open the cwd of the thread now shown in ThreadPane in the tree
  // (item 49). It does not follow continuously: the value at the time of the press is used just once.
  const activeThreadId = useThreads((state) => state.activeThreadId)
  // TODO 633: a conversation that moved to a worktree opens that worktree.
  const cwdUri = useThreads((state) => {
    const thread = activeThreadId === null ? undefined : state.threadsById[activeThreadId]?.thread
    return thread === undefined ? null : workingCwdUri(thread)
  })
  // Item 151 part 3: when the list is not visible (another mode, or collapsed), put a dot on "Threads".
  // It is a selector that returns a count (0 / 1 / 2), so a re-render on `turn_usage` happens only when the value changes.
  const threadsAttention = useThreads((state) => maxAttention(state.threadOrder, state.threadsById))
  // TODO 528: while any one thread is responding, the Threads icon blinks slowly. It is shown regardless of the mode
  // (it is most useful when looking at Files / Search), so the `hidden`-like check above is not mixed in.
  const threadsRunning = useThreads((state) => anyThreadRunning(state.threadOrder, state.threadsById))
  // TODO 372: failures and skipped runs of scheduled runs (those since the list was last viewed) also become a dot by the same mechanism.
  const scheduleAttention = useSchedule((state) => scheduleDot(state.overview, state.seenAt))
  const reveal = useStore((state) => state.reveal)
  const initSearch = useSearch((state) => state.init)
  // Opening and closing the settings editor (Settings.tsx, item 187). It opens in ThreadPane's place. The gear is a toggle.
  const settingsOpen = useSettingsEditor((state) => state.open)
  // TODO 1174: whether Help is shown in front of the ViewerPane (closed by pressing the Activity Bar's ? again). Returns only a boolean.
  const helpOpen = useStore((state) => state.transient?.kind === 'help')
  const toggleSettings = useSettingsEditor((state) => state.toggle)
  // Creation dialog (TODO 408): moved to the button at the top of the Activity Bar (the old button in the ThreadList heading).
  // The entry and the display are both placed here so it can be opened regardless of mode (`NewThreadDialog` is a full-screen
  // overlay of `settings-backdrop`, so it looks the same wherever it is drawn).
  const [creatingThread, setCreatingThread] = useState(false)
  // TODO 523: the Activity Bar icons that plugins declared (currently only aios.gmail). Only enabled plugins.
  const pluginList = usePluginList()
  const pluginActivityItems = useMemo(() => activityBarPlugins(pluginList ?? []), [pluginList])

  useEffect(() => {
    void initSearch()
  }, [initSearch])

  // TODO 1039 / 1038: subscription to the plugin surfaces (list, sync badge). One per window.
  useEffect(() => {
    initPluginSurfaces()
  }, [])
  const selectedPluginView = usePluginSurfaces((state) => state.selectedPluginId)
  const selectPluginView = usePluginSurfaces((state) => state.select)

  // Subscription to the scheduled-run list (one per window). It keeps receiving even while the list is not visible, for the dot (TODO 372).
  useEffect(() => {
    initSchedule()
    // TODO 1216: the trigger list is likewise one per window.
    initTriggers()
    // TODO 972: the role (Teammate) list too (the thread list's role headings and the Teammates section look at it).
    initRoles()
  }, [])

  // Web tabs (TODO 522). At startup this window takes over its tabs (from a window closed earlier / what was remembered at the last exit).
  useEffect(() => {
    initWeb()
  }, [])

  // Cmd+, / Ctrl+, (the menu accelerator, item 195) opens settings. The same entry as the gear that opens it.
  // Cmd+Shift+O (TODO 408) opens the creation dialog. The same entry as the button at the top of the Activity Bar.
  useEffect(
    () =>
      window.aios.app.onMenuCommand((command) => {
        if (command === 'openSettings') openSettingsEditor()
        else if (command === 'newThread') setCreatingThread(true)
      }),
    []
  )

  return (
    <div className="sidebar">
      <nav className="activity-bar" aria-label={t('sidebar.modes')}>
        {/*
  TODO 408: "New thread" is at the top, and it is an "action" with a different role from switching modes, so
  it is not given the selected-state look (current / active) and is separated with `activity-separator`.
  The Activity Bar stays even when the sidebar is collapsed, so a thread can always be created from here.
  */}
        <Tooltip
          content={t('sidebar.mode.withKey', { label: t('threads.new'), key: newThreadKeyLabel(KEY_PLATFORM) })}
          placement="right"
        >
          <button
            type="button"
            className="activity-item activity-action"
            aria-label={t('threads.new')}
            onClick={() => setCreatingThread(true)}
          >
            <ComposeIcon />
          </button>
        </Tooltip>
        <div className="activity-separator" role="separator" />
        {MODES.map(({ mode: m, label: labelKey, Icon }) => {
          const current = mode === m
          // The dot is only when "the list is not visible" (when it is visible, the circle on the row is enough). Awaiting approval uses the warning color.
          const hidden = !current || collapsed
          const dot =
            m === 'threads' && threadsAttention > 0 && hidden
              ? threadsAttention === 2
                ? 'attention'
                : 'unread'
              : m === 'schedule' && hidden
                ? scheduleAttention
                : null
          const base = t(labelKey)
          const label =
            dot === null
              ? base
              : m === 'schedule'
                ? t(dot === 'attention' ? 'sidebar.mode.scheduleFailed' : 'sidebar.mode.scheduleSkipped', {
                    label: base
                  })
                : t(dot === 'attention' ? 'sidebar.mode.threadsAttention' : 'sidebar.mode.threadsUnread', {
                    label: base
                  })
          // The tooltip gets the key ("Files (Shift+Cmd+E)", the same as VS Code's tooltip, item 195).
          // Scheduled runs have no key, so only the name (TODO 372).
          const keyed =
            m === 'schedule' || m === 'web' || m === 'plugin'
              ? label
              : t('sidebar.mode.withKey', { label, key: modeKeyLabel(m, KEY_PLATFORM) })
          // Item 320: an icon-only button uses the common tooltip (Tooltip) instead of the OS title.
          const tipText = current
            ? t(collapsed ? 'sidebar.mode.clickToOpen' : 'sidebar.mode.clickToCollapse', {
                label: keyed
              })
            : keyed
          return (
            <Tooltip key={m} content={tipText} placement="right">
              <button
                type="button"
                /*
                 * While collapsed, the accent strip at the left edge (`.active`) is not shown. **If it stayed,
                 * it could be read as "that mode is displayed"**, so it drops to `.current`, which only strengthens the color,
                 * to mean "selected, but closed right now".
                 */
                className={`activity-item${current ? (collapsed ? ' current' : ' active') : ''}${
                  m === 'threads' && threadsRunning ? ' threads-pulsing' : ''
                }`}
                aria-pressed={current}
                aria-expanded={current ? !collapsed : undefined}
                aria-label={label}
                onClick={() => {
                  setMode(m)
                  if (m === 'files' && cwdUri !== null) void reveal(cwdUri)
                }}
              >
                <Icon />
                {dot === null ? null : <span className={`activity-dot ${dot}`} aria-hidden="true" />}
              </button>
            </Tooltip>
          )
        })}
        {/*
  TODO 523: a plugin's Activity Bar icon. Not a mode but an "action" (the same category as new thread):
  pressing it only opens that URL in the Web view and has no dedicated panel. A separator is inserted only when there is one or more.
  */}
        {pluginActivityItems.length === 0 ? null : (
          <>
            <div className="activity-separator" role="separator" />
            {pluginActivityItems.map((item) => (
              <Tooltip key={item.id} content={item.title} placement="right">
                <button
                  type="button"
                  className={`activity-item activity-action${item.sidebarView && mode === 'plugin' && selectedPluginView === item.id ? ' active' : ''}`}
                  aria-label={item.title}
                  onClick={() => {
                    // TODO 1039: a plugin that has its own list shows it in the sidebar (the URL is not opened).
                    if (item.sidebarView) {
                      selectPluginView(item.id)
                      setMode('plugin')
                    } else if (item.openWith === 'external') {
                      // TODO 721: 'external' is the default browser (it does not go to persist:aios-web).
                      // An escape hatch for sites that refuse a login from an embedded browser (Google etc.).
                      void window.aios.app.openExternal(item.openUrl)
                    } else openSavedWebUrl(item.openUrl, false)
                  }}
                >
                  <PluginIcon url={item.iconUrl} size={24} />
                </button>
              </Tooltip>
            ))}
          </>
        )}
        <div className="activity-spacer" />
        {/*
  TODO 1174: Help (above the settings gear). Pressing it shows Help as a temporary view in the ViewerPane, and pressing again while shown closes it
  (the same press-again form as the gear). It has no key (VS Code's Help has no default key either).
  */}
        <Tooltip content={helpOpen ? t('help.close') : t('help.title')} placement="right">
          <button
            type="button"
            className={`activity-item${helpOpen ? ' active' : ''}`}
            aria-pressed={helpOpen}
            aria-label={t('help.title')}
            onClick={toggleHelp}
          >
            <HelpIcon />
          </button>
        </Tooltip>
        <Tooltip
          content={t('sidebar.mode.withKey', {
            label: t('settings.title'),
            key: modeKeyLabel('settings', KEY_PLATFORM)
          })}
          placement="right"
        >
          <button
            type="button"
            className={`activity-item${settingsOpen ? ' active' : ''}`}
            aria-pressed={settingsOpen}
            aria-label={t('settings.title')}
            onClick={toggleSettings}
          >
            <SettingsIcon />
          </button>
        </Tooltip>
      </nav>
      {/* TODO 408: placed outside the panel so it can be created from the Activity Bar even when the sidebar is collapsed. */}
      {creatingThread ? <NewThreadDialog onClose={() => setCreatingThread(false)} /> : null}
      {/*
  While collapsed, the panel is removed from the DOM. If it were left with `width: 0`, the virtual list inside
  would keep measuring a parent of height 0, and the status bar's buttons could be reached by Tab while invisible.
  */}
      {collapsed ? null : (
        // tabIndex -1: a container that receives focus from the thread key (Ctrl+Cmd+I, item 195). Tab does not stop on it.
        <div className="sidebar-panel" tabIndex={-1}>
          {mode === 'threads' ? (
            <ThreadList />
          ) : mode === 'search' ? (
            <SearchMode />
          ) : mode === 'extensions' ? (
            <ExtensionsMode />
          ) : mode === 'schedule' ? (
            <ScheduleList />
          ) : mode === 'web' ? (
            <WebMode />
          ) : mode === 'plugin' ? (
            <PluginViewMode />
          ) : (
            <FileMode sourceControl={hasSourceControlExtension(pluginList)} />
          )}
          <StatusBar />
        </div>
      )}
    </div>
  )
}

/** The Files tree (and its filter). It is exported for the test (`test/file-tree-keys.test.ts`). */
export function FileMode({
  sourceControl = false
}: {
  /** TODO 834: offer "Open in Source Control" on folder rows (an enabled extension declares the git capability; decided by Sidebar from its plugin list). */
  readonly sourceControl?: boolean
} = {}): React.JSX.Element {
  const t = useT()
  // Stop using `useStore()` with no arguments (item 88). During a scan, `scan` arrives with every batch, so
  // subscribing to the whole store ran the tree flattening (`selectRows`) every time. Take only the 4 the tree needs
  // with `useShallow`, and re-flatten only when one of them changes.
  const tree = useStore(
    useShallow((state) => ({
      roots: state.roots,
      children: state.children,
      expanded: state.expanded,
      showAll: state.showAll,
      loading: state.loading
    }))
  )
  const rows = useMemo(() => selectRows(tree), [tree])
  // The roots of view-only shortcuts (TODO 520, trash). Rows inside them show no create / search / new chat / drag.
  const readOnlyRoots = useMemo(() => readOnlyRootUris(tree.roots), [tree.roots])
  // Shortcuts that do not go into the index (trash / `/tmp`, TODO 561). Rows inside them do not show "search inside this folder".
  const unindexedRoots = useMemo(() => unindexedRootUris(tree.roots), [tree.roots])
  const results = useStore((state) => state.results)
  const selectedUri = useStore((state) => state.selectedUri)
  // TODO 958: used to decide the dedicated icons for special folders directly under the home (Downloads etc.).
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const revealedUri = useStore((state) => state.revealedUri)
  // TODO 1257: the row Files highlights (picked in Files, per conversation). The viewer's file only gets a quiet mark.
  const filerSelected = useFilerSelection()
  const revealTick = useStore((state) => state.revealTick)
  const revealTarget = useStore((state) => state.revealTarget)
  const reveal = useStore((state) => state.reveal)
  const setQuery = useStore((state) => state.setQuery)
  const clearReveal = useStore((state) => state.clearReveal)
  const toggle = useStore((state) => state.toggle)
  const select = useStore((state) => state.select)
  const platform = useStore((state) => state.appInfo?.platform)
  const createThreadInFolder = useThreads((state) => state.createThreadInFolder)
  const openInEditor = useEditor((state) => state.open)
  // TODO 1214: the right-click "open with the default app" (only on rows of files whose extension is in the table).
  const openDefault = useEditor((state) => state.openDefault)
  // TODO 299: the right-click menu on a tree row.
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()
  const [draftQuery, setDraftQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  // The tree's key position (TODO 356). If null, it starts from the selected file (or, if none, the reveal row).
  // The value is a row key (`TreeRow.key`, TODO 520: a shortcut shows up twice with the same URI) or a URI.
  const [treeCursor, setTreeCursor] = useState<string | null>(null)
  // The in-place input field for "new file / folder" (TODO 370). One row is inserted right after the parent folder's row.
  const [creating, setCreating] = useState<{ readonly parentUri: string; readonly kind: NewEntryKind } | null>(
    null
  )
  // Rename (TODO 1145): the inside of the row becomes the in-place input field. `key` is the row's key (a shortcut shows up twice with the same URI).
  const [renaming, setRenaming] = useState<{ readonly key: string; readonly entry: FileEntry } | null>(null)
  // The wait before opening in the viewer a row reached with Up/Down (TODO 356). When a key is held, only the last row is opened.
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The row id (the target of `aria-activedescendant`). Even if there is only one per window, keep it unique.
  const listId = useId()
  const rowId = (index: number): string => `${listId}-row-${index}`
  // Whether IME composition is in progress. A gate so that **the Enter that confirms a composition does not open a file**
  // (a required item carried over from qlm's screen spec).
  const composing = useRef(false)
  const parentRef = useRef<HTMLDivElement | null>(null)
  // `reveal` (item 49) scrolls to the row it opened. After the ancestors finish expanding, the row appears in
  // `rows` one render later, so "not scrolled yet" is carried over in a ref.
  const pendingReveal = useRef<{ readonly uri: string; readonly always: boolean } | null>(null)

  // Do not hit the DB on every input. One query is a scan of 1 million entries, so batch for 150 ms
  // (the scan itself can be abandoned midway, 6.6).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draftQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQuery])

  const searching = results !== null
  const items: readonly (TreeRow | FileEntry)[] = searching
    ? (results?.entries ?? NO_ENTRIES)
    : rows

  useEffect(() => {
    setCursor(0)
  }, [results])

  /**
   * The position in the virtual list where the input field (TODO 370) is inserted = right after the parent folder's row. null while filtering or when the parent is not shown.
   * The key position (`treeIndex`) and the `rows` indexes stay as tree rows, and are converted with `toViewIndex` only when passed to the virtual list.
   */
  const inputAt = useMemo(() => {
    if (creating === null || searching) return null
    const parent = rows.findIndex((row) => row.entry.uri === creating.parentUri)
    return parent < 0 ? null : parent + 1
  }, [creating, searching, rows])

  const virtualizer = useVirtualizer({
    count: items.length + (inputAt === null ? 0 : 1),
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  useEffect(() => {
    if (revealTick === handledRevealTick) return
    handledRevealTick = revealTick
    if (revealTarget === null) return
    pendingReveal.current = revealTarget
    // "Open the working folder in the tree" (item 49) is released while filtering, because the tree is not shown
    // (via the debounce `store.query` also becomes empty). The auto reveal that follows the viewer (item 264) does not
    // break a search: it is applied when leaving the search (the effect below). Files back / forward (TODO 1257) also clears it.
    if (revealTarget.always || revealTarget.clearFilter === true) setDraftQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick])

  useEffect(() => {
    const target = pendingReveal.current
    if (target === null || searching) return
    const index = rows.findIndex((row) => row.entry.uri === target.uri)
    if (index < 0) return
    pendingReveal.current = null
    // A row that is already visible is not moved (the tree does not jump when a row is pressed to open it, item 264).
    const el = parentRef.current
    if (!target.always && el !== null && rowInView(index, ROW_HEIGHT, el.scrollTop, el.clientHeight)) return
    // TODO 887: when Files is selected (the folder row aligned with `always`), if the open file fits on the same screen,
    // put the folder row at the top. If it does not fit, put the file's row at the center.
    let plan: { readonly index: number; readonly align: 'start' | 'center' } = { index, align: 'center' }
    const opened = useStore.getState().selectedUri
    if (target.always && el !== null && opened !== null && opened.startsWith(`${target.uri}/`)) {
      plan = planFolderReveal(index, findTreeIndex(rows, opened), ROW_HEIGHT, el.clientHeight)
    }
    virtualizer.scrollToIndex(toViewIndex(plan.index, inputAt), { align: plan.align })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, searching, revealTick])

  // When leaving the search list, realign the tree to the selected file (item 264). While searching it is not aligned
  // (the store's `select` skips it), so it is taken back here once, when leaving.
  // TODO 1257: the Files selection first (it is the tree's own position), else the viewer's file.
  const wasSearching = useRef(false)
  useEffect(() => {
    if (wasSearching.current && !searching) {
      if (filerSelected !== null) void reveal(filerSelected, { row: true })
      else if (selectedUri !== null) void reveal(selectedUri, { auto: true })
    }
    wasSearching.current = searching
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching])

  const cancelPendingOpen = (): void => {
    if (pendingOpen.current === null) return
    clearTimeout(pendingOpen.current)
    pendingOpen.current = null
  }
  useEffect(() => cancelPendingOpen, [])

  // When the selection (the viewer's file) or reveal changes from outside, return the key position there too (VS Code's
  // explorer also moves the focus row to the open file by autoReveal). Opening with Up/Down passes through here too, but
  // the destination is the same row, so nothing changes visibly. **Do not return it when it becomes null**: moving by key
  // makes `clearReveal` clear `revealedUri`, so returning then would bounce the position back to the selected file.
  // The auto reveal's `revealTick` is also not watched (it advances late after the ancestors' listing is fetched, and would put back a position moved in the meantime).
  useEffect(() => {
    // TODO 520: when the file opened with Up/Down appears under both a shortcut and `~/`, stay on the row we are on now
    // (returning to null would jump to the row that shows first = the shortcut side).
    if (selectedUri !== null) {
      setTreeCursor((prev) => (prev !== null && anchorUri(prev) === selectedUri ? prev : null))
    }
  }, [selectedUri])
  useEffect(() => {
    if (revealedUri !== null) setTreeCursor(null)
  }, [revealedUri, revealTick])
  // TODO 1257: the Files selection changed (a pick, back / forward, another conversation): the key position follows
  // it, unless it is already on that row (keeps the shortcut copy of a row, TODO 520).
  useEffect(() => {
    if (filerSelected !== null) {
      setTreeCursor((prev) => (prev !== null && anchorUri(prev) === filerSelected ? prev : null))
    }
  }, [filerSelected])

  /**
   * The key position of the tree. In the order `treeCursor` -> the selected file (the one open in the viewer) -> the reveal row,
   * whichever is shown in the tree.
   *
   * **In the small observation on 356 (365, wave 20 bundle C), the selected file was put before the reveal row.** Previously
   * the reveal row came first (`revealedUri` is set only when "reveal came after the last select" = it is new), but
   * it is set when "Files" is pressed or on Cmd+Shift+E (item 49's reveal of the working folder), which means that when returning to
   * Files from Search etc., the position sat on the working folder's row instead of the open file. VS Code puts the position on the open file,
   * so this was aligned. When there is no open file or it is not in the tree, it is the working folder's row as before.
   */
  const treeIndex = useMemo(() => {
    // TODO 1257: the Files selection (the main highlight) comes before the viewer's file.
    for (const anchor of [treeCursor, filerSelected, selectedUri, revealedUri]) {
      if (anchor === null) continue
      const index = findTreeIndex(rows, anchor)
      if (index >= 0) return index
    }
    return -1
  }, [rows, treeCursor, filerSelected, selectedUri, revealedUri])

  const open = (entry: FileEntry, rowKey?: string, activate = false): void => {
    cancelPendingOpen()
    // When a row is pressed, the reveal highlight has done its job (the meaning of the pressed row takes priority).
    clearReveal()
    if (!searching) setTreeCursor(rowKey ?? entry.uri)
    // TODO 1257: a picked row (file or folder) is the Files selection and one step of its history.
    pickFilerRow(entry.uri)
    // TODO 562: a `.app` is not opened. Pressing a tree row only moves the position; a filter result (Enter / click) and
    // Enter in the tree mean "reveal in Finder" (the same as double-click. It is not launched; owner decision).
    if (isAppBundle(entry)) {
      if (activate || searching) void window.aios.editor.reveal(entry.uri, true)
      return
    }
    // TODO 436: folders also appear in filter results (the same entry point as file-name search). Expanding or collapsing in the result list
    // would not be visible, so release the filter and select that folder in the tree (`reveal`'s always empties the field).
    if (entry.isDirectory && searching) void reveal(entry.uri)
    else if (entry.isDirectory) void toggle(entry.uri)
    else select(entry.uri)
  }

  /** "... N more" was pressed / Enter (TODO 904): show all of that folder, and move the key position to the first row that had been omitted. */
  const showMore = (row: TreeRow): void => {
    if (row.more === undefined) return
    cancelPendingOpen()
    clearReveal()
    setTreeCursor(row.more.nextKey)
    useStore.getState().showAllChildren(row.more.parentUri)
  }

  /** The number of rows visible in the list (one PageUp / PageDown step). */
  const pageRows = (): number =>
    Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1)

  /**
   * Keys for the file-name filter results (`searching`). The same whether focus is in the filter field or in the list container.
   * Up/Down only move the highlight, and opening is Enter (as before). Returns true if handled.
   */
  const resultsKey = (key: string): boolean => {
    if (key === 'Enter') {
      const item = items[cursor]
      if (item === undefined) return false
      open('entry' in item ? item.entry : item)
      return true
    }
    const next = listKeyStep(key, cursor, items.length, { wrap: false, homeEnd: false })
    if (next === null) return false
    setCursor(next)
    return true
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // `isComposing` stays true on the confirming Enter in both Safari and Chromium.
    // To be safe, keyCode 229 is also checked (an old IME sets only that). The decision is `navKey` (TODO 356).
    const key = navKey(event, composing.current)
    if (key === null) return
    if (key === 'Escape') {
      setDraftQuery('')
      return
    }
    if (resultsKey(key)) event.preventDefault()
  }

  /**
   * Move to a tree row (TODO 356). Moves the highlight, scrolls if it is not visible, and for a file waits briefly and
   * opens it in the viewer too (owner decision: it opens at the moment it is chosen with Up/Down. VS Code does not). A folder is not expanded or collapsed.
   */
  const moveTreeCursor = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setTreeCursor(row.key)
    clearReveal()
    virtualizer.scrollToIndex(toViewIndex(index, inputAt))
    cancelPendingOpen()
    // The "... N more" row (TODO 904) has nothing to open.
    if (row.more !== undefined) return
    // TODO 1257: ↑↓ picks the row (folders too); moves within 1 s collapse into one step, like the viewer history.
    pickFilerRow(row.entry.uri, { byKeys: true })
    if (row.entry.isDirectory) return
    const uri = row.entry.uri
    pendingOpen.current = setTimeout(() => {
      pendingOpen.current = null
      // Leaving a file that has a draft does not show a confirmation: the draft stays in 312's table.
      // `byKeys`: in the viewer's history, consecutive Up/Down presses within 1 second are merged into one step (TODO 369).
      if (useStore.getState().selectedUri !== uri) select(uri, { byKeys: true })
    }, TREE_OPEN_DEBOUNCE_MS)
  }

  /**
   * Opens the input field for "new file / folder" (TODO 370). If there is no `entry` (the row that was right-clicked), the row at the key position,
   * and failing that the reveal row -> the first root. For a folder row it is created inside, and for a file row in its parent (VS Code).
   * If the parent is closed, open it. While filtering, return to the tree (the input field opens at the tree row's position).
   */
  const startCreate = (kind: NewEntryKind, entry?: FileEntry): void => {
    cancelPendingOpen()
    // The last candidate is the first root that is not a shortcut (TODO 520) (= `~/`). Even if shortcuts are listed first, it creates in the home as before.
    const base =
      entry ??
      rows[treeIndex]?.entry ??
      rows.find((row) => row.entry.uri === revealedUri)?.entry ??
      (rows.find((row) => row.depth === 0 && row.entry.shortcut === undefined) ?? rows[0])?.entry
    const parentUri = base === undefined ? null : newEntryParent(base)
    if (parentUri === null) return
    // Do not create inside a view-only shortcut (TODO 520, trash) (main also refuses).
    if (insideReadOnlyRoot(parentUri, readOnlyRoots)) return
    if (searching) {
      setDraftQuery('')
      setQuery('')
    }
    if (!useStore.getState().expanded.has(parentUri)) void useStore.getState().expand(parentUri)
    setCreating({ parentUri, kind })
  }

  /** Starts a rename (TODO 1145). The old name goes into the input field at the row's position, all selected. */
  const startRename = (row: TreeRow): void => {
    if (searching || row.more !== undefined || insideReadOnlyRoot(row.entry.uri, readOnlyRoots)) return
    // The names of shortcut roots (home, Downloads, etc.) cannot be renamed: the row's name is Finder's display name, not the real name.
    if (row.entry.shortcut !== undefined) return
    cancelPendingOpen()
    setCreating(null)
    setRenaming({ key: row.key, entry: row.entry })
  }

  const validateRename = (value: string): string | null => {
    if (renaming === null) return null
    const siblings = useStore.getState().children[renaming.entry.parentUri ?? ''] ?? NO_ENTRIES
    const problem = renameProblem(value, renaming.entry, siblings)
    return problem === null ? null : describeReason(t, formatReason(problem.code, problem.params))
  }

  /** Enter. Main re-validates and renames. After renaming, swap the open viewer's URI for the new one. */
  const submitRename = async (value: string): Promise<string | null> => {
    if (renaming === null) return null
    const { entry } = renaming
    const result = await window.aios.fs.rename(entry.uri, value)
    if (result.uri === null) return describeCreateRefusal(t, result.reason, result.params)
    setRenaming(null)
    parentRef.current?.focus()
    clearReveal()
    const newUri = result.uri
    const state = useStore.getState()
    if (newUri !== entry.uri) {
      // Move the keys of the draft, the opened folders and the list to the new URI (before re-selecting: restoring looks up the new key).
      const renamed = state.noteRenamed(entry.uri, newUri)
      renameFilerRows(entry.uri, newUri)
      const moved = replaceUriPrefix(state.selectedUri, entry.uri, newUri)
      if (moved !== null && moved !== state.selectedUri) state.select(moved)
      await renamed
    }
    if (entry.parentUri !== null && state.children[entry.parentUri] !== undefined) await state.refresh(entry.parentUri)
    setTreeCursor(newUri)
    return null
  }

  const cancelRename = (why: InlineNameCancel): void => {
    setRenaming(null)
    if (why === 'escape') parentRef.current?.focus()
  }

  /** Validation on each keystroke in the input field. It is checked against the parent's list (what is visible now). The authority is main. */
  const validateName = (value: string): string | null => {
    if (creating === null) return null
    const problem = newEntryProblem(
      value,
      creating.kind,
      useStore.getState().children[creating.parentUri] ?? NO_ENTRIES
    )
    return problem === null ? null : describeReason(t, formatReason(problem.code, problem.params))
  }

  /** Enter. Main creates it and answers after putting it into the index. If refused, the message is returned (the field stays). */
  const submitName = async (value: string): Promise<string | null> => {
    if (creating === null) return null
    const { parentUri, kind } = creating
    const create = kind === 'file' ? window.aios.fs.createFile : window.aios.fs.createFolder
    const result = await create(parentUri, value)
    if (result.uri === null) return describeCreateRefusal(t, result.reason, result.params)
    setCreating(null)
    // After creating, focus goes to the tree (the same as VS Code). The key position goes to what was created.
    parentRef.current?.focus()
    clearReveal()
    // TODO 1257: the created row becomes the Files selection (VS Code selects it too).
    pickFilerRow(result.uri)
    await useStore.getState().noteCreated(parentUri, result.uri, kind === 'folder')
    if (kind === 'folder') {
      setTreeCursor(result.uri)
      pendingReveal.current = { uri: result.uri, always: false }
    }
    return null
  }

  const cancelCreate = (why: InlineNameCancel): void => {
    setCreating(null)
    // Esc returns to the tree. When the user pressed outside the field (blur), focus is left to wherever they pressed.
    if (why === 'escape') parentRef.current?.focus()
  }

  /** Keys for the list container (tree / filter results). Not touched when focus is on a button inside a row. */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    // 365-1: while the right-click menu is open, the tree does not take keys (the menu's Up/Down / Enter come first).
    // The menu takes focus so it normally does not get here, but this is insurance for the one render before focus enters.
    if (menuPoint !== null) return
    const key = navKey(event)
    if (key === null) return
    // TODO 1145: F2 = rename (VS Code's explorer). Enter stays "open" as before (356).
    if (key === 'F2' && !searching) {
      const target = rows[treeIndex]
      if (target !== undefined) {
        event.preventDefault()
        startRename(target)
      }
      return
    }
    if (searching) {
      if (resultsKey(key)) event.preventDefault()
      return
    }
    const step = listKeyStep(key, treeIndex, rows.length, { wrap: false, page: pageRows() })
    if (step !== null) {
      event.preventDefault()
      if (step !== treeIndex || treeCursor === null) moveTreeCursor(step)
      return
    }
    const action = treeKeyAction(key, rows, treeIndex)
    if (action === null) return
    event.preventDefault()
    const row = rows[action.index]
    if (row === undefined) return
    switch (action.kind) {
      case 'move':
        moveTreeCursor(action.index)
        return
      case 'expand':
      case 'collapse':
        clearReveal()
        setTreeCursor(row.key)
        pickFilerRow(row.entry.uri, { byKeys: true })
        void toggle(row.entry.uri)
        return
      case 'activate':
        if (row.more !== undefined) {
          showMore(row)
          return
        }
        open(row.entry, row.key, true)
    }
  }

  useEffect(() => {
    if (searching) virtualizer.scrollToIndex(cursor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor])

  // When the input field (TODO 370) is opened, show up to that row.
  useEffect(() => {
    if (inputAt !== null) virtualizer.scrollToIndex(inputAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating === null, inputAt === null])

  const activeIndex = searching ? (items.length > 0 ? cursor : -1) : treeIndex

  return (
    <>
      <div className="sidebar-header">
        {/* TODO 1257: Files back / forward (this conversation's picked rows). */}
        <FilerNavButtons />
        <div className="search-input-wrap">
          <input
            className="search-input"
            type="search"
            {...ASCII_INPUT}
            placeholder={t('sidebar.files.placeholder')}
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onKeyDown={onKeyDown}
            // Pass the highlight of the filter results (Up/Down) to screen readers too. Focus stays on the field (TODO 356).
            aria-controls={searching ? listId : undefined}
            aria-activedescendant={searching && activeIndex >= 0 ? rowId(activeIndex) : undefined}
          />
          {/* smart case (TODO 291): filtering uses the same entry point as File-name search, so it shows the same badge. */}
          <SearchCaseBadge shown={results?.caseSensitive === true && draftQuery.trim() !== ''} />
        </div>
        {/* TODO 370: the heading's "new file / folder". Shown only while the mouse is over it (and while focus is inside) (VS Code). */}
        <span className="files-actions">
          <Tooltip content={t('files.newFile')}>
            <button
              type="button"
              className="icon-button files-action"
              aria-label={t('files.newFile')}
              onClick={() => startCreate('file')}
            >
              <NewFileIcon />
            </button>
          </Tooltip>
          <Tooltip content={t('files.newFolder')}>
            <button
              type="button"
              className="icon-button files-action"
              aria-label={t('files.newFolder')}
              onClick={() => startCreate('folder')}
            >
              <NewFolderIcon />
            </button>
          </Tooltip>
        </span>
        <HiddenFilesToggle />
      </div>

      {/*
  TODO 356: one container holds the focus and points at a row with `aria-activedescendant` (VS Code's explorer).
  Rows may not be drawn because of virtualization, so focus is not given per row. Tab stops here (tabIndex 0).
  */}
      <div
        className="sidebar-list file-tree"
        ref={parentRef}
        id={listId}
        role={searching ? 'listbox' : 'tree'}
        aria-label={t('sidebar.mode.files')}
        tabIndex={0}
        aria-activedescendant={activeIndex >= 0 ? rowId(activeIndex) : undefined}
        onKeyDown={onListKeyDown}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const index = fromViewIndex(virtualRow.index, inputAt)
            if (index === null) {
              // The row of the input field (TODO 370). Put it in front of the row so the tooltip that appears below is not hidden by the next row.
              const parentRow = rows[(inputAt ?? 1) - 1]
              return creating === null ? null : (
                <div
                  key="inline-name"
                  className="row-inline-name"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    zIndex: 1
                  }}
                >
                  <InlineNameInput
                    depth={(parentRow?.depth ?? -1) + 1}
                    icon={creating.kind === 'folder' ? '▸' : ''}
                    kindIcon={(value) => (
                      <FileIcon name={value} isDirectory={creating.kind === 'folder'} />
                    )}
                    ariaLabel={t(creating.kind === 'folder' ? 'files.newFolderName' : 'files.newFileName')}
                    validate={validateName}
                    onSubmit={submitName}
                    onCancel={cancelCreate}
                  />
                </div>
              )
            }
            const item = items[index]
            if (item === undefined) return null
            const row: TreeRow =
              'entry' in item
                ? item
                : { entry: item, key: item.uri, depth: 0, expanded: false, loading: false }
            if (renaming !== null && !searching && renaming.key === row.key) {
              // Rename (TODO 1145): this row's position becomes the input field (zIndex so the tooltip below is not hidden by the next row).
              return (
                <div
                  key={`rename-${row.key}`}
                  className="row-inline-name"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    zIndex: 1
                  }}
                >
                  <InlineNameInput
                    depth={row.depth}
                    icon={icon(row.entry, row.expanded)}
                    kindIcon={(value) => <FileIcon name={value} isDirectory={row.entry.isDirectory} />}
                    ariaLabel={t('files.renameName')}
                    initial={row.entry.name}
                    validate={validateRename}
                    onSubmit={submitRename}
                    onCancel={cancelRename}
                  />
                </div>
              )
            }
            // TODO 1257: the main highlight is the Files selection; the viewer's file gets a quiet mark.
            const selected = filerSelected === row.entry.uri
            const viewerOpen = selectedUri === row.entry.uri
            const cursored = searching && index === cursor
            // The tree's key position (TODO 356). The frame is visible only when the container has focus (CSS).
            const treeCursored = !searching && index === treeIndex
            if (row.more !== undefined) {
              // TODO 904: "... N more". It is not an ordinary row (it has no open, drag or right-click actions).
              return (
                <div
                  key={row.key}
                  id={rowId(index)}
                  role="treeitem"
                  aria-selected={false}
                  aria-level={row.depth + 1}
                  className={`row row-more${treeCursored ? ' tree-cursor' : ''}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingLeft: `${8 + row.depth * 12}px`
                  }}
                  title={t('files.moreTitle', {
                    total: (useStore.getState().children[row.more.parentUri]?.length ?? 0)
                  })}
                  onClick={() => showMore(row)}
                >
                  <span className="row-icon" />
                  <span className="row-name">{t('files.more', { count: row.more.hidden })}</span>
                </div>
              )
            }
            // Whether the row is inside a view-only shortcut (TODO 520, trash). No create / search / new chat / drag is shown.
            const readOnly = !searching && insideReadOnlyRoot(row.entry.uri, readOnlyRoots)
            // The names of shortcut roots are the same display names as Finder (TODO 520).
            const labelKey = searching ? null : shortcutLabelKey(row.entry)
            const label = labelKey === null ? row.entry.name : t(labelKey)
            // A `.app` (TODO 562) is a row that is not opened, so "search inside this folder" is not shown either.
            // It is also not shown inside a shortcut that does not go into the index (TODO 561, `/tmp`) (it is not in the index, so it would be 0 hits).
            const unindexed = !searching && insideReadOnlyRoot(row.entry.uri, unindexedRoots)
            const searchable = row.entry.isDirectory && !readOnly && !unindexed && !isAppBundle(row.entry)
            // The row's "new chat here" (item 263): for a folder it is that folder, for a file the parent is the cwd.
            const chatTarget = readOnly ? null : newChatTarget(row.entry)
            return (
              <div
                key={row.key}
                id={rowId(index)}
                role={searching ? 'option' : 'treeitem'}
                aria-selected={selected}
                aria-level={searching ? undefined : row.depth + 1}
                aria-expanded={!searching && row.entry.isDirectory ? row.expanded : undefined}
                className={`row has-path-actions${searchable ? ' has-search-in-folder' : ''}${selected ? ' selected' : ''}${viewerOpen ? ' viewer-open' : ''}${cursored ? ' cursored' : ''}${treeCursored ? ' tree-cursor' : ''}${chatTarget === null ? '' : ' has-new-chat'}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingLeft: `${8 + (searching ? 0 : row.depth * 12)}px`
                }}
                // Can be dragged to other apps (Terminal, Finder, etc.) (TODO 677). Folder rows can be passed too.
                // Main passes `assertAllowed` and then starts an OS native drag with `webContents.startDrag`.
                // Drops onto aios's own overlay, viewer and input field work as before (the URI remembered by `beginFilesDrag`,
                // `files-drag.ts`).
                //
                // **Fix from code-review (owner decision 2026-10-11)**: Electron's `webContents.startDrag` does not expose a way to narrow
                // NSDragOperation to copy only (there is only `item: { file, files, icon }` and no way to specify the allowed operations), so as long as it goes out as a native drag
                // it behaves the same as dragging from Finder (move on the same volume, copy with Option). **Only the trash (readOnly) rows are
                // not sent as a native drag**: they go back to the `dataTransfer.setData('text/uri-list', …)` of before 677 and
                // stay with the browser's ordinary HTML5 DnD (DnD of web content cannot be dropped to Finder/Terminal as real files,
                // so there is no worry of it leaving). A drop into aios works as before, since `carriesFiles`
                // also looks at `text/uri-list`.
                draggable
                onDragStart={(event) => {
                  if (readOnly) {
                    event.dataTransfer.setData('text/uri-list', row.entry.uri)
                    event.dataTransfer.effectAllowed = 'copy'
                    return
                  }
                  event.preventDefault()
                  beginFilesDrag([row.entry.uri])
                  window.aios.fs.startDrag([row.entry.uri])
                }}
                onDragEnd={() => endFilesDrag()}
                onClick={() => open(row.entry, row.key)}
                // TODO 562: double-clicking a `.app` is "reveal in Finder" (it is not launched).
                onDoubleClick={
                  isAppBundle(row.entry) && !searching
                    ? () => void window.aios.editor.reveal(row.entry.uri, true)
                    : undefined
                }
                // TODO 299: the right-click menu (open in editor / copy path / reveal in Finder / new chat here).
                // TODO 370: only for tree rows, "New file... / New folder..." at the top (VS Code's explorer).
                onContextMenu={(event) => {
                  // Small observation on 356 (365): move the key position to the right-clicked row (the same as VS Code). It is not
                  // opened in the viewer (VS Code does not open on right-click either). The pending wait to open from Up/Down is cancelled.
                  if (!searching) {
                    cancelPendingOpen()
                    clearReveal()
                    setTreeCursor(row.key)
                  }
                  openMenu(event, [
                    ...(searching || readOnly
                      ? []
                      : newEntryMenuItems(t, (kind) => startCreate(kind, row.entry))),
                    // TODO 437: only folder rows get "Search inside this folder...". The same route as the hover magnifier.
                    ...(searchable
                      ? [searchInFolderMenuItem(row.entry.uri, t, openSearchInFolder)]
                      : []),
                    // TODO 834: open the folder in the git extension's Source Control view.
                    ...(sourceControl && row.entry.isDirectory && !isAppBundle(row.entry)
                      ? [sourceControlMenuItem(row.entry.uri, t, select)].filter((item) => item !== null)
                      : []),
                    ...pathContextMenuItems(row.entry.uri, row.entry.isDirectory, t, platform, {
                      openInEditor,
                      openInDefaultApp: openDefault,
                      reveal: (uri, dir) => window.aios.editor.reveal(uri, dir),
                      createThreadInFolder
                    }).filter((item) => !readOnly || item.key !== 'new-chat'),
                    // TODO 1145: rename (only for tree rows. Not shown for shortcut roots or inside view-only shortcuts).
                    ...(searching || readOnly || row.entry.shortcut !== undefined
                      ? []
                      : [renameMenuItem(t, () => startRename(row))])
                  ])
                }}
                title={
                  labelKey === null
                    ? row.entry.name
                    : readOnly
                      ? `${label} — ${t('files.shortcut.readOnly')}`
                      : unindexed
                        ? `${label} — ${t('files.shortcut.unindexed')}`
                        : label
                }
              >
                <span className="row-icon">{icon(row.entry, row.expanded)}</span>
                {/* TODO 404: the kind icon (Seti, colored). A folder is folder / folder-open depending on its open state. */}
                {/* TODO 562: a `.app` has the macOS app icon (main's `app.getFileIcon`). */}
                {isAppBundle(row.entry) ? (
                  <AppBundleIcon uri={row.entry.uri} name={row.entry.name} mtimeMs={row.entry.mtimeMs} />
                ) : (
                  <FileIcon
                    name={row.entry.name}
                    isDirectory={row.entry.isDirectory}
                    expanded={row.expanded}
                    special={row.entry.isDirectory ? specialFolderFor(row.entry.uri, homeUri) : null}
                  />
                )}
                <span className="row-name">{label}</span>
                {/* TODO 558: a symlink row gets an arrow after the name (the same mark as VS Code's explorer). */}
                {row.entry.symlink === true ? (
                  <span className="row-link" aria-label={t('files.symlink')} title={t('files.symlink')}>
                    ↪
                  </span>
                ) : null}
                {row.loading ? <span className="row-hint">…</span> : null}
                {/* TODO 299: the same hover action as 289 is also shown at the right end of a tree row. To avoid overlapping the tooltip of 263,
  it is shifted inward by the width of the new-chat button (24px). */}
                <span
                  className="row-path-actions"
                  style={{ right: chatTarget === null ? 4 : 28 }}
                >
                  {/* TODO 437: only folder rows get "search inside this folder". The same route as the right-click menu.
  It is not shown inside a view-only shortcut (TODO 520) since it is not in the index. */}
                  {searchable ? (
                    <Tooltip content={t('files.searchInFolder')}>
                      <button
                        type="button"
                        className="icon-button row-action"
                        aria-label={t('files.searchInFolder')}
                        onClick={(event) => {
                          event.stopPropagation()
                          openSearchInFolder(row.entry.uri)
                        }}
                      >
                        <SearchInFolderIcon />
                      </button>
                    </Tooltip>
                  ) : null}
                  <PathActions
                    uri={row.entry.uri}
                    asDirectory={row.entry.isDirectory}
                    className="row-action"
                  />
                </span>
                {chatTarget === null ? null : (
                  // Shown at the right end of a hovered or selected row (the same as the row actions of VS Code's explorer).
                  <NewChatButton
                    uri={chatTarget}
                    className="row-new-chat"
                    label={t('threads.newInFolder', { name: newChatFolderName(chatTarget) })}
                  />
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

function StatusBar(): React.JSX.Element | null {
  const t = useT()
  const scan = useStore((state) => state.scan)
  const results = useStore((state) => state.results)
  const rescan = useStore((state) => state.rescan)
  const mode = useThreads((state) => state.mode)
  const agent = useThreads((state) => state.agent)
  const activeThreadId = useThreads((state) => state.activeThreadId)

  // The index progress was moved to the right side of the BottomBar (5.6, TODO 52). Nothing is shown at the bottom edge of search mode
  // (the scan state below belongs to file mode and is a separate matter from search).
  if (mode === 'search') return null
  // There is nothing to show at the bottom edge of the extensions view (TODO 367) either (the scan state belongs to file mode).
  if (mode === 'extensions') return null
  // The scheduled-run list (TODO 372) has its own heading and strip. The status bar at the bottom edge is not needed.
  if (mode === 'schedule') return null
  // The three boxes of web (TODO 522) also have their own headings.
  if (mode === 'web') return null
  // A plugin's own list (TODO 1039) also has its own heading.
  if (mode === 'plugin') return null

  if (mode === 'threads') {
    // The backend's state (4.6). Always show the version and the degraded state in a visible place.
    if (agent === null) return <div className="status-bar">…</div>
    if (!agent.available) {
      return (
        <div className="status-bar">
          <span className="denied">
            {/* If there is a code, use that (TODO 519: `message` is the adapter's Japanese fallback). */}
            {agent.messageCode !== null
              ? describeReason(t, agent.messageCode)
              : agent.message === null
                ? t('reason.agent-unavailable')
                : describeReason(t, agent.message)}
          </span>
        </div>
      )
    }
    return (
      <div className="status-bar">
        {agent.loggedIn ? null : <span className="denied">{t('settings.agent.notLoggedIn')}</span>}
        {agent.loggedIn ? null : (
          <button
            type="button"
            className="auth-login-button"
            title={t('thread.auth.loginTitle')}
            onClick={() => void startLogin(t, activeThreadId)}
          >
            {t('thread.auth.login')}
          </button>
        )}
        {agent.degradations.length > 0 ? (
          <span className="denied" title={agent.degradations.map((d) => describeReason(t, d.code) || d.reason).join('\n')}>
            {t('sidebar.status.degraded', { count: agent.degradations.length })}
          </span>
        ) : null}
      </div>
    )
  }

  if (results !== null) {
    // **Do not drop silently** (6.6). Always show the top N, the total count and any cutoff.
    const shown = results.entries.length
    const label =
      results.total > shown
        ? t('sidebar.status.topOfTotal', { shown, total: results.total.toLocaleString() })
        : t('common.count', { count: shown })
    return (
      <div className="status-bar">
        <span title={`${results.tookMs} ms`}>{label}</span>
        {results.scanTruncated ? (
          <span
            className="denied"
            title={t('sidebar.status.truncatedHint')}
          >
            {t('sidebar.status.truncated')}
          </span>
        ) : null}
      </div>
    )
  }
  if (scan === null) return <div className="status-bar">…</div>

  // When something was skipped, show "when it last ran". If skipped silently, a result missing from search looks like a bug.
  const lastFull = t('sidebar.scan.lastFull', {
    ago: scan.lastFullScanAt === null ? t('sidebar.scan.unknown') : formatAgo(t, scan.lastFullScanAt)
  })
  const label =
    scan.state === 'scanning'
      ? t('sidebar.scan.scanning', { count: scan.indexed.toLocaleString() })
      : scan.state === 'done'
        ? scan.skipped
          ? t('sidebar.scan.skipped', { lastFull })
          : t('common.count', { count: scan.indexed.toLocaleString() })
        : scan.state === 'error'
          ? t('sidebar.scan.error', { message: scan.message ?? '' })
          : t('sidebar.scan.never')
  const title =
    scan.lastFullScanAt === null ? undefined : new Date(scan.lastFullScanAt).toLocaleString()
  // It also runs when idle while resident (6.2.2). Running silently would leave the reason for slowness unknown, so
  // show the time when its deadline next comes.
  const next =
    scan.state === 'scanning' || scan.nextFullScanAt === null
      ? null
      : t('sidebar.scan.next', { when: formatIn(t, scan.nextFullScanAt) })

  return (
    <div className="status-bar">
      <span title={title}>{label}</span>
      {next === null ? null : (
        <span title={new Date(scan.nextFullScanAt as number).toLocaleString()}>{next}</span>
      )}
      {scan.denied > 0 ? (
        <span
          className="denied"
          title={t('sidebar.scan.deniedHint')}
        >
          {t('sidebar.scan.denied', { count: scan.denied })}
        </span>
      ) : null}
      <button type="button" onClick={() => void rescan()} disabled={scan.state === 'scanning'}>
        {t('sidebar.scan.rescan')}
      </button>
    </div>
  )
}

/** The form "in about 3 hours". If already past, "soon". */
export function formatIn(t: Translate, at: number, now: number = Date.now()): string {
  const ms = at - now
  if (ms <= 60_000) return t('time.soon')
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return t('time.inMinutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.inHours', { n: hours })
  return t('time.inDays', { n: Math.floor(hours / 24) })
}

/** The form "3 hours ago". It is for the status bar, so coarse granularity is fine. */
export function formatAgo(t: Translate, at: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - at)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  return t(days === 1 ? 'time.daysAgo.one' : 'time.daysAgo.other', { n: days })
}
