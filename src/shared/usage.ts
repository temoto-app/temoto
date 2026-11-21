/**
 * Latest values of the usage limits (5 hours / 7 days) (item 317, ARCHITECTURE.md 12.2).
 *
 * These are **per account**, so there is one for the whole app (the latest one), not per thread. Main picks them up from
 * `rate_limit` events (`src/main/usage.ts`), distributes them to all windows, and keeps them in `app_settings`
 * (to show right after launch as an "n minutes ago" value). It holds only numbers and times, no body text (constraints 9 / 10).
 *
 * This is a **ratio against the plan limit**, the same information as the CLI's `/usage`. It is not cost: cost is
 * not shown (item 165, the note under constraint 4).
 */
import type { UsageWindow } from './agent.js'

export interface UsageSnapshot {
  readonly fiveHour?: UsageWindow
  readonly sevenDay?: UsageWindow
  /**
   * Fable's weekly window (TODO 1000). It comes only on Fable turn rows, so other turns do not clear it and the last value is kept.
   * Not shown in the badge (BottomBar); only in the details (floating panel, settings).
   */
  readonly sevenDayFable?: UsageWindow
  /** Time `sevenDayFable` was received (epoch ms). If old, shown as "n minutes ago". */
  readonly sevenDayFableReceivedAt?: number
  /** Backend status name (`allowed` / `allowed_warning` / `rejected` ...). */
  readonly status: string
  /** Whether it has switched to pay-as-you-go for usage beyond the limit. */
  readonly usingOverage: boolean
  /** Time main received this value (epoch ms). */
  readonly receivedAt: number
}

/** States shown in a warning color (`allowed_warning` / `rejected`, or switched to pay-as-you-go). */
export function usageNeedsAttention(snapshot: Pick<UsageSnapshot, 'status' | 'usingOverage'>): boolean {
  return snapshot.status === 'allowed_warning' || snapshot.status === 'rejected' || snapshot.usingOverage
}

/**
 * Whether the usage limit is reached now (TODO 633 stage 3: a guide for not starting new bundle conversations). True when the status is `rejected`
 * (including rejections that do not show up in a window's utilization, such as a refused switch to pay-as-you-go). But false if there is an exhausted window (utilization 1 or more)
 * and all its reset times have passed, so even if a stale value remains it becomes false after the window resets.
 */
export function usageLimitReached(snapshot: UsageSnapshot | null, nowMs: number): boolean {
  if (snapshot === null || snapshot.status !== 'rejected') return false
  const exhausted = [snapshot.fiveHour, snapshot.sevenDay].filter(
    (window): window is UsageWindow => window !== undefined && window.utilization >= 1
  )
  if (exhausted.length === 0) return true
  return exhausted.some((window) => window.resetsAt === null || window.resetsAt * 1000 > nowMs)
}

function readWindow(value: unknown): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const utilization = record['utilization']
  const resetsAt = record['resetsAt']
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return undefined
  return {
    utilization,
    resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null
  }
}

/**
 * Read a value from outside (saved JSON, IPC) as a `UsageSnapshot`. null if the shape is wrong.
 * Also null when there is no window at all (nothing to show).
 */
export function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const receivedAt = record['receivedAt']
  const status = record['status']
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return null
  if (typeof status !== 'string') return null
  const fiveHour = readWindow(record['fiveHour'])
  const sevenDay = readWindow(record['sevenDay'])
  const sevenDayFable = readWindow(record['sevenDayFable'])
  const fableAt = record['sevenDayFableReceivedAt']
  const fableValid = sevenDayFable !== undefined && typeof fableAt === 'number' && Number.isFinite(fableAt)
  if (fiveHour === undefined && sevenDay === undefined) return null
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(fableValid ? { sevenDayFable, sevenDayFableReceivedAt: fableAt } : {}),
    status,
    usingOverage: record['usingOverage'] === true,
    receivedAt
  }
}
