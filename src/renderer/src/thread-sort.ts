/**
 * The display order of the thread list (item 152, ARCHITECTURE.md 4.3 "display sorting") and the
 * strength of the unread / awaiting-approval marks (item 151). Pure functions that touch neither the DOM nor the store, so
 * `test/thread-sort.test.ts` checks them directly.
 *
 * **The order that arrives from main (`threadOrder`) is always recent order** (`threadRecency`, item 83), and it is not
 * changed here. The display order is layered on top of it: both unread order and cwd order just "stably group the recent-order list",
 * so within a group it is in recent order without doing anything, and the order of folders (by the folder's newest
 * update) is the same as "the order of first appearance in the recent-order list". There is no code that re-sorts by time.
 *
 * **Do not re-sort on high-frequency pushes** (items 75 / 88). The inputs for ordering are pulled by the selector only as much as each
 * condition needs (`selectAttention` / `selectFolderThreads`). Both are arrays of per-row values and the
 * components take them with `useShallow`, so if only the cost or usage in `runtime` moves on `turn_usage`,
 * the elements are the same (the numbers, the same `thread` objects) -> the previous array is returned and the re-sorting `useMemo` does not run either.
 */
import { threadRecency, type Thread, type ThreadSummary } from '@shared/thread.js'
import { readString, safeStorage, writeString, type PrefStorage } from './uiPrefs.js'
import { DAY_MS } from './row-time.js'

/** The sort condition (owner decision 2026-09-27: only these 3. No creation order or title order). */
export type ThreadSortKey = 'recent' | 'unread' | 'cwd'

export const THREAD_SORT_KEYS: readonly ThreadSortKey[] = ['recent', 'unread', 'cwd']
export const DEFAULT_THREAD_SORT: ThreadSortKey = 'recent'

/**
 * The strength of a row's mark (item 151). **2 = awaiting approval / choice question** (like a Slack mention, stronger than unread),
 * **1 = unread**, 0 = other. Unread order groups by this, descending.
 */
export type Attention = 0 | 1 | 2

/**
 * The strength of the mark. Awaiting approval looks at both `runtime.pendingApprovals` (the pending count main counted; a choice
 * question is counted as the same approval request - T31) and `runtime.state` (so nothing is missed even in the gap when
 * one of them arrives first in a single-row delivery). The unread decision itself (item 71) is main's `thread.unread`.
 */
export function attentionOf(summary: Pick<ThreadSummary, 'thread' | 'runtime'> | undefined): Attention {
  if (summary === undefined) return 0
  if (summary.runtime.pendingApprovals > 0 || summary.runtime.state === 'awaiting-approval') return 2
  // TODO 521: an answer that stopped midway ("!") is counted with the same strength as unread (unread-order group, the Activity Bar dot).
  return summary.thread.unread || summary.thread.interrupted !== undefined ? 1 : 0
}

/**
 * A mark that keeps the selected row in its original group only while re-sorting (owner decision: "while selected, keep the row
 * in place. Re-sort when another thread is selected"). It prevents the row from jumping down because unread drops the moment
 * it is opened. `key` is the condition when the mark was taken; take it again when the condition is switched.
 */
export interface SortPin {
  readonly id: string
  readonly attention: Attention
  readonly key: ThreadSortKey
}

/** Takes the mark again if the selection or the condition changed. If the same, returns the previous mark as is (the same object). */
export function nextPin(
  previous: SortPin | null,
  activeId: string | null,
  activeAttention: Attention,
  key: ThreadSortKey
): SortPin | null {
  if (activeId === null) return null
  if (previous !== null && previous.id === activeId && previous.key === key) return previous
  return { id: activeId, attention: activeAttention, key }
}

/** An empty array for the selector (do not return a new array every time - React #185). */
const NO_ATTENTION: readonly Attention[] = []
const NO_THREADS: readonly (Thread | undefined)[] = []
const NO_COLLAPSIBLE: readonly boolean[] = []

/**
 * Input for unread order: the mark strength of each row in the (recent-order) list. A constant empty value when not in unread order.
 * Components take it with `useShallow` (it is an array of numbers, so elements can be compared with `Object.is`).
 */
export function selectAttention(
  key: ThreadSortKey,
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly Attention[] {
  if (key !== 'unread') return NO_ATTENTION
  return order.map((id) => attentionOf(byId[id]))
}

/**
 * Input for cwd order: the `thread` of each row in the list (it holds the cwd key, display name, and rainbow color). A constant empty value when not in cwd order.
 * `thread-index.ts` reuses a `thread` with the same contents, so the elements stay the same when only `runtime` changes.
 */
export function selectFolderThreads(
  key: ThreadSortKey,
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly (Thread | undefined)[] {
  if (key !== 'cwd') return NO_THREADS
  return order.map((id) => byId[id]?.thread)
}

/** The minimal shape used for sorting. Tests build this without `window.aios`. */
export interface SortRow {
  readonly id: string
  readonly attention: Attention
  /** The group key. The no-folder group (scratch area, `cwdName === ''`) is gathered into one group under the empty string. */
  readonly folderKey: string
  readonly folderName: string
  readonly folderUri: string | null
  readonly rainbow: number | null
  /** TODO 659: a row with no activity for 5+ days that has no mark and is neither running nor selected. A target for collapsing. */
  readonly collapsible: boolean
}

/** TODO 956: the attribute put on the cwd-order heading's DOM (for finding the scroll target). */
export const FOLDER_KEY_ATTR = 'data-folder-key'

/** The key of the no-folder group. */
export const NO_FOLDER_KEY = ''

/** Takes the group info from a `Thread`. The scratch area (empty `cwdName`) is gathered into no-folder (T19 / item 62). */
export function folderOf(thread: Thread | undefined): Pick<SortRow, 'folderKey' | 'folderName' | 'folderUri' | 'rainbow'> {
  if (thread === undefined || thread.cwdName === '') {
    return { folderKey: NO_FOLDER_KEY, folderName: '', folderUri: null, rainbow: null }
  }
  return {
    folderKey: thread.cwdUri,
    folderName: thread.cwdName,
    folderUri: thread.cwdUri,
    rainbow: thread.rainbow
  }
}

/** Builds sort rows from the selector results (only what the condition needs). Fields not needed get defaults. */
export function toSortRows(
  order: readonly string[],
  attention: readonly Attention[],
  threads: readonly (Thread | undefined)[],
  collapsible: readonly boolean[] = NO_COLLAPSIBLE
): SortRow[] {
  return order.map((id, i) => ({
    id,
    attention: attention[i] ?? 0,
    collapsible: collapsible[i] ?? false,
    ...folderOf(threads[i])
  }))
}

/**
 * TODO 659: input for collapsing threads with no activity for 5+ days (setting, default 5) out of the list. If `collapseDays <= 0` (= the setting says do not collapse),
 * a constant empty value (so the selection / selector cost is not paid). Rows with a mark (awaiting approval, unread, interrupted "!", not idle) are
 * not collapsed however old they are. **The time is the list's single clock (`now` in `row-time.ts`)**: a row moving to the collapsed side
 * across a day boundary is done by the same clock (same convention as the row time display).
 *
 * **The exemption for the selected row applies only while it is collapsed (`expanded === false`)** (a code-review fix). If you expand and
 * select an old row inside "show more", exempting it would make `arrangeThreads` move that row back to the non-collapsed side (before the tail),
 * and the row would jump to the upper part of the list; then selecting another row moves it back to its old position. This is the same kind of jump that
 * `SortPin` prevents. While expanded, selecting does not change the position (it stays collapsible = stays in the order of the collapsed side).
 */
export function selectCollapsible(
  collapseDays: number,
  now: number,
  activeThreadId: string | null,
  expanded: boolean,
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly boolean[] {
  if (collapseDays <= 0) return NO_COLLAPSIBLE
  const cutoff = now - collapseDays * DAY_MS
  return order.map((id) => {
    if (!expanded && id === activeThreadId) return false
    const summary = byId[id]
    if (summary === undefined) return false
    if (attentionOf(summary) > 0) return false
    // code-review fix: not only `running` but everything other than `idle` (`starting` / `stopping` / `error` too) is
    // not collapsed, so a row that stopped with an error is not hidden just because it is old.
    if (summary.runtime.state !== 'idle') return false
    return threadRecency(summary.thread) < cutoff
  })
}

/**
 * TODO 659 (a code-review fix): the next time a boundary is crossed (the smallest `threadRecency + collapseDays*DAY_MS` after now).
 * Looks only at the same "rows that can become collapse targets" as `selectCollapsible` (no mark, `idle`), and finds the smallest boundary
 * among rows still before the cutoff (= not yet collapsed). This is the input for **a design with a single timer set only for that time**: instead of scanning
 * all threads and re-rendering every 30 seconds, it is enough to take `now` again once at the moment a boundary is hit. If there is no matching row,
 * `null` (no timer needed: other changes are re-rendered directly by store updates).
 */
export function nextCollapseBoundary(
  collapseDays: number,
  now: number,
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): number | null {
  if (collapseDays <= 0) return null
  const spanMs = collapseDays * DAY_MS
  let min: number | null = null
  for (const id of order) {
    const summary = byId[id]
    if (summary === undefined) continue
    if (attentionOf(summary) > 0) continue
    if (summary.runtime.state !== 'idle') continue
    const boundary = threadRecency(summary.thread) + spanMs
    if (boundary <= now) continue // already past the cutoff (already a collapse target)
    if (min === null || boundary < min) min = boundary
  }
  return min
}

/** One display item: a thread row, a cwd-order folder sub-heading, the collapse "show more" row, or a role (Teammate) heading (TODO 972). */
export type ThreadListItem =
  /** `inRole`: a row under a role heading (TODO 972; drawn indented like a row inside a cwd group). */
  | { readonly kind: 'thread'; readonly id: string; readonly inRole?: true }
  | {
      readonly kind: 'role'
      /** The role's id. */
      readonly key: string
      readonly name: string
      /** The number of the role's conversations in the list (after filtering). */
      readonly count: number
      /** Folded in this window: only the selected row (if it is one of the role's) stays visible under the heading. */
      readonly collapsed: boolean
      /** The strongest mark among the role's rows (for the dot on a folded heading). */
      readonly attention: Attention
    }
  | {
      readonly kind: 'folder'
      readonly key: string
      /** An empty string means no-folder (scratch area). The display name comes from the renderer's dictionary. */
      readonly name: string
      readonly uri: string | null
      readonly rainbow: number | null
      readonly count: number
    }
  /** TODO 659: "Show more (N)" for the collapsed rows. Only one, at the end of the list. Expansion is held by the caller (`expanded`). */
  | { readonly kind: 'more'; readonly count: number }

/**
 * TODO 659: moves collapse targets (`row.collapsible`) to the end of the list. Common to `recent` / `unread` (there are no
 * folders, so it is per row). If `expanded`, the collapsed rows are also listed as they are after "show more" (the order is kept).
 */
function foldCollapsible(rows: readonly SortRow[], expanded: boolean): ThreadListItem[] {
  const visible: SortRow[] = []
  const hidden: SortRow[] = []
  for (const row of rows) (row.collapsible ? hidden : visible).push(row)
  const items: ThreadListItem[] = visible.map((row) => ({ kind: 'thread', id: row.id }))
  if (hidden.length > 0) {
    items.push({ kind: 'more', count: hidden.length })
    if (expanded) for (const row of hidden) items.push({ kind: 'thread', id: row.id })
  }
  return items
}

/**
 * TODO 659 (cwd order): if **all** rows of a group are collapse targets, moves the group with its heading to the end ("a folder with only old rows").
 * If even one row is not collapsed, the group is shown as is (individual rows inside a group are not collapsed; only whole folders are).
 */
function foldCwdGroups(
  keys: readonly string[],
  groups: ReadonlyMap<string, readonly SortRow[]>,
  expanded: boolean,
  keepFolderKey: string | null = null
): ThreadListItem[] {
  const visible: ThreadListItem[] = []
  const hidden: ThreadListItem[] = []
  let hiddenCount = 0
  for (const k of keys) {
    const group = groups.get(k)!
    // The heading's name and color come from the group's first row (the same cwd should give the same values).
    const head = group[0]!
    const heading: ThreadListItem = {
      kind: 'folder',
      key: k,
      name: head.folderName,
      uri: head.folderUri,
      rainbow: head.rainbow,
      count: group.length
    }
    // TODO 956: the group of the selected thread's folder is not collapsed (so it is not hidden inside "show more").
    const target = k !== keepFolderKey && group.every((row) => row.collapsible) ? hidden : visible
    target.push(heading)
    for (const row of group) target.push({ kind: 'thread', id: row.id })
    if (target === hidden) hiddenCount += group.length
  }
  if (hiddenCount === 0) return visible
  visible.push({ kind: 'more', count: hiddenCount })
  if (expanded) visible.push(...hidden)
  return visible
}

/**
 * The display order. `rows` must be in recent order (main's order).
 *
 * - `recent`: as is.
 * - `unread`: awaiting approval -> unread -> other. Recent order within a group. The `pin` row stays in the group it was in when the mark was taken.
 * - `cwd`: groups per working folder. Folders are ordered by newest update (= the order of first appearance in the recent-order list),
 *   and no-folder goes last. One sub-heading per group (no collapse - owner decision).
 *
 * TODO 659: rows that are `row.collapsible` (no activity for 5+ days and no mark) go, under any sort, to "Show more (N)" at the end of the list
 * (and if `expanded` is true, the collapsed rows follow after it).
 *
 * TODO 956: `keepFolderKey` (cwd order only) is the key of the selected thread's folder. That group is not collapsed even if it has only old rows.
 * The order itself is not changed (on the display side ThreadList scrolls to that heading).
 */
export function arrangeThreads(
  key: ThreadSortKey,
  rows: readonly SortRow[],
  pin: SortPin | null = null,
  expanded = false,
  keepFolderKey: string | null = null
): ThreadListItem[] {
  if (key === 'unread') {
    const buckets: [SortRow[], SortRow[], SortRow[]] = [[], [], []]
    for (const row of rows) {
      const attention = pin !== null && pin.key === 'unread' && pin.id === row.id ? pin.attention : row.attention
      buckets[2 - attention]!.push(row)
    }
    return foldCollapsible(buckets.flat(), expanded)
  }
  if (key === 'cwd') {
    const groups = new Map<string, SortRow[]>()
    for (const row of rows) {
      const group = groups.get(row.folderKey)
      if (group === undefined) groups.set(row.folderKey, [row])
      else group.push(row)
    }
    const keys = [...groups.keys()].filter((k) => k !== NO_FOLDER_KEY)
    if (groups.has(NO_FOLDER_KEY)) keys.push(NO_FOLDER_KEY)
    return foldCwdGroups(keys, groups, expanded, keepFolderKey)
  }
  return foldCollapsible(rows, expanded)
}

/**
 * TODO 972: input for the role (Teammate) grouping: the `roleId` of each row in the (recent-order) list. An array of strings (and
 * undefined), so components take it with `useShallow`; it moves only when a conversation joins or leaves a role.
 */
export function selectRoleIds(
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly (string | undefined)[] {
  return order.map((id) => byId[id]?.thread.roleId)
}

/**
 * TODO 972: the strength of the mark of each row that belongs to a role (0 for the others). For the dot on a folded role heading;
 * looked at under every sort key (unlike `selectAttention`, which only unread order needs).
 */
export function selectRoleAttention(
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly Attention[] {
  return order.map((id) => {
    const summary = byId[id]
    return summary?.thread.roleId === undefined ? 0 : attentionOf(summary)
  })
}

/** One row that belongs to a role, in recent order (TODO 972). */
export interface RoleRow {
  readonly id: string
  readonly roleId: string
  readonly attention: Attention
}

/**
 * TODO 972: the role (Teammate) headings and their rows, placed **above** the ordinary list (conversations without a role are arranged as
 * before by `arrangeThreads`). `rows` must be in recent order and contain only rows of known roles.
 *
 * - The groups are ordered by their newest conversation (= first appearance in the recent-order list); roles that have no conversation
 *   (yet) follow in the order of `roles`, so that a new Teammate's heading (and its "New conversation") is visible at once. With
 *   `includeEmpty` false (while filtering) empty roles are left out.
 * - Inside a group: recent order, under any sort key. A group's rows are never moved into "show more" (659) - folding the heading is the
 *   way to hide them.
 * - A folded heading (`collapsed`) keeps only the selected row visible, so the conversation the user is in does not vanish from the list.
 */
export function arrangeRoleGroups(
  roles: readonly { readonly id: string; readonly name: string }[],
  rows: readonly RoleRow[],
  collapsed: ReadonlySet<string>,
  activeId: string | null,
  includeEmpty = true
): ThreadListItem[] {
  const groups = new Map<string, RoleRow[]>()
  for (const row of rows) {
    const group = groups.get(row.roleId)
    if (group === undefined) groups.set(row.roleId, [row])
    else group.push(row)
  }
  const byId = new Map(roles.map((role) => [role.id, role]))
  const keys = [...groups.keys()].filter((key) => byId.has(key))
  if (includeEmpty) for (const role of roles) if (!groups.has(role.id)) keys.push(role.id)
  const items: ThreadListItem[] = []
  for (const key of keys) {
    const role = byId.get(key)!
    const group = groups.get(key) ?? []
    const folded = collapsed.has(key)
    let attention: Attention = 0
    for (const row of group) if (row.attention > attention) attention = row.attention
    items.push({ kind: 'role', key, name: role.name, count: group.length, collapsed: folded, attention })
    for (const row of group) {
      if (folded && row.id !== activeId) continue
      items.push({ kind: 'thread', id: row.id, inRole: true })
    }
  }
  return items
}

/** The `localStorage` key. Same origin, so it is shared by all windows. */
export const THREAD_SORT_KEY = 'aios.threadSort'

function isSortKey(value: string): value is ThreadSortKey {
  return (THREAD_SORT_KEYS as readonly string[]).includes(value)
}

/** Reads the saved condition. In an environment where it cannot be read, or on a broken value, falls back to the default (recent order). */
export function loadThreadSort(storage: PrefStorage | undefined = safeStorage()): ThreadSortKey {
  const raw = readString(storage, THREAD_SORT_KEY, isSortKey)
  return raw !== undefined && isSortKey(raw) ? raw : DEFAULT_THREAD_SORT
}

/** Saves the condition. Failures are ignored (it is a visual setting, so there is no reason to fail). */
export function saveThreadSort(key: ThreadSortKey, storage: PrefStorage | undefined = safeStorage()): void {
  writeString(storage, THREAD_SORT_KEY, key)
}

/** Reads a condition changed in another window (`newValue` of the `storage` event). Null for an unrelated value. */
export function parseThreadSort(raw: string | null): ThreadSortKey | null {
  return raw !== null && isSortKey(raw) ? raw : null
}

/**
 * The strongest mark in the whole list (item 151 part 3: the dot on the Activity Bar "Threads"). Returns a number,
 * so it can be used directly as a selector (creates no new value). Stops once an awaiting-approval is found.
 */
export function maxAttention(
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): Attention {
  let max: Attention = 0
  for (const id of order) {
    const attention = attentionOf(byId[id])
    if (attention === 2) return 2
    if (attention > max) max = attention
  }
  return max
}

/**
 * The "answering" states (TODO 45). Awaiting approval is not included: it is stopped (not running), so it is treated separately.
 */
const BUSY_STATES: ReadonlySet<string> = new Set(['starting', 'running', 'stopping'])

/**
 * Item 322 / TODO 1097 / 1196: the "is working" decision shared by the list row spinner and the Activity Bar blinking =
 * **all the AI's work tied to the conversation** (Working). In addition to the parent's turn (`BUSY_STATES`), true if there is a subagent
 * still running in the background after the parent returns to `idle` (`runtime.subtasks`, item 93) or an external process the AI sent to the
 * background (`runtime.backgroundShells`, TODO 1196: a background Bash, or a long command moved to the background after a timeout).
 * Awaiting approval / awaiting an answer (`awaiting-approval`) does not spin even if background work remains: it is the user's turn, so
 * it is left to another mark (the awaiting-approval dot, `attentionOf`).
 * main cuts the number of background shells at the time limit (same as eviction) before delivering, so even work that never ends does not spin forever.
 */
export function busyOf(summary: {
  readonly runtime: {
    readonly state: string
    readonly subtasks: readonly unknown[]
    readonly backgroundShells?: number
  }
}): boolean {
  const runtime = summary.runtime
  if (runtime.state === 'awaiting-approval') return false
  return BUSY_STATES.has(runtime.state) || runtime.subtasks.length > 0 || (runtime.backgroundShells ?? 0) > 0
}

/**
 * TODO 528 / 1097: true if any one is working (`busyOf`).
 * Used for the blinking of the Activity Bar Threads icon. It returns a bool, not a count, so even used in a selector
 * it does not re-render on a fluctuation like "2 became 1". It is shown regardless of mode, so
 * do not mix in a decision like `hidden` ("is the list visible") on the caller side.
 */
export function anyThreadRunning(
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): boolean {
  for (const id of order) {
    const summary = byId[id]
    if (summary !== undefined && busyOf(summary)) return true
  }
  return false
}
