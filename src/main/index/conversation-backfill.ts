/**
 * Importing conversation events at startup (item 76, ARCHITECTURE.md 6.2.3).
 *
 * It used to re-send **every** indexable `thread_events` row (up to 100,000) to the index process on each
 * startup. The index process asked main back for the body of each event (reverse RPC), and main ran one
 * JOIN per request, so the more conversations grew, the heavier main got 3 seconds after startup.
 *
 * Now the **high-water mark of `thread_events` `rowid`** is kept in `app_settings`, and only rows after it
 * are sent. Conversation indexing is normally done on the spot by `SessionManager.flush` -> `indexEvents`,
 * so the startup import is only "insurance against missed events": events flushed while the index process
 * was restarting or just before shutdown.
 *
 * The insurance re-send of everything is kept too, but only **every 7 days** (the same interval as the deep
 * scan, 6.2.2). Even when sending everything, the index process's upsert returns `needsContent = false` for
 * events that are already indexed, so bodies are not asked for again - the cost is only the upsert
 * (second half of item 76).
 *
 * Does not touch electron. main's `index.ts` passes in the ThreadStore / IndexClient / settings.
 */

import { CONVERSATION_HIGH_WATER, CONVERSATION_LAST_FULL } from '../../common/settings-keys.js'

/**
 * The last `thread_events.rowid` the index process finished processing, and the time (ms) when everything
 * was last sent. **The key strings live only in `src/common/settings-keys.ts`** (TODO 85) - this is a
 * re-export kept for compatibility with existing callers (including tests).
 */
export const CONVERSATION_HIGH_WATER_KEY = CONVERSATION_HIGH_WATER.key
export const CONVERSATION_LAST_FULL_KEY = CONVERSATION_LAST_FULL.key
/** Interval between full re-sends: 7 days, the same as the deep scan (the default of `scan.deepIntervalMs`). */
export const CONVERSATION_FULL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Number of rows sent per RPC. The SQL running on main's JS thread is only one page at a time
 * (a `rowid` range query, so one read proportional to the row count).
 */
export const CONVERSATION_BACKFILL_PAGE = 2000

export type BackfillReason = 'first' | 'reset' | 'interval' | 'incremental'

export interface BackfillPlan {
  readonly sinceRowid: number
  /** Whether this is a full re-send. When it completes, `CONVERSATION_LAST_FULL_KEY` is written. */
  readonly full: boolean
  readonly reason: BackfillReason
}

/**
 * Decides what to send (pure function).
 *
 * - No high-water mark and no previous full send -> everything (`first`; includes the first launch after
 *   upgrading to this version)
 * - The high-water mark is above the maximum `rowid` of `thread_events` -> everything (`reset`).
 *   `thread_events` has no `INTEGER PRIMARY KEY`, so `rowid` is reused when the last rows are deleted.
 *   Right after all conversation logs are deleted, it starts again from 1.
 * - At least `intervalMs` since the previous full send (or the clock went backwards) -> everything (`interval`)
 * - Otherwise -> only rows after the high-water mark (`incremental`)
 */
export function planConversationBackfill(input: {
  readonly highWater: number | null
  readonly lastFull: number | null
  readonly maxRowid: number
  readonly now: number
  readonly intervalMs?: number
}): BackfillPlan {
  const interval = input.intervalMs ?? CONVERSATION_FULL_INTERVAL_MS
  if (input.highWater === null || input.lastFull === null) {
    return { sinceRowid: 0, full: true, reason: 'first' }
  }
  if (input.highWater > input.maxRowid) return { sinceRowid: 0, full: true, reason: 'reset' }
  if (input.now - input.lastFull >= interval || input.now < input.lastFull) {
    return { sinceRowid: 0, full: true, reason: 'interval' }
  }
  return { sinceRowid: input.highWater, full: false, reason: 'incremental' }
}

export interface BackfillEvent {
  readonly rowid: number
  readonly id: string
  readonly threadId: string
  readonly ts: number
  readonly label: string
}

export interface BackfillDeps {
  /** `ThreadStore.indexableEvents` (keyset paging in rowid order). */
  readonly events: (sinceRowid: number, limit: number) => readonly BackfillEvent[]
  /** `ThreadStore.eventRowidCeiling`. */
  readonly maxRowid: () => number
  /**
   * Sends to the index process and **waits until it has finished processing**. Returns how many rows from
   * the start were processed (`IndexClient.backfillConversationEvents`).
   */
  readonly send: (
    events: readonly { id: string; threadId: string; title: string; ts: number }[]
  ) => Promise<number>
  readonly settings: {
    readInteger(key: string): number | null
    write(key: string, value: string): void
  }
  /** Whether shutdown has started. Once it has, nothing is sent and no setting is written (12.9). */
  readonly isClosing: () => boolean
  readonly now?: () => number
  readonly intervalMs?: number
  readonly pageSize?: number
}

export interface BackfillResult {
  readonly plan: BackfillPlan
  readonly sent: number
  /** Whether everything was sent to the end. If it stopped midway, the high-water mark only advances that far. */
  readonly complete: boolean
}

/**
 * Runs the import once. **The high-water mark advances page by page, only by what the index process has
 * finished processing** - if it advanced merely on sending, a crash of the index process or an overlapping
 * shutdown would let missed events slip past the insurance too.
 */
export async function runConversationBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = (deps.now ?? Date.now)()
  const plan = planConversationBackfill({
    highWater: deps.settings.readInteger(CONVERSATION_HIGH_WATER_KEY),
    lastFull: deps.settings.readInteger(CONVERSATION_LAST_FULL_KEY),
    maxRowid: deps.maxRowid(),
    now,
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs })
  })
  const pageSize = deps.pageSize ?? CONVERSATION_BACKFILL_PAGE
  let cursor = plan.sinceRowid
  let sent = 0
  for (;;) {
    if (deps.isClosing()) return { plan, sent, complete: false }
    const page = deps.events(cursor, pageSize)
    if (page.length === 0) break
    const handled = await deps.send(
      page.map((event) => ({
        id: event.id,
        threadId: event.threadId,
        title: event.label,
        ts: event.ts
      }))
    )
    if (deps.isClosing()) return { plan, sent: sent + handled, complete: false }
    const last = handled > 0 ? page[Math.min(handled, page.length) - 1] : undefined
    if (last !== undefined) {
      cursor = last.rowid
      deps.settings.write(CONVERSATION_HIGH_WATER_KEY, String(cursor))
    }
    sent += handled
    // The index process stopped midway (shutdown). The rest is done at the next launch.
    if (handled < page.length) return { plan, sent, complete: false }
  }
  // Write the high-water mark even for a full pass with no rows (otherwise every launch would be `first`).
  // On a `reset` pass, this is where the high-water mark is written back to a lower value.
  deps.settings.write(CONVERSATION_HIGH_WATER_KEY, String(cursor))
  if (plan.full) deps.settings.write(CONVERSATION_LAST_FULL_KEY, String(now))
  return { plan, sent, complete: true }
}
