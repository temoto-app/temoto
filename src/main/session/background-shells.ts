/**
 * Record of shells running in the background (item 105 / TODO 1196, ARCHITECTURE.md 4.6.3). A pure function that touches
 * neither electron nor the DB; `test/background-shells.test.ts` checks it as is.
 *
 * The record is used in two places:
 * - Eviction (`isEvictable`): if a shell is running, the process is not dropped even when `idle` (the child's work would die with it).
 * - The list spinner (`ThreadRuntime.backgroundShells` -> the renderer's `busyOf`): keeps spinning while an external
 *   process the AI sent to the background is running, even after the parent turn ended (TODO 1196).
 *
 * Both look at the same count, `activeBackgroundShells`: shells that are **in the background and have not passed the time limit since they started**.
 * - A foreground shell (`backgrounded: false`) is not counted: while it is in the foreground the parent turn is
 *   `running`, and even if the end notification is missed it does not keep spinning after the turn ends. Once it
 *   goes to the background (`subtask_backgrounded`) it is counted.
 * - A shell past the time limit is not counted: this keeps never-ending work such as a watcher or a dev server from
 *   blocking eviction and the spinner forever (the same value as the owner decision of item 105).
 * - When `background_tasks` (the full set of background work) arrives, the background shells are corrected to that set
 *   (a safety net for missed end notifications). **But only things that are certain are removed** (wave 81 review Y):
 *   the set is emitted separately from the start / went-to-background notices, so a stale set (emitted by a change in
 *   other work, assembled before this shell was registered) can arrive after a shell has just gone to the background
 *   and not contain it. Removing too much there would make eviction count 0 shells and kill the process, and the
 *   spinner would stop early. A shell missing from the set is removed only if (a) it was in the previous set once
 *   (stdout is one stream and the order is not reshuffled, so something that was in and dropped out has ended), or
 *   (b) at least `SET_GRACE_MS` has passed since it went to the background. Shells kept during the grace period are
 *   dropped by the next set, the end notification, or the time limit (it never errs toward never stopping).
 */
import type { AiosEvent } from '@shared/agent.js'

/**
 * Grace period during which a shell that just went to the background is not removed by a full set that does not
 * contain it (wave 81 review Y). `event.ts` is the time the adapter read the line, so lines in the same chunk get
 * almost the same time. The next set arrives within a few seconds (it is emitted on every change).
 */
export const SET_GRACE_MS = 5_000

export interface BackgroundShell {
  /** Start time (`event.ts`). The time limit is counted from here. */
  readonly startedAt: number
  /** Time it went to the background. null is a shell a foreground call is waiting on (not counted). The grace period for the full set is counted from here. */
  readonly backgroundedAt: number | null
  /** Whether it was ever in a full set. Something that was in and is missing from the next set has ended. */
  readonly listed: boolean
}

/**
 * Updates the record. Returns true if the contents changed (whether the count changed is compared with `activeBackgroundShells`).
 * A subagent's work (`isSubagent`) is a separate record (`subtasks.ts`), so it is not touched here.
 */
export function applyBackgroundShellEvent(shells: Map<string, BackgroundShell>, event: AiosEvent): boolean {
  switch (event.kind) {
    case 'subtask_started': {
      const p = event.payload
      if (!p.isBackgroundShell) return false
      const current = shells.get(p.taskId)
      if (current !== undefined) {
        // It was already in a full set (the real order: full set -> task_started). The start keeps that time. Even if it
        // is reported as foreground, something in the set stays in the background. If it was in as foreground and is
        // now reported as background, move it to the background here.
        if (current.backgroundedAt !== null || p.backgrounded === false) return false
        shells.set(p.taskId, { ...current, backgroundedAt: event.ts })
        return true
      }
      // A version that reports nothing is treated as background (how item 105 counted).
      shells.set(p.taskId, {
        startedAt: event.ts,
        backgroundedAt: p.backgrounded === false ? null : event.ts,
        listed: false
      })
      return true
    }
    case 'subtask_backgrounded': {
      const current = shells.get(event.payload.taskId)
      if (current === undefined || current.backgroundedAt !== null) return false
      shells.set(event.payload.taskId, { ...current, backgroundedAt: event.ts })
      return true
    }
    case 'subtask_finished':
      return shells.delete(event.payload.taskId)
    case 'background_tasks': {
      const live = new Set(event.payload.shellTaskIds)
      let changed = false
      for (const taskId of live) {
        const current = shells.get(taskId)
        if (current === undefined) {
          // The set arrives before the start notification (the real order: full set -> task_started). The start is taken as this time.
          shells.set(taskId, { startedAt: event.ts, backgroundedAt: event.ts, listed: true })
          changed = true
        } else if (current.backgroundedAt === null || !current.listed) {
          shells.set(taskId, { ...current, backgroundedAt: current.backgroundedAt ?? event.ts, listed: true })
          changed = true
        }
      }
      // A background shell not in the set has ended (even if the end notification was missed, it drops out here). But one
      // that never appeared in a set and just went to the background may be due to a stale set, so keep it (see the header).
      // A foreground shell is never in the set, so keep it (it is not counted, so nothing visible changes).
      for (const [taskId, shell] of shells) {
        if (shell.backgroundedAt === null || live.has(taskId)) continue
        if (!shell.listed && event.ts - shell.backgroundedAt < SET_GRACE_MS) continue
        shells.delete(taskId)
        changed = true
      }
      return changed
    }
    default:
      return false
  }
}

/** Whether to count it: in the background and `timeoutMs` has not passed since the start. */
function counts(shell: BackgroundShell, now: number, timeoutMs: number): boolean {
  return shell.backgroundedAt !== null && now - shell.startedAt < timeoutMs
}

/** The number of shells counted: in the background and `timeoutMs` has not passed since the start. */
export function activeBackgroundShells(
  shells: ReadonlyMap<string, BackgroundShell>,
  now: number,
  timeoutMs: number
): number {
  let count = 0
  for (const shell of shells.values()) {
    if (counts(shell, now, timeoutMs)) count += 1
  }
  return count
}

/**
 * Of the shells being counted, the earliest time one reaches the time limit (wave 81 review Y). null if none is counted.
 * This is a boundary where the count drops by time alone, so main sets a one-shot timer at this time and redistributes.
 */
export function nextBackgroundShellExpiry(
  shells: ReadonlyMap<string, BackgroundShell>,
  now: number,
  timeoutMs: number
): number | null {
  let next: number | null = null
  for (const shell of shells.values()) {
    if (!counts(shell, now, timeoutMs)) continue
    const at = shell.startedAt + timeoutMs
    if (next === null || at < next) next = at
  }
  return next
}
