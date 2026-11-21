/**
 * Sidebar thread mode (ARCHITECTURE.md 5).
 * Unread is set on the main side when `result` arrives and cleared when the thread is opened (4.3). Presentation is
 * item 151: unread is bold plus an accent-colored dot at the right end of the row; awaiting approval / a choice
 * question is a warning-colored dot (with a count); the title of a read thread is one step dimmer (not dimmed while
 * selected). Sorting (item 152) is in `thread-sort.ts`.
 */
import { TriggerIcon } from '../icons/TriggerIcon.js'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { threadRecency, type ThreadSummary } from '@shared/thread.js'
import { displayPath } from '@shared/uri.js'
import { useThreads } from '../threadStore.js'
import { useStore } from '../store.js'
import { rainbowStyle } from '../rainbow.js'
import { DeletedThreads } from './DeletedThreads.js'
import { Spinner } from './Spinner.js'
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.js'
import { SortFolderIcon, SortRecentIcon, SortUnreadIcon } from '../icons/SortIcons.js'
import { NewChatButton } from './NewChatButton.js'
import { folderHeadingView, showsRowCwd, showsRowNewChat, subtasksTooltip } from '../thread-list-heading.js'
import { useT, type Translate } from '../i18n/index.js'
import { threadTitleLabel } from '../thread/title.js'
import { provisionalTitleOf } from '../composer-drafts.js'
import { carriesFiles, droppedUris } from '../drop-uris.js'
import { currentFilesDrag, endFilesDrag, filesDragActive } from '../files-drag.js'
import { Tooltip } from './Tooltip.js'
import { useLocale } from '../localeStore.js'
import { formatRowTime, rowClockNow, subscribeRowClock } from '../row-time.js'
import { formatExactDateTime } from '../thread/turn-end.js'
import { navKey } from '../list-keys.js'
import { interruptReasonLabel, rowBadgeOf } from '../thread/resume.js'
import { useThreadCollapse } from '../threadCollapseStore.js'
import { ContextMenu, useContextMenuState, type ContextMenuItem } from './ContextMenu.js'
import { exportThread } from '../export-pdf.js'
import { SearchIcon } from '../icons/SearchIcon.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { useThreadFilter } from '../threadFilterStore.js'
import {
  filterIndicesWithRoles,
  normalizeFilterQuery,
  pickByIndices,
  selectProjectNames,
  shouldApplyFilter
} from '../thread-filter.js'
import { useRoles } from '../roleStore.js'
import { useSchedule } from '../scheduleStore.js'
import { TeammateIcon } from '../icons/TeammateIcon.js'
import { ComposeIcon } from '../icons/ComposeIcon.js'
import type { Role } from '@shared/role.js'
import {
  THREAD_SORT_KEY,
  arrangeRoleGroups,
  arrangeThreads,
  attentionOf,
  FOLDER_KEY_ATTR,
  folderOf,
  loadThreadSort,
  nextCollapseBoundary,
  nextPin,
  parseThreadSort,
  saveThreadSort,
  selectAttention,
  selectCollapsible,
  selectFolderThreads,
  selectRoleAttention,
  selectRoleIds,
  toSortRows,
  type SortPin,
  busyOf,
  type ThreadListItem,
  type ThreadSortKey
} from '../thread-sort.js'

/**
 * Text symbols for the non-running states. `idle` shows nothing. Awaiting approval (formerly `!`) moved to the
 * warning-colored dot at the right end of the row (item 151).
 */
const STATE_MARK: Record<string, string> = {
  error: '×'
}

/** An empty list for the selector (do not return a new array every time). */
const NO_ROLES: readonly Role[] = []
const NO_COLLAPSED_ROLES: ReadonlySet<string> = new Set()

/**
 * TODO 1288: the context menu rows that move a conversation under a Teammate ("Move to Teammate: <name>", the current one is checked and
 * left out) and take it out ("Remove from Teammate", only when it has one). Grayed while the conversation is running and for one started
 * by a scheduled run or a trigger (main refuses both; closing side).
 */
export function teammateMenuItems(
  summary: ThreadSummary,
  roles: readonly Role[],
  t: Translate,
  move: (roleId: string | null) => void
): readonly ContextMenuItem[] {
  const thread = summary.thread
  if (roles.length === 0 && thread.roleId === undefined) return []
  const locked = thread.scheduledJobId !== undefined || thread.triggerOrigin !== undefined
  const running = busyOf(summary) || summary.runtime.state === 'awaiting-approval' || summary.runtime.state === 'starting'
  const disabled = locked || running
  const hint = locked ? undefined : running ? t('roles.moveBusy') : undefined
  const rows: ContextMenuItem[] = roles
    .filter((role) => role.id !== thread.roleId)
    .map((role) => ({
      key: `move-role-${role.id}`,
      label: t('roles.moveTo', { name: role.name }),
      onSelect: () => move(role.id),
      disabled,
      ...(hint === undefined ? {} : { hint })
    }))
  if (thread.roleId !== undefined) {
    rows.push({
      key: 'move-out',
      label: t('roles.moveOut'),
      onSelect: () => move(null),
      disabled,
      ...(hint === undefined ? {} : { hint })
    })
  }
  return rows
}

/** Sort segments (item 152). Icon, and the key into the screen reader / title dictionary. */
function sortOptions(t: Translate): SegmentedOption<ThreadSortKey>[] {
  return [
    { value: 'recent', label: t('threads.sort.recent'), icon: <SortRecentIcon /> },
    { value: 'unread', label: t('threads.sort.unread'), icon: <SortUnreadIcon /> },
    { value: 'cwd', label: t('threads.sort.cwd'), icon: <SortFolderIcon /> }
  ]
}

export function ThreadList(): React.JSX.Element {
  // The order (item 75). An update to a single row keeps the same order object, so this does not re-render.
  const order = useThreads((state) => state.threadOrder)
  const activeThreadId = useThreads((state) => state.activeThreadId)
  const t = useT()
  // The sort condition (item 152). Remembered in `localStorage`; a change in another window is followed through the `storage` event.
  const [sortKey, setSortKey] = useState<ThreadSortKey>(() => loadThreadSort())
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== THREAD_SORT_KEY) return
      const next = parseThreadSort(event.newValue)
      if (next !== null) setSortKey(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  // Pull only what the condition needs as material for re-sorting. With `useShallow`, even if cost or usage moves
  // on `turn_usage`, the previous array is kept as long as the elements are the same, so the `useMemo` below does
  // not run either (items 75 / 88).
  const attention = useThreads(
    useShallow((state) => selectAttention(sortKey, state.threadOrder, state.threadsById))
  )
  const folderThreads = useThreads(
    useShallow((state) => selectFolderThreads(sortKey, state.threadOrder, state.threadsById))
  )
  // Expansion is not remembered (starts collapsed on every launch / window open; owner decision). Switching the sort re-collapses.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [sortKey])
  // TODO 659: collapse rows with no activity for 5 days or more. The number of days is a setting (0 = do not collapse).
  // Code-review fix: instead of ticking a clock every 30 seconds and recomputing the whole list, set a single timer
  // only for the moment the next boundary (`threadRecency + collapseDays*DAY_MS`) is crossed
  // (`nextCollapseBoundary`). When it fires, take `now` again and set the next single timer. If no row hits a
  // boundary, no timer is set at all: other changes (becoming unread, starting to run, etc.) are re-rendered directly
  // by store updates, so no clock is needed.
  const collapseDays = useThreadCollapse((state) => state.days)
  const [now, setNow] = useState(() => Date.now())
  const collapseBoundary = useThreads((state) =>
    nextCollapseBoundary(collapseDays, now, state.threadOrder, state.threadsById)
  )
  useEffect(() => {
    if (collapseBoundary === null) return
    const delay = Math.max(0, collapseBoundary - Date.now())
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [collapseBoundary])
  // Code-review fix: the exemption for the selected row only applies while collapsed (not expanded), so that an old row
  // selected while expanded does not jump outside "Show more" (see the comment of `selectCollapsible`).
  const collapsible = useThreads(
    useShallow((state) =>
      selectCollapsible(collapseDays, now, activeThreadId, expanded, state.threadOrder, state.threadsById)
    )
  )
  // TODO 1012: filtering by project name. The text is temporary per-window state. While filtering, the old collapsing is lifted and all matches are shown.
  const filterText = useThreadFilter((state) => state.query)
  const filterQuery = normalizeFilterQuery(filterText)
  const projectNames = useThreads(
    useShallow((state) => selectProjectNames(filterQuery, state.threadOrder, state.threadsById))
  )
  // In unread order, keep the selected row in place (owner decision). Remember the marker strength at the time of
  // selection and re-take it when another thread is selected or the condition is switched. `selectThread` writes the
  // selection first, and the read state arrives later in a single push from main, so in the render right after
  // selecting it is still readable as unread.
  const activeAttention = useThreads((state) =>
    activeThreadId === null ? 0 : attentionOf(state.threadsById[activeThreadId])
  )
  const [pin, setPin] = useState<SortPin | null>(null)
  const pinNow = nextPin(pin, activeThreadId, activeAttention, sortKey)
  if (pinNow !== pin) setPin(pinNow)
  // TODO 956: the folder key of the selected thread. In cwd order that group is not collapsed, and right after a switch
  // we scroll to its heading (we do not select; 80). When not in cwd order it is null (the selector value does not move).
  const activeFolderKey = useThreads((state) =>
    sortKey !== 'cwd' || activeThreadId === null ? null : folderOf(state.threadsById[activeThreadId]?.thread).folderKey
  )
  // TODO 972: roles (Teammates). Conversations of a known role are folded under its heading above the ordinary list; the rest are
  // arranged exactly as before. A conversation whose role is not in the list (not fetched yet, or just deleted) is an ordinary row.
  const roles = useRoles((state) => state.roles) ?? NO_ROLES
  const collapsedRoles = useRoles((state) => state.collapsed)
  const roleIds = useThreads(useShallow((state) => selectRoleIds(state.threadOrder, state.threadsById)))
  // TODO 1288: the filter also matches the name of a conversation's Teammate (the whole group stays).
  const keep = useMemo(() => {
    if (filterQuery === '') return null
    const nameOf = new Map(roles.map((role) => [role.id, role.name]))
    const roleNames = roles.length === 0 ? [] : roleIds.map((id) => (id === undefined ? '' : (nameOf.get(id) ?? '')))
    return filterIndicesWithRoles(projectNames, roleNames, filterQuery)
  }, [filterQuery, projectNames, roles, roleIds])
  const roleAttention = useThreads(useShallow((state) => selectRoleAttention(state.threadOrder, state.threadsById)))
  const items = useMemo(() => {
    if (roles.length === 0) {
      return keep === null
        ? arrangeThreads(sortKey, toSortRows(order, attention, folderThreads, collapsible), pinNow, expanded, activeFolderKey)
        : arrangeThreads(
            sortKey,
            toSortRows(pickByIndices(order, keep), pickByIndices(attention, keep), pickByIndices(folderThreads, keep), []),
            pinNow,
            true,
            activeFolderKey
          )
    }
    const known = new Set(roles.map((role) => role.id))
    const roleAt = (index: number): string | undefined => {
      const id = roleIds[index]
      return id !== undefined && known.has(id) ? id : undefined
    }
    const base = keep ?? order.map((_, index) => index)
    const plain = base.filter((index) => roleAt(index) === undefined)
    // The filter puts prefix matches first; the role groups are in recent order regardless.
    const inRole = base.filter((index) => roleAt(index) !== undefined).sort((a, b) => a - b)
    const roleItems = arrangeRoleGroups(
      roles,
      inRole.map((index) => ({ id: order[index]!, roleId: roleAt(index)!, attention: roleAttention[index] ?? 0 })),
      // While filtering, folds are lifted (as for ordinary rows) so that a match is never hidden under a folded heading.
      keep === null ? collapsedRoles : NO_COLLAPSED_ROLES,
      activeThreadId,
      keep === null
    )
    const plainItems = arrangeThreads(
      sortKey,
      toSortRows(
        pickByIndices(order, plain),
        pickByIndices(attention, plain),
        pickByIndices(folderThreads, plain),
        keep === null ? pickByIndices(collapsible, plain) : []
      ),
      pinNow,
      keep === null ? expanded : true,
      activeFolderKey
    )
    return [...roleItems, ...plainItems]
  }, [
    sortKey,
    order,
    attention,
    folderThreads,
    collapsible,
    pinNow,
    expanded,
    activeFolderKey,
    keep,
    roles,
    collapsedRoles,
    roleIds,
    roleAttention,
    activeThreadId
  ])
  const rowsRef = useRef<HTMLDivElement>(null)
  // Only once per switch (not moved on restore at launch, switch from another window, or re-selection).
  const scrollOnSwitch = useRef(false)
  useEffect(() => {
    scrollOnSwitch.current = sortKey === 'cwd'
  }, [sortKey])
  useEffect(() => {
    if (!scrollOnSwitch.current) return
    scrollOnSwitch.current = false
    if (activeFolderKey === null) return
    const heading = Array.from(rowsRef.current?.querySelectorAll(`[${FOLDER_KEY_ATTR}]`) ?? []).find(
      (el) => el.getAttribute(FOLDER_KEY_ATTR) === activeFolderKey
    )
    heading?.scrollIntoView({ block: 'start' })
  }, [sortKey, activeFolderKey, items])
  // The dialog entry point for creating (T5) moved to the top of the Activity Bar (TODO 408). The list no longer has it.
  const createThreadFromDrop = useThreads((state) => state.createThreadFromDrop)
  // Folder drop (item 98 (a)). The only drop target is the list (not attached to the whole window; the Composer takes attachments).
  const [dropping, setDropping] = useState(false)
  // TODO 821: F2 renames the selected thread. The row's edit state belongs to the row, so only the selected row is given
  // the counter marker. The marker is held together with "which thread this F2 was aimed at" (even if the selection
  // changes, it does not reach a newly selected row).
  const [renameRequest, setRenameRequest] = useState<{ id: string; tick: number }>({ id: '', tick: 0 })

  return (
    <div
      className={`thread-list${dropping ? ' dropping' : ''}`}
      // Clicking inside the list puts focus here (rows do not take focus). F2 works only while focus is in the list;
      // it is not stolen inside an input field or a viewer (the rename field and text fields are excluded).
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'F2' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
        if (activeThreadId === null) return
        event.preventDefault()
        setRenameRequest((r) => ({ id: activeThreadId, tick: r.tick + 1 }))
      }}
      onDragOver={(event) => {
        if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        // Do not clear on moving between child elements (only when leaving the list).
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
        event.preventDefault()
        setDropping(false)
        const uris = droppedUris(event.dataTransfer, window.aios.drop.uriFor, currentFilesDrag())
        // Used up by this drop (code-review fix, TODO 677).
        endFilesDrag()
        // Create immediately with the settings defaults (model, thinking, strict mode OFF) (owner decision 2).
        if (uris.length > 0) void createThreadFromDrop(uris)
      }}
    >
      <div className="thread-list-header">
        <span className="thread-list-title">{t('sidebar.mode.threads')}</span>
        <ThreadFilterToggle />
        <SegmentedControl
          className="thread-sort"
          label={t('threads.sort.label')}
          options={sortOptions(t)}
          value={sortKey}
          onChange={(next) => {
            setSortKey(next)
            saveThreadSort(next)
          }}
        />
      </div>
      <ThreadFilterBox />
      <div className="thread-rows" ref={rowsRef}>
        {order.length === 0 && roles.length === 0 ? (
          <div className="thread-empty">{t('threads.empty')}</div>
        ) : keep !== null && keep.length === 0 ? (
          <div className="thread-empty thread-filter-none">{t('threads.filter.none')}</div>
        ) : null}
        {dropping ? <div className="thread-drop-hint">{t('threads.dropHint')}</div> : null}
        {items.map((item) =>
          item.kind === 'folder' ? (
            <FolderHeading key={`folder:${item.key}`} item={item} />
          ) : item.kind === 'role' ? (
            <RoleHeading key={`role:${item.key}`} item={item} />
          ) : item.kind === 'more' ? (
            <MoreRow
              key="more"
              count={item.count}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
          ) : (
            <ThreadRowById
              key={item.id}
              id={item.id}
              active={item.id === activeThreadId}
              // TODO 972: a row under a role heading is drawn like a row inside a cwd group (indented, no cwd name line).
              sortKey={item.inRole === true ? 'cwd' : sortKey}
              renameTick={item.id === renameRequest.id ? renameRequest.tick : 0}
            />
          )
        )}
      </div>
      <DeletedThreads />
    </div>
  )
}

/**
 * TODO 1012: the magnifier in the heading. Pressing it opens / closes the filter field below the heading (the shape of
 * a VS Code view filter). Closing also resets the text to empty. While text is present it looks pressed (`on`).
 * Cmd+F belongs to ThreadFind (inside a conversation) and is not taken here.
 */
function ThreadFilterToggle(): React.JSX.Element {
  const t = useT()
  const open = useThreadFilter((state) => state.open)
  const active = useThreadFilter((state) => state.query !== '')
  const setOpen = useThreadFilter((state) => state.setOpen)
  return (
    <Tooltip content={t('threads.filter.toggle')}>
      <button
        type="button"
        className={`icon-button thread-filter-toggle${open || active ? ' on' : ''}`}
        aria-label={t('threads.filter.toggle')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <SearchIcon size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * TODO 1012: the field to filter by project name (the colored name at the top left of a row). Takes effect on every
 * keystroke (no Enter). During IME composition it only goes into the draft until commit (`compositionend`). Esc
 * empties it (if already empty, closes the field).
 */
function ThreadFilterBox(): React.JSX.Element | null {
  const t = useT()
  const open = useThreadFilter((state) => state.open)
  const query = useThreadFilter((state) => state.query)
  const setQuery = useThreadFilter((state) => state.setQuery)
  const setOpen = useThreadFilter((state) => state.setOpen)
  const [draft, setDraft] = useState(query)
  const composing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // When it is reset from outside (closed), align the draft too.
  useEffect(() => setDraft(query), [query])
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div className="thread-filter">
      <input
        ref={inputRef}
        className="thread-filter-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder={t('threads.filter.placeholder')}
        aria-label={t('threads.filter.placeholder')}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          const isComposing = composing.current || (event.nativeEvent as InputEvent).isComposing === true
          if (shouldApplyFilter(isComposing)) setQuery(event.target.value)
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          setQuery(event.currentTarget.value)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // Esc during composition belongs to the IME (cancelling the composition).
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          if (draft === '' && query === '') setOpen(false)
          else {
            setDraft('')
            setQuery('')
          }
        }}
      />
      {draft !== '' ? (
        <Tooltip content={t('threads.filter.clear')}>
          <button
            type="button"
            className="icon-button thread-filter-clear"
            aria-label={t('threads.filter.clear')}
            onClick={() => {
              setDraft('')
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}

/**
 * Heading of a cwd-order group (items 152 / 193). The shape of "GROUP 1" in VS Code Open Editors (uppercase, letter
 * spacing, small bold, dim color, no count). Folder name plus the rainbow line (item 108). Unassigned (scratch area)
 * uses the dictionary name. There is no collapsing (owner decision). The title holds the full path (the renderer may
 * see paths, item 55). On hover / focus a "New" button (item 194) appears at the right end.
 */
function FolderHeading({
  item
}: {
  item: Extract<ThreadListItem, { kind: 'folder' }>
}): React.JSX.Element {
  const t = useT()
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const view = folderHeadingView(item, t, (uri) => (homeUri === '' ? null : displayPath(uri, homeUri)))
  return (
    <div className="thread-folder" style={rainbowStyle(item.rainbow)} {...{ [FOLDER_KEY_ATTR]: item.key }}>
      <span className="thread-folder-name" title={view.title} role="heading" aria-level={3}>
        {view.name}
      </span>
      {/* Create immediately (item 194). Tooltip (aligned with the heading and tree in items 255 / 260). Pressing it does not
          reach the heading / list (the drop target), and it cannot be pressed while creating; both are handled by `NewChatButton`. */}
      <NewChatButton uri={item.uri} className="thread-folder-new" label={view.createLabel} />
    </div>
  )
}

/**
 * TODO 972: the heading of a role (Teammate). The shape of a VS Code tree node: a chevron that folds / unfolds (remembered per window,
 * `roleStore.ts`), the name and the count. A folded heading carries the strongest mark of its rows (the same dots as a row). On the
 * right, "New conversation" (no dialog; main takes the folder and Model / Thinking from the role). The context menu also has
 * "Edit Teammate", which opens the editor in the ThreadPane's place.
 */
function RoleHeading({ item }: { item: Extract<ThreadListItem, { kind: 'role' }> }): React.JSX.Element {
  const t = useT()
  const toggle = useRoles((state) => state.toggleCollapsed)
  const openRole = useSchedule((state) => state.openRole)
  const createThreadInRole = useThreads((state) => state.createThreadInRole)
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()
  const [busy, setBusy] = useState(false)
  const create = (): void => {
    if (busy) return
    setBusy(true)
    void createThreadInRole(item.key).finally(() => setBusy(false))
  }
  const dotLabel = item.attention === 2 ? t('threads.awaiting') : t('threads.unread')
  return (
    <>
      <div
        className={`thread-role${item.collapsed ? ' collapsed' : ''}`}
        data-role-key={item.key}
        onContextMenu={(event) =>
          openMenu(event, [
            { key: 'new', label: t('roles.newThread'), onSelect: create },
            { key: 'edit', label: t('roles.edit'), onSelect: () => openRole(item.key) }
          ])
        }
      >
        <button
          type="button"
          className="thread-role-toggle"
          aria-expanded={!item.collapsed}
          aria-label={t('roles.toggle', { name: item.name })}
          onClick={() => toggle(item.key)}
        >
          <span className="thread-role-chevron" aria-hidden="true">
            {item.collapsed ? '▸' : '▾'}
          </span>
          <TeammateIcon size={12} />
          <span className="thread-role-name">{item.name}</span>
          <span className="thread-role-count">{item.count}</span>
        </button>
        {item.collapsed && item.attention > 0 ? (
          <span
            className={`thread-badge ${item.attention === 2 ? 'attention' : 'unread'}`}
            role="img"
            aria-label={dotLabel}
          />
        ) : null}
        <Tooltip content={t('roles.newThreadIn', { name: item.name })}>
          <button
            type="button"
            className="icon-button thread-role-new"
            aria-label={t('roles.newThreadIn', { name: item.name })}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              create()
            }}
          >
            <ComposeIcon />
          </button>
        </Tooltip>
      </div>
      <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </>
  )
}

/**
 * TODO 659: "Show more (N)" / "Collapse" for collapsed rows. Only one, at the end of the list (the shape of VS Code
 * Open Editors and Slack's "Show more"). It just toggles on each press; the state is not remembered.
 */
function MoreRow({
  count,
  expanded,
  onToggle
}: {
  count: number
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <button type="button" className="thread-list-more" onClick={onToggle}>
      {expanded ? t('threads.collapseOld') : t('threads.showMore', { count })}
    </button>
  )
}

/**
 * Per-row selector (item 75). Only the row replaced by `threadChanged` re-renders.
 * It is a `memo`, so a row whose props (`id` / `active`) are the same is not redrawn even if the order or selection changes.
 */
const ThreadRowById = memo(function ThreadRowById({
  id,
  active,
  sortKey,
  renameTick
}: {
  id: string
  active: boolean
  /** TODO 821: the F2 counter. When it increases, open the rename field (passed only to the selected row). */
  renameTick: number
  /**
   * How the list is arranged (item 152). `'cwd'` is a row inside a group (item 193): indented one step from the
   * heading, and the cwd name at the head of the row is not shown. Only `'recent'` puts "new chat in this folder"
   * next to the cwd name (TODO 488).
   */
  sortKey: ThreadSortKey
}): React.JSX.Element | null {
  const summary = useThreads((state) => state.threadsById[id])
  if (summary === undefined) return null
  return <ThreadRow summary={summary} active={active} sortKey={sortKey} renameTick={renameTick} />
})

export function ThreadRow({
  summary,
  active,
  sortKey,
  renameTick = 0
}: {
  summary: ThreadSummary
  active: boolean
  sortKey: ThreadSortKey
  renameTick?: number
}): React.JSX.Element {
  const grouped = sortKey === 'cwd'
  const selectThread = useThreads((state) => state.selectThread)
  const removeThread = useThreads((state) => state.removeThread)
  const renameThread = useThreads((state) => state.renameThread)
  const setThreadUnread = useThreads((state) => state.setThreadUnread)
  const moveThreadToRole = useThreads((state) => state.moveThreadToRole)
  const roleList = useRoles((state) => state.roles)
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()
  // TODO 526: a thread with neither a name nor an answer yet uses the first line of this window's Composer draft as a
  // provisional title. The selector returns a string (or null), so it re-renders only on keystrokes that change the title.
  const provisional = useThreads((state) => provisionalTitleOf(summary.thread, state.drafts[summary.thread.id]))
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(summary.thread.title)
  const startRename = (): void => {
    setTitle(summary.thread.title)
    setEditing(true)
  }
  // TODO 821: F2. On the first render it is 0 -> 0, so it does not open.
  const lastTick = useRef(renameTick)
  useEffect(() => {
    if (renameTick !== lastTick.current && renameTick > 0) startRename()
    lastTick.current = renameTick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTick])
  // When the scratch area (T19) has contents, main does not delete but returns a count. The confirmation is shown here.
  // TODO 577: `count: null` means the scratch area could not be read, so the count is unknown.
  const [confirmEntries, setConfirmEntries] = useState<{ count: number | null } | null>(null)

  const busy = busyOf(summary)
  const subtaskCount = summary.runtime.subtasks.length
  const mark = busy ? '' : (STATE_MARK[summary.runtime.state] ?? '')
  // Item 151: awaiting approval (2) > unread (1) > other (0). The title of a read thread is one step dimmer, but not while selected.
  const attention = attentionOf(summary)
  const badge = rowBadgeOf(summary)
  const pending = summary.runtime.pendingApprovals
  const awaitingLabel =
    pending > 0 ? t('threads.pending', { count: pending }) : t('threads.awaiting')
  const rowState =
    attention === 2 ? ' attention' : attention === 1 ? ' unread' : active ? '' : ' read'

  const remove = async (force: boolean): Promise<void> => {
    const result = await removeThread(summary.thread.id, force)
    // Not removed with 0 entries = failure (shown in the band). No confirmation is shown (TODO 577).
    if (!result.removed && result.scratchEntries !== 0) setConfirmEntries({ count: result.scratchEntries })
  }

  return (
    // Put ContextMenu outside the row's `div` (a sibling in the Fragment). A portal follows React's event propagation
    // through the component tree, not the DOM, so inside the row a click on a menu item would bubble up to the row's
    // `onClick` (selectThread) (TODO 741). Sidebar.tsx does the same (one outside the tree).
    <>
    <div
      className={`thread-row${active ? ' active' : ''}${rowState}${grouped ? ' grouped' : ''}`}
      // Rainbow color of the working directory (TODO 50 / 108). The vertical line at the left edge. Uses as is the number
      // (`thread.rainbow`) that main assigned in order of appearance and persisted. Unassigned (scratch area, TODO 58)
      // and no-cwd rows are already null on the main side.
      style={rainbowStyle(summary.thread.rainbow)}
      onClick={() => void selectThread(summary.thread.id)}
      onDoubleClick={startRename}
      // TODO 741: toggle unread / read. TODO 821: rename (the same field as double-click and F2).
      onContextMenu={(event) =>
        openMenu(event, [
          { key: 'rename', label: t('threads.rename'), onSelect: startRename },
          summary.thread.unread
            ? {
                key: 'mark-read',
                label: t('threads.markRead'),
                onSelect: () => void setThreadUnread(summary.thread.id, false)
              }
            : {
                key: 'mark-unread',
                label: t('threads.markUnread'),
                onSelect: () => void setThreadUnread(summary.thread.id, true)
              },
          // TODO 1288: move under a Teammate / take out. No submenu in this menu, so one row per Teammate. A running conversation and
          // one started by a scheduled run or a trigger are grayed (main refuses them too).
          ...teammateMenuItems(summary, roleList ?? NO_ROLES, t, (roleId) => void moveThreadToRole(summary.thread.id, roleId)),
          // TODO 818: the whole conversation to PDF. TODO 866: next to it, a single-file HTML.
          {
            key: 'export-pdf',
            label: t('exportPdf.thread'),
            onSelect: () => void exportThread(summary.thread.id, { kind: 'all' }, 'pdf')
          },
          {
            key: 'export-html',
            label: t('exportHtml.thread'),
            onSelect: () => void exportThread(summary.thread.id, { kind: 'all' }, 'html')
          },
          // TODO 1014: next to that, Markdown.
          {
            key: 'export-md',
            label: t('exportMd.thread'),
            onSelect: () => void exportThread(summary.thread.id, { kind: 'all' }, 'md')
          }
        ])
      }
    >
      {/* TODO 674: first line - cwd name (409) + pencil (488) + last-updated time (490). Rows that do not show the cwd name
          (inside a cwd-order group, scratch area, old rows with no cwd; `showsRowCwd`) do not render this at all (so they become 2 lines).
          The color is the folder's rainbow (`--thread-accent`, else `--fg-dim`); the text is small and dim. */}
      {showsRowCwd(sortKey, summary.thread.cwdName) ? (
        <div className="thread-row-meta">
          <span className="thread-row-cwd">{summary.thread.cwdName}</span>
          {/* TODO 488: only in recency order, "new chat in this folder" right after the cwd name. Shown only on hover and
              on the selected row (CSS). Pressing it does not reach row selection / rename (double click); the ledger
              against repeated presses is shared with the heading and tree; both are handled by `NewChatButton`. */}
          {showsRowNewChat(sortKey, summary.thread) ? (
            <NewChatButton
              uri={summary.thread.cwdUri}
              className="thread-row-new-chat"
              label={t('threads.newInFolder', { name: summary.thread.cwdName })}
            />
          ) : null}
          {/* TODO 490: last-updated time (the same `threadRecency` as the sort key). The right end of the first line. */}
          <RowTime at={threadRecency(summary.thread)} />
        </div>
      ) : null}
      {/* TODO 674: second line - the question (same weight and darkness as the current title). State mark -> title -> unread / awaiting-approval dot -> x. */}
      <div className="thread-row-top">
        {busy ? (
          <span className="state-spinner" role="status" aria-label={t('threads.busy')}>
            <Spinner className="in-row" />
          </span>
        ) : null}
        {subtaskCount > 0 ? (
          <Tooltip content={subtasksTooltip(subtaskCount, t)}>
            <span
              className="thread-row-subtasks"
              role="status"
              aria-label={subtasksTooltip(subtaskCount, t)}
            >
              {t('threadList.subtasks.badge', { count: subtaskCount })}
            </span>
          </Tooltip>
        ) : null}
        {mark !== '' ? <span className={`state-mark ${summary.runtime.state}`}>{mark}</span> : null}
        {editing ? (
          <input
            className="thread-rename"
            value={title}
            // A provisional title arrives as an empty string (TODO 66). If confirmed while empty, it stays provisional.
            placeholder={t('thread.untitled')}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => {
              setEditing(false)
              void renameThread(summary.thread.id, title)
            }}
            onKeyDown={(event) => {
              // TODO 939: Enter / Escape during IME composition are ignored (otherwise the confirming Enter would not save the title).
              const key = navKey(event)
              if (key === 'Enter') event.currentTarget.blur()
              if (key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <>
            {/* Thread branched by a rewind (item 113). */}
            {summary.thread.forkedFrom !== null ? (
              <span className="thread-row-fork" title={t('rewind.forkMark')}>⑂</span>
            ) : null}
            {/* Thread started by a scheduled run (TODO 323, wave 18 bundle A). */}
            {summary.thread.scheduledJobId !== undefined ? (
              <span
                className="thread-scheduled-mark"
                role="img"
                aria-label={t('threadList.scheduled')}
                title={t('threadList.scheduled')}
              >
                ⏰
              </span>
            ) : null}
            {/* Thread started by a trigger (TODO 1216). A sibling of the alarm clock, an icon rather than text. */}
            {summary.thread.triggerOrigin !== undefined ? (
              <span
                className="thread-trigger-mark"
                role="img"
                aria-label={t('threadList.triggered')}
                title={t('threadList.triggered')}
              >
                <TriggerIcon size={11} />
              </span>
            ) : null}
            {/* TODO 633 stage 1: the conversation moved to a worktree. The group stays the original repository; the row gets a small badge with the worktree name. */}
            {summary.thread.worktreeName !== undefined ? (
              <span
                className="thread-row-worktree"
                title={t('threadList.worktree', { name: summary.thread.worktreeName })}
              >
                ⎇ {summary.thread.worktreeName}
              </span>
            ) : null}
            {/* TODO 633: restored from deletion, but the cleaned-up worktree could not be recreated (back to the original cwd). Marker only. */}
            {summary.thread.worktreeLostName !== undefined ? (
              <span
                className="thread-row-worktree lost"
                title={t('threadList.worktreeLost', { name: summary.thread.worktreeLostName })}
              >
                ⎇ ✕
              </span>
            ) : null}
            {/* TODO 700: in a turn split off by a worktree, the main working copy was rewritten. No stopping, no asking - marker only. */}
            {summary.thread.outsideWriteAt !== undefined ? (
              <span
                className="thread-row-outside-write"
                role="img"
                aria-label={t('threadList.outsideWrite')}
                title={t('threadList.outsideWrite')}
              >
                ⚠
              </span>
            ) : null}
            {provisional !== null ? (
              <span className="thread-row-title provisional" title={t('threadList.provisionalTitle')}>
                {provisional}
              </span>
            ) : (
              <span className="thread-row-title">{threadTitleLabel(t, summary.thread.title)}</span>
            )}
          </>
        )}
        {attention === 2 ? (
          <span
            className="thread-badge attention"
            role="img"
            aria-label={awaitingLabel}
            title={awaitingLabel}
          >
            {pending > 0 ? pending : null}
          </span>
        ) : badge === 'interrupted' && summary.thread.interrupted !== undefined ? (
          // TODO 521: the answer stopped midway. Same place as the unread dot, and stronger than unread. Stays until resumed or the next normal turn.
          <span
            className="thread-badge interrupted"
            role="img"
            aria-label={t('threads.interrupted', { reason: interruptReasonLabel(summary.thread.interrupted, t) })}
            title={t('threads.interrupted', { reason: interruptReasonLabel(summary.thread.interrupted, t) })}
          >
            !
          </span>
        ) : attention === 1 ? (
          <span
            className="thread-badge unread"
            role="img"
            aria-label={t('threads.unread')}
            title={t('threads.unread')}
          />
        ) : null}
        <button
          type="button"
          className="thread-delete"
          // Item 64: deletion is a logical delete, and the conversation record stays in the DB (there is no restore UI).
          // We do not say "delete conversation log". Only its appearance in the list and the scratch-area files disappear.
          title={t('threads.delete')}
          onClick={(event) => {
            event.stopPropagation()
            void remove(false)
          }}
        >
          ×
        </button>
      </div>
      {confirmEntries !== null ? (
        <div className="thread-row-confirm" onClick={(event) => event.stopPropagation()}>
          {/* Scratch-area files are really deleted (unchanged by item 64). Only this cannot be taken back. */}
          <span>
            {confirmEntries.count === null
              ? t('threads.confirmScratchUnknown')
              : t('threads.confirmScratch', { count: confirmEntries.count })}
          </span>
          <button type="button" className="danger" onClick={() => void remove(true)}>
            {t('threads.confirmRemove')}
          </button>
          <button type="button" onClick={() => setConfirmEntries(null)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
      {/* TODO 674: third line - the answer (small, dim text). The leading `↳` is added by CSS `::before` (styles.css), so it
          is not included in copied / searched text. */}
      {summary.preview !== null ? (
        <div className="thread-row-preview">{summary.preview}</div>
      ) : null}
      {summary.runtime.pendingApprovals > 0 ? (
        <div className="thread-row-pending">
          {t('threads.pending', { count: summary.runtime.pendingApprovals })}
        </div>
      ) : null}
    </div>
    <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </>
  )
}

/**
 * Last-updated time at the right end of the row (TODO 490). One clock for the whole list (`row-time.ts`) is
 * subscribed, and on each tick only this small component re-renders (the row body and order do not move). The
 * tooltip is the OS `title` with the exact date and time (a text supplement, not an icon, so out of scope of 354).
 */
function RowTime({ at }: { at: number }): React.JSX.Element | null {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const now = useSyncExternalStore(subscribeRowClock, rowClockNow)
  const text = formatRowTime(at, now, locale, t)
  if (text === '') return null
  return (
    <span className="thread-row-time" title={formatExactDateTime(at, locale)}>
      {text}
    </span>
  )
}
