/**
 * The "n minutes ago" in a turn's end row (TODO 466, wave 23 bundle D, ARCHITECTURE.md 5.1).
 *
 * - **Only this small component redraws on the clock.** The whole timeline (ThreadPane) does not subscribe to the clock.
 * - One clock per window (`useMinuteClock`, `useSyncExternalStore`). `setInterval` runs only while there are subscribers.
 *   The tick is 15 seconds (satisfying "advance every minute" with at most 15 seconds of lag from the boundary; if the text does not change, the DOM does not change).
 * - Hover shows the exact date and time (the common `Tooltip`). If it is the last turn and the cache lifetime (`cacheTtlMs`) is known,
 *   once the lifetime has passed since the end it turns a pale warning color (`.stale`) and the balloon adds "the cache is expected to have expired".
 */
import { useSyncExternalStore } from 'react'
import { useT } from '../i18n/index.js'
import { useLocale } from '../localeStore.js'
import { Tooltip } from './Tooltip.js'
import { cacheExpired, formatCacheTtl, formatEndedAgo, formatExactDateTime } from '../thread/turn-end.js'

/** Clock tick (ms). */
export const CLOCK_TICK_MS = 15_000

let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (clockTimer === null) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const l of listeners) l()
    }, CLOCK_TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/**
 * Returns the value of each tick (if it returned `Date.now()` on every call, React would see "the snapshot changes every time" and keep redrawing).
 * Even if the first render uses an old value from while the clock was stopped, `subscribe` advances it to the current time when it wakes the clock, and
 * React re-reads the snapshot right after subscribing, so it redraws.
 */
function snapshot(): number {
  return clockNow
}

/** One clock per window. Only components that subscribed redraw on each tick. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function TurnEndAge({
  endedAt,
  cacheTtlMs
}: {
  endedAt: number
  /** Passed only for the last turn (including hand-over). Undefined if unknown. */
  cacheTtlMs?: number
}): React.JSX.Element | null {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const now = useMinuteClock()
  // Do not show rows with no time (broken / old records).
  if (!Number.isFinite(endedAt) || endedAt <= 0) return null
  const stale = cacheTtlMs !== undefined && cacheExpired(endedAt, cacheTtlMs, now)
  return (
    <>
      {' · '}
      <Tooltip
        className="turn-end-tooltip"
        content={() => (
          <>
            <div>{t('timeline.result.endedAt', { when: formatExactDateTime(endedAt, locale) })}</div>
            {stale && cacheTtlMs !== undefined ? (
              <div className="turn-end-cache">
                {t('timeline.result.cacheExpired', { ttl: formatCacheTtl(cacheTtlMs, t) })}
              </div>
            ) : null}
          </>
        )}
      >
        <span className={stale ? 'turn-end-age stale' : 'turn-end-age'}>
          {formatEndedAgo(endedAt, now, locale, t)}
        </span>
      </Tooltip>
    </>
  )
}
