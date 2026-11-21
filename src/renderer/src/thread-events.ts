/**
 * How the renderer holds a thread's event list (item 88 / REVIEW D-1, ARCHITECTURE.md 5.1).
 * Pure functions that touch neither the DOM nor the store; `test/thread-events.test.ts` checks them directly.
 *
 * - **Drop deltas once the final version arrives** (D-1). `assistant_delta` / `thinking_delta` are only used to
 *   display what is being received, and `foldTimeline` (thread/timeline.ts) resets the in-flight string to empty as soon as
 *   any of `user_text` / `assistant_text` / `tool_use` / `result` arrives. Applying the same rule on the store side
 *   up front keeps deltas from piling up to several times the body in a long session (7x in spike 8).
 *   **The rendered result does not change** (only what fold already discards is dropped).
 * - Earlier pages fetched by "read more" (item 88) are prepended. Ids already present are not added.
 */
import type { AiosEvent, McpServerReport } from '@shared/agent.js'

/** The kinds after which fold resets the in-flight string to empty (same set as `thread/timeline.ts`). */
const RESETS_STREAMING: ReadonlySet<AiosEvent['kind']> = new Set([
  'user_text',
  'assistant_text',
  'tool_use',
  'result',
  // TODO 941: a new process. A half-written message from the previous process does not continue.
  'session_started'
])

/** Whether the event makes fold reset the in-flight string to empty. A terminating `error` (crash, forced kill) also does (TODO 941). */
function resetsStreaming(event: AiosEvent): boolean {
  if (event.kind === 'error') return event.payload.origin === 'exit'
  return RESETS_STREAMING.has(event.kind)
}

function isDelta(event: AiosEvent): boolean {
  return event.kind === 'assistant_delta' || event.kind === 'thinking_delta'
}

/**
 * Drops the deltas before the last "reset the in-flight text" event. If there is nothing to drop,
 * returns `events` as is (the reference does not change, so the selector does not re-render).
 */
export function dropSupersededDeltas(events: readonly AiosEvent[]): readonly AiosEvent[] {
  let lastReset = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (resetsStreaming(events[i]!)) {
      lastReset = i
      break
    }
  }
  if (lastReset <= 0) return events
  let any = false
  for (let i = 0; i < lastReset; i++) {
    if (isDelta(events[i]!)) {
      any = true
      break
    }
  }
  if (!any) return events
  return events.filter((event, i) => i >= lastReset || !isDelta(event))
}

/** Appends an arrived batch at the end (onEvents). Deltas that are already finalized are dropped here. */
export function appendEvents(
  current: readonly AiosEvent[],
  incoming: readonly AiosEvent[]
): readonly AiosEvent[] {
  if (incoming.length === 0) return current
  return dropSupersededDeltas([...current, ...incoming])
}

/**
 * The load on open (selectThread). Mixes the events that arrived while the thread was open, and are not in the DB,
 * into the DB rows. **Do not simply append them**: deltas are not persisted so they are not in the DB, and appending
 * would put them after the finalized body or result and leave an in-flight bubble. Re-sort by time
 * (JS sort is stable, so equal times keep the original order).
 */
export function mergeLoaded(
  loaded: readonly AiosEvent[],
  live: readonly AiosEvent[]
): readonly AiosEvent[] {
  const known = new Set(loaded.map((event) => event.id))
  const merged = [...loaded, ...live.filter((event) => !known.has(event.id))].sort(
    (a, b) => a.ts - b.ts
  )
  return dropSupersededDeltas(merged)
}

/** Prepends the earlier page from "read more". Ids already present are not added (guards against overlap at the boundary). */
export function prependOlder(
  current: readonly AiosEvent[],
  older: readonly AiosEvent[]
): readonly AiosEvent[] {
  if (older.length === 0) return current
  const known = new Set(current.map((event) => event.id))
  const fresh = older.filter((event) => !known.has(event.id))
  if (fresh.length === 0) return current
  return [...fresh, ...current]
}

/** The inputs of `keepsLiveEvents` (TODO 570). All of them mirror state in threadStore. */
export interface LiveKeepContext {
  /** Threads whose timeline is already loaded (`loaded`). */
  readonly loaded: ReadonlySet<string>
  /** Threads found to have an empty DB when opened (`retention = 'none'`) (`notPersisted`). */
  readonly notPersisted: ReadonlySet<string>
  /** Threads that `selectThread` is currently reading from the DB (what arrived meanwhile is mixed in by `mergeLoaded`). */
  readonly opening: ReadonlySet<string>
  /** `retention` of the list row (undefined if the row has not arrived yet: err on the side of keeping). */
  readonly retentionOf: (threadId: string) => string | undefined
}

/**
 * Whether to keep the rows pushed for that thread in `events` / `childEvents` (TODO 570, plan A).
 *
 * Rows of a thread that was never opened are not kept: they are read from the DB with `timeline()` on open so the
 * view does not change, and rows of background (scheduled, many) threads do not pile up for the whole life of the window.
 * Rows not kept are still used (by the caller) for the command list, MCP, and the `turnEnded` decision. The exception is
 * **a thread that is not in the DB** (`retention = 'none'`): it cannot be read on open, so it is kept even if never opened.
 * Rows are also kept while loading (`opening`) (`mergeLoaded` mixes them in).
 */
export function keepsLiveEvents(threadId: string, ctx: LiveKeepContext): boolean {
  return (
    ctx.loaded.has(threadId) ||
    ctx.opening.has(threadId) ||
    ctx.notPersisted.has(threadId) ||
    // If the list row has not arrived yet (e.g. another window right after creation), we cannot know whether it is persisted, so err on the side of keeping.
    (ctx.retentionOf(threadId) ?? 'none') === 'none'
  )
}

/**
 * TODO 1139: a list holding only the "in-flight deltas" for threads that are not open.
 *
 * Since 570 the rows themselves are no longer kept, but deltas are not persisted (the constraint 10 choke point `toPersistable`),
 * and on open `timeline()` returns only the DB. Opening a thread that was answering in the background made the body and thinking
 * start mid-sentence. So only deltas from after the last "reset the in-flight text" event are kept (they are dropped once the final
 * version arrives, so the amount is small). On open `mergeLoaded` mixes them into the DB rows. If nothing changes, returns `current` as is.
 */
export function liveDeltasOnly(
  current: readonly AiosEvent[],
  incoming: readonly AiosEvent[]
): readonly AiosEvent[] {
  let lastReset = -1
  for (let i = incoming.length - 1; i >= 0; i--) {
    if (resetsStreaming(incoming[i]!)) {
      lastReset = i
      break
    }
  }
  const base = lastReset >= 0 ? [] : current
  const tail = incoming.slice(lastReset + 1).filter(isDelta)
  if (tail.length === 0) return base.length === current.length ? current : base
  return [...base, ...tail]
}

/**
 * The command list reported last in the list (item 68). It is in the `session_started` payload, and if a replacement
 * while running (`commands_changed`, the rest of item 117) comes later, that one wins.
 * Old rows (saved before item 68) and versions that do not report it have no field, so undefined if none is found.
 */
export function lastCommands(events: readonly AiosEvent[]): readonly string[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'session_started' && Array.isArray(event.payload.commands)) {
      return event.payload.commands
    }
    if (event.kind === 'commands_changed' && event.actor === 'main') return event.payload.commands
  }
  return undefined
}

/**
 * The skill names reported by the last `session_started` (TODO 564). Rows without the field (old rows, versions that do not report it)
 * are skipped; undefined if none is found. `commands_changed` is not looked at because it does not say whether something is a skill.
 */
export function lastSkills(events: readonly AiosEvent[]): readonly string[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'session_started' && Array.isArray(event.payload.skills)) return event.payload.skills
  }
  return undefined
}

/** The MCP server list reported by the last `session_started` (item 110). Same shape as `lastCommands`. */
export function lastMcpServers(
  events: readonly AiosEvent[]
): { readonly servers: readonly McpServerReport[]; readonly gatewayConflict: boolean } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'session_started' && Array.isArray(event.payload.mcpServers)) {
      return { servers: event.payload.mcpServers, gatewayConflict: event.payload.gatewayConflict === true }
    }
  }
  return undefined
}
