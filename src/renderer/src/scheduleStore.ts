/**
 * Home of the scheduled-run list and editor (TODO 372, wave 20 bundle B. ARCHITECTURE.md 6.2.4 / 5.3).
 *
 * Scheduled runs moved out of settings and became a mode of the activity bar (`'schedule'` of `SidebarMode`):
 * **the list is in the sidebar** (`ScheduleList.tsx`), and **pressing a row opens the edit form in the main area** (`ScheduleEditor.tsx`,
 * in the ThreadPane's place, like the settings editor). Both look at the same list, so the
 * `ScheduleOverview` fetched from main is held in this one store (before, `ScheduleSettings` held it in its own state).
 *
 * - **One subscription per window** (`initSchedule`, called by the Sidebar at startup). For the activity bar's dot (failed / skipped runs),
 *   pushes (`schedule.onChanged`) keep being received even while the list is not visible.
 * - **The "seen" time** (`seenAt`) is kept per window in `localStorage` (treated like the sidebar's collapse state: not a setting but
 *   "how this window is used"). Results that arrive while the list is visible count as seen.
 * - Opening / closing the editor (`editing`) is mutually exclusive with the settings editor. Opening settings closes it, and selecting a thread closes it
 *   (the same convention as `settingsEditorStore.ts`: look at `selectionSeq`).
 */
import { create } from 'zustand'
import type { ScheduleOverview, ScheduledJob } from '@shared/schedule.js'
import { useThreads } from './threadStore.js'
import { useSettingsEditor } from './settingsEditorStore.js'
import { readNumber, safeStorage, writeNumber, type PrefStorage } from './uiPrefs.js'

/** The `localStorage` key: the time (ms) the scheduled-run list was last seen. */
export const SCHEDULE_SEEN_KEY = 'aios.scheduleSeenAt'

/** The edit in the main area. If `id` is null, it is an add. If `trigger` is present, it edits a trigger rule (TODO 1216, `id` is null). */
export interface ScheduleEditing {
  readonly id: string | null
  readonly trigger?: { readonly pluginId: string; readonly triggerId: string }
  /** TODO 972: editing a role (Teammate). `id` null = adding one (`ScheduleEditing.id` is null). */
  readonly role?: { readonly id: string | null }
}

interface ScheduleState {
  /** undefined = not fetched from main yet. */
  readonly overview: ScheduleOverview | undefined
  /** The edit open in the main area. null means closed. */
  readonly editing: ScheduleEditing | null
  /** The time the list was last seen. Failed / skipped runs after this become the activity bar's dot. */
  readonly seenAt: number
  setOverview(overview: ScheduleOverview): void
  openEditor(id: string | null): void
  /** TODO 1216: open the edit of a trigger rule (the same home as editing a scheduled run). */
  openTrigger(pluginId: string, triggerId: string): void
  /** TODO 972: open the editor of a role (Teammate). null = a new one. */
  openRole(roleId: string | null): void
  closeEditor(): void
  markSeen(at?: number): void
}

function loadSeenAt(storage: PrefStorage | undefined = safeStorage()): number {
  return readNumber(storage, SCHEDULE_SEEN_KEY, (value) => value >= 0) ?? 0
}

export const useSchedule = create<ScheduleState>((set, get) => ({
  overview: undefined,
  editing: null,
  seenAt: loadSeenAt(),
  setOverview: (overview) => set({ overview }),
  openEditor: (id) => {
    // It shares the home with the settings editor, so they are exclusive (close first; the open comes after, so the close notification does not close this one).
    useSettingsEditor.getState().close()
    set({ editing: { id } })
  },
  openTrigger: (pluginId, triggerId) => {
    useSettingsEditor.getState().close()
    set({ editing: { id: null, trigger: { pluginId, triggerId } } })
  },
  openRole: (roleId) => {
    useSettingsEditor.getState().close()
    set({ editing: { id: null, role: { id: roleId } } })
  },
  closeEditor: () => set({ editing: null }),
  markSeen: (at = Date.now()) => {
    if (at <= get().seenAt) return
    writeNumber(safeStorage(), SCHEDULE_SEEN_KEY, String(at))
    set({ seenAt: at })
  }
}))

let initialized = false

/**
 * Fetch main's list and subscribe to pushes (once per window). Called at Sidebar startup. Tests reset with
 * `resetScheduleForTest`.
 */
export function initSchedule(): void {
  if (initialized) return
  initialized = true
  let pushed = false
  window.aios.schedule.onChanged((next) => {
    pushed = true
    useSchedule.getState().setOverview(next)
  })
  void window.aios.schedule.list().then((next) => {
    // If a push arrived while fetching, the push is newer.
    if (!pushed) useSchedule.getState().setOverview(next)
  })
}

/** For tests: reset the subscription marker and the state. */
export function resetScheduleForTest(): void {
  initialized = false
  useSchedule.setState({ overview: undefined, editing: null, seenAt: 0 })
}

/**
 * The time and kind of "needs attention" for one job. For a failure it is the time it ran; for a skipped run (the previous one was still running,
 * or a plugin task is not supported in this version, TODO 372) it is that run's scheduled time. null if there is nothing.
 */
export function jobAttention(job: ScheduledJob): { readonly at: number; readonly level: 'failed' | 'skipped' } | null {
  if (job.lastOutcome === 'failed') return { at: job.lastRunAt ?? 0, level: 'failed' }
  if (job.lastOutcome === 'skipped' || job.lastOutcome === 'unsupported') {
    return { at: job.lastSkipAt ?? job.lastRunAt ?? 0, level: 'skipped' }
  }
  return null
}

/**
 * The activity bar's dot (TODO 372). `'attention'` (warning color) if a run failed after `seenAt`,
 * `'unread'` (accent color) if only skipped runs, null if none. The same 2 levels as the thread button's dot.
 */
export function scheduleDot(
  overview: ScheduleOverview | undefined,
  seenAt: number
): 'attention' | 'unread' | null {
  if (overview === undefined) return null
  let dot: 'attention' | 'unread' | null = null
  for (const job of overview.jobs) {
    const attention = jobAttention(job)
    if (attention === null || attention.at <= seenAt) continue
    if (attention.level === 'failed') return 'attention'
    dot = 'unread'
  }
  return dot
}

// When the settings editor opens, close the scheduled-run edit that shares the same home.
useSettingsEditor.subscribe((state, previous) => {
  if (state.open && !previous.open) useSchedule.getState().closeEditor()
})

// TODO 1265: a reminder's notification was clicked - open that job's editor (the snooze buttons are there).
useThreads.subscribe((state, previous) => {
  const request = state.scheduleOpenRequest
  if (request !== null && request !== previous.scheduleOpenRequest) useSchedule.getState().openEditor(request.jobId)
})

// Close when a thread is selected (the same as the settings editor. Avoids "pressed the list but the screen did not change").
useThreads.subscribe((state, previous) => {
  if (state.selectionSeq === previous.selectionSeq) return
  if (state.activeThreadId !== null) useSchedule.getState().closeEditor()
})
