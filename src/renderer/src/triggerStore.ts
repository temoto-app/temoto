/**
 * The trigger list (TODO 1216, ARCHITECTURE 6.2.6). The "Triggers" section of the scheduled-run view (`ScheduleList.tsx`) and the
 * app-side rule editor (`TriggerEditor.tsx`) look at the same list, so the `TriggerOverview` fetched from main is held only once, here.
 * One subscription per window (`initTriggers`, called by the Sidebar at startup). Opening and closing the editor lives in `scheduleStore.ts`
 * `editing.trigger` (same place and same exclusivity as editing a scheduled run).
 */
import { create } from 'zustand'
import type { TriggerOverview, TriggerRow } from '@shared/trigger.js'

interface TriggerState {
  /** undefined = not fetched from main yet. */
  readonly overview: TriggerOverview | undefined
  setOverview(overview: TriggerOverview): void
}

export const useTriggers = create<TriggerState>((set) => ({
  overview: undefined,
  setOverview: (overview) => set({ overview })
}))

let initialized = false

/** Fetches main's list and subscribes to pushes (once per window). */
export function initTriggers(): void {
  if (initialized) return
  initialized = true
  let pushed = false
  window.aios.trigger.onChanged((next) => {
    pushed = true
    useTriggers.getState().setOverview(next)
  })
  void window.aios.trigger.list().then((next) => {
    if (!pushed) useTriggers.getState().setOverview(next)
  })
}

/** For tests: resets the subscription marker and the state. */
export function resetTriggersForTest(): void {
  initialized = false
  useTriggers.setState({ overview: undefined })
}

/** Looks up a row of the list (null if absent). */
export function findTrigger(
  overview: TriggerOverview | undefined,
  pluginId: string,
  triggerId: string
): TriggerRow | null {
  return overview?.triggers.find((row) => row.pluginId === pluginId && row.triggerId === triggerId) ?? null
}
