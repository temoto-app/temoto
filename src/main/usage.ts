/**
 * Aggregation of the latest usage-limit values (5 hours / 7 days) (item 317, wave 17 bundle B, ARCHITECTURE.md 12.2).
 *
 * - It is **per account**, so the whole app holds the latest one, not one per thread. A `rate_limit` from any thread
 *   overwrites it (in order of arrival; the time is the time we received it).
 * - A `rate_limit` with no usage rate (`windows`) (from an old version of the backend) is ignored — there is nothing to show.
 * - Each time one is received it is saved to `app_settings` (`usage.lastSnapshot`, owner is main), and right after launch
 *   it is shown from there as a value "n minutes ago". **Numbers and times only** (no body, constraints 9 / 10).
 * - On change, `onChanged` (a push to all windows). Independent of electron (`usage-ipc.ts` connects it to ipcMain).
 *
 * This is a ratio against the plan's limit, not a cost (cost is not shown — item 165).
 */
import type { AiosEvent, AiosEventBatch } from '@shared/agent.js'
import type { UsageSnapshot } from '@shared/usage.js'
import type { AppSettingsStore } from '../common/settings.js'
import { USAGE_LAST_SNAPSHOT } from '../common/settings-keys.js'

export class UsageTracker {
  private current: UsageSnapshot | null

  constructor(
    private readonly settings: Pick<AppSettingsStore, 'readTyped' | 'writeTyped'>,
    private readonly onChanged: (snapshot: UsageSnapshot) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.current = settings.readTyped(USAGE_LAST_SNAPSHOT)
  }

  get(): UsageSnapshot | null {
    return this.current
  }

  /** Pass SessionManager's `onEvents` batch as it is. Only `rate_limit` is looked at. */
  observe(batch: AiosEventBatch): void {
    let latest: Extract<AiosEvent, { kind: 'rate_limit' }> | null = null
    // The last row in the batch that has sevenDayFable (do not discard a newer value from an earlier row just because the last row lacks it).
    let fableWindow: NonNullable<UsageSnapshot['sevenDayFable']> | undefined
    for (const event of batch.events) {
      if (event.kind === 'rate_limit' && event.payload.windows !== undefined) {
        latest = event
        if (event.payload.windows.sevenDayFable !== undefined) fableWindow = event.payload.windows.sevenDayFable
      }
    }
    if (latest === null) return
    const { windows, status, usingOverage } = latest.payload
    if (windows === undefined || (windows.fiveHour === undefined && windows.sevenDay === undefined)) return
    const receivedAt = this.now()
    // The Fable weekly window arrives only on rows of Fable turns (TODO 1000). If it did not arrive, keep the previous value and the time it was received.
    const fable =
      fableWindow !== undefined
        ? { sevenDayFable: fableWindow, sevenDayFableReceivedAt: receivedAt }
        : this.current?.sevenDayFable !== undefined && this.current.sevenDayFableReceivedAt !== undefined
          ? { sevenDayFable: this.current.sevenDayFable, sevenDayFableReceivedAt: this.current.sevenDayFableReceivedAt }
          : {}
    const snapshot: UsageSnapshot = {
      ...(windows.fiveHour === undefined ? {} : { fiveHour: windows.fiveHour }),
      ...(windows.sevenDay === undefined ? {} : { sevenDay: windows.sevenDay }),
      ...fable,
      status,
      usingOverage,
      receivedAt
    }
    this.current = snapshot
    // Write every time: `rate_limit` comes a few times per turn (3 times in the real fixture), and is one small JSON row.
    // Thinning it out would need a hook into before-quit to keep the value just before exit (it is entangled with the order of closing the DB).
    this.settings.writeTyped(USAGE_LAST_SNAPSHOT, snapshot)
    this.onChanged(snapshot)
  }
}
