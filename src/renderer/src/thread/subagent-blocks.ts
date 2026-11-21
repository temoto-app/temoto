/**
 * Subagent blocks (item 257, wave 15 bundle A, ARCHITECTURE.md 4.6.3 "blocks").
 * Pure functions that touch neither the DOM nor the store, checked directly by `test/subagent-blocks.test.ts`.
 *
 * - **Child rows are not mixed into the parent's event list; they are sorted and kept in a "block" per id (`parentToolUseId`) of the parent's
 *   `Agent` call** (`splitChildEvents`). Even when child rows arrive, the reference of the parent's list (`events[threadId]`)
 *   does not change, so ThreadPane (the whole timeline) is not redrawn. Only the component that pulls that block (`SubagentBlock`)
 *   is redrawn (item 88's "redraws are confined to components").
 * - An approval request (`permission_request`) is not a child row (it arrives as a parent row and has no field identifying the child, spike 19),
 *   but if its `toolUseId` points to a child's tool call, it goes into that block. In the earlier single list,
 *   `foldTimeline` attached the approval to that child's tool row, so this keeps the same appearance.
 * - The block's contents are folded with `foldTimeline` as is (all child rows have the same parent, so inside a block they
 *   line up flat. A grandchild, a child spawned by a child, becomes a separate block under the grandchild's parent id).
 * - By default shows **the latest few steps** (`RECENT_STEPS`) and "+N". Pressing it shows everything (`subagentBlockView`).
 *   If only one item would be hidden, it is not hidden (showing one row is shorter than showing a "+1" row. The same rule as VS Code's
 *   list of running children).
 */
import type { AiosEvent } from '@shared/agent.js'
import { foldTimeline, type FoldOptions, type TimelineItem } from './timeline.js'

/** Id of the parent's `Agent` call -> that child's rows (in arrival order). */
export type ChildBuckets = Readonly<Record<string, readonly AiosEvent[]>>

/** Make the empty default a module constant (writing `?? {}` inside a selector causes infinite re-rendering). */
export const NO_BUCKETS: ChildBuckets = Object.freeze({})
export const NO_CHILD_EVENTS: readonly AiosEvent[] = Object.freeze([])

/** The number of latest steps shown by default (the shape of VS Code's list of running children and the CLI's `+N more`). */
export const RECENT_STEPS = 3

export interface SplitEvents {
  /** What goes into the parent's list. If nothing was removed, it is the passed array itself (the reference does not change). */
  readonly main: readonly AiosEvent[]
  /** What goes into blocks. Per parent id, in arrival order. */
  readonly children: Readonly<Record<string, readonly AiosEvent[]>>
}

/** The block (parent id) that has that child's tool call. undefined if none. */
function ownerOf(
  toolUseId: string,
  sources: readonly Readonly<Record<string, readonly AiosEvent[]>>[]
): string | undefined {
  for (const source of sources) {
    for (const [parent, list] of Object.entries(source)) {
      for (const event of list) {
        if (event.kind === 'tool_use' && event.payload.toolUseId === toolUseId) return parent
      }
    }
  }
  return undefined
}

/**
 * Splits an event list into the parent's list and blocks. `existing` is the blocks already held (used to look up where an approval request goes).
 */
export function splitChildEvents(
  events: readonly AiosEvent[],
  existing: ChildBuckets = NO_BUCKETS
): SplitEvents {
  let main: AiosEvent[] | null = null
  const children: Record<string, AiosEvent[]> = {}
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    let parent = event.parentToolUseId
    if (parent === undefined && event.kind === 'permission_request' && event.payload.toolUseId !== null) {
      parent = ownerOf(event.payload.toolUseId, [children, existing])
    }
    if (parent === undefined) {
      main?.push(event)
      continue
    }
    // On the first removal, copy what came before to start building the parent's list.
    main ??= events.slice(0, i)
    const bucket = children[parent]
    if (bucket === undefined) children[parent] = [event]
    else bucket.push(event)
  }
  return { main: main ?? events, children }
}

/** Appends arrived child rows to the end of their block. Only touched blocks become new arrays; the others keep their reference. */
export function appendChildEvents(
  buckets: ChildBuckets,
  added: Readonly<Record<string, readonly AiosEvent[]>>
): ChildBuckets {
  const keys = Object.keys(added)
  if (keys.length === 0) return buckets
  const next: Record<string, readonly AiosEvent[]> = { ...buckets }
  for (const key of keys) next[key] = [...(buckets[key] ?? []), ...added[key]!]
  return next
}

/**
 * Mixes what arrived while open into the load on open (the DB's blocks). The same id counts once, and the result is re-sorted by time
 * (same rule as `mergeLoaded` in `thread-events.ts`; the sort is stable, so equal times keep the original order).
 */
export function mergeChildEvents(
  loaded: Readonly<Record<string, readonly AiosEvent[]>>,
  live: ChildBuckets
): ChildBuckets {
  const keys = new Set([...Object.keys(loaded), ...Object.keys(live)])
  if (keys.size === 0) return live
  const next: Record<string, readonly AiosEvent[]> = {}
  for (const key of keys) {
    const fromDb = loaded[key] ?? []
    const known = new Set(fromDb.map((event) => event.id))
    next[key] = [...fromDb, ...(live[key] ?? []).filter((event) => !known.has(event.id))].sort(
      (a, b) => a.ts - b.ts
    )
  }
  return next
}

/** Prepends the child rows of the earlier page from "read more" to the head of the block. Ids already present are not added. */
export function prependChildEvents(
  buckets: ChildBuckets,
  older: Readonly<Record<string, readonly AiosEvent[]>>
): ChildBuckets {
  let next: Record<string, readonly AiosEvent[]> | null = null
  for (const [key, list] of Object.entries(older)) {
    const current = buckets[key] ?? []
    const known = new Set(current.map((event) => event.id))
    const fresh = list.filter((event) => !known.has(event.id))
    if (fresh.length === 0) continue
    next ??= { ...buckets }
    next[key] = [...fresh, ...current]
  }
  return next ?? buckets
}

/**
 * Folds the block's contents. The child's messages and the child's tool calls (with results and approvals bundled) line up in arrival order.
 *
 * `options.live` is passed to `foldTimeline` as is (item 280-5 / wave 18). When that child has become Stopped / Failed,
 * or the whole thread's process is already gone, passing `{ live: false }` makes tool-call rows in the block that have no result yet
 * show "interrupted" instead of staying "running". The caller (`SubagentBlock.tsx`) decides it from that child's state.
 */
export function foldSubagentBlock(
  events: readonly AiosEvent[],
  options: FoldOptions = {}
): readonly TimelineItem[] {
  if (events.length === 0) return []
  return foldTimeline(events, options).items
}

export interface SubagentBlockView {
  /** The items shown (the latest few steps when folded). */
  readonly items: readonly TimelineItem[]
  /** The number of items folded away and hidden ("+N"). 0 when everything is shown. */
  readonly hidden: number
  /** The number of all items. */
  readonly total: number
  /** The number of the child's tool calls. */
  readonly toolUses: number
  /** Of those, the number that failed. */
  readonly failed: number
  /** Whether the fold / expand toggle is meaningful (it does not fit in the latest few steps). */
  readonly collapsible: boolean
}

/** How the block is shown. Everything if `expanded`, otherwise the latest `recent` steps and "+N". */
export function subagentBlockView(
  items: readonly TimelineItem[],
  expanded: boolean,
  recent = RECENT_STEPS
): SubagentBlockView {
  let toolUses = 0
  let failed = 0
  for (const item of items) {
    if (item.kind !== 'tool') continue
    toolUses += 1
    if (item.result !== null && !item.result.ok) failed += 1
  }
  const collapsible = items.length > recent + 1
  if (expanded || !collapsible) {
    return { items, hidden: 0, total: items.length, toolUses, failed, collapsible }
  }
  return {
    items: items.slice(items.length - recent),
    hidden: items.length - recent,
    total: items.length,
    toolUses,
    failed,
    collapsible
  }
}

/** The DOM id of the block (the destination of a jump from the list above the prompt box). */
export function subagentAnchorId(toolUseId: string): string {
  return `subagent-${toolUseId}`
}

/** Whether that message is in the block (if a jump from conversation search lands on a child's message, it expands even if folded). */
export function blockHasEvent(events: readonly AiosEvent[], eventId: string | null): boolean {
  if (eventId === null) return false
  return events.some((event) => event.id === eventId)
}
