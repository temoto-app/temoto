/**
 * How the subagent list is counted and written (how item 93 is shown, ARCHITECTURE.md 4.6.3).
 * Pure functions that touch neither the DOM nor the store, checked directly by `test/subtask-list.test.ts`.
 *
 * - **Elapsed time**: if the backend's `duration_ms` (the value at the last progress report) is available, it is advanced by adding
 *   "the time since that report was received". Otherwise, the time since the start. Both are
 *   the difference between main's clock (the event's `ts`) and the renderer's `Date.now()`, which agree because it is the same machine.
 * - **Tokens**: `total_tokens` per child. They are **not included in the parent's context (the item 60 donut)**,
 *   so the total is shown only in the list heading.
 * - The notation (`0:42` / `12.3k`) does not depend on the language, so it does not take `t` (same decision as `formatBytes`).
 */
import type { ApprovalItem, RunningSubtask } from '@shared/thread.js'
import type { AiosEvent, SubtaskEndStatus, SubtaskFinishedPayload, SubtaskUsage } from '@shared/agent.js'

/** The elapsed time (ms) of a running child. Never negative. */
export function subtaskElapsedMs(subtask: RunningSubtask, now: number): number {
  if (subtask.usage !== null && subtask.usageAt !== null) {
    return subtask.usage.durationMs + Math.max(0, now - subtask.usageAt)
  }
  return Math.max(0, now - subtask.startedAt)
}

/** The time taken (ms) by a finished child. The reported value if there is one, otherwise from start to end. */
export function finishedElapsedMs(
  usage: SubtaskUsage | null,
  startedAt: number,
  finishedAt: number
): number {
  if (usage !== null) return usage.durationMs
  return Math.max(0, finishedAt - startedAt)
}

/** `0:07` / `3:04` / `1:02:03`. Truncated to seconds. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/** `850` / `12.3k` / `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) return `${trim(n / 1000)}k`
  return `${trim(n / 1_000_000)}M`
}

function trim(value: number): string {
  // 100 and over show no decimals (`123k`). Under that, one digit (`12.3k`), and a trailing `.0` is dropped.
  const text = value >= 100 ? String(Math.floor(value)) : (Math.floor(value * 10) / 10).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** The total tokens of running children. A child that has not had a progress report yet counts as 0. */
export function totalSubtaskTokens(subtasks: readonly RunningSubtask[]): number {
  let sum = 0
  for (const subtask of subtasks) sum += subtask.usage?.totalTokens ?? 0
  return sum
}

/**
 * The state shown on a child's block and on the list button (item 321). Distinguished by both color (the vertical line at the left of the block) and mark (the head of the activity row) -
 * not relying on color alone.
 *
 * - `running` / `pending`: running (spinner / `…`). The vertical line stays `--subagent-line`.
 * - `waiting`: that child's tool call is waiting for approval (`⏸`, `--warn-fg`). The backend's `paused` looks the same.
 * - `done` / `failed` / `stopped`: the `status` of the end notification (`✓` `--ok-fg` / `✕` `--danger-fg` / `■` `--fg-dim`).
 *   Being stopped is not a failure, so it got a separate mark (the user or the model stopped it).
 */
export type SubagentState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

const END_STATE: Readonly<Record<SubtaskEndStatus, SubagentState>> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

/**
 * Decides one state. If the end notification has been seen, it wins (the record is removed at the end, but even if the arrival order is swapped,
 * a finished child is not put back to "running"). If neither exists, null (a child in an earlier page, or one from before reopening), and
 * the block gets no color or mark as before.
 */
export function subagentState(
  running: RunningSubtask | undefined,
  finished: SubtaskEndStatus | null,
  waiting: boolean
): SubagentState | null {
  if (finished !== null) return END_STATE[finished]
  if (running === undefined) return null
  if (waiting || running.status === 'paused') return 'waiting'
  if (running.status === 'pending') return 'pending'
  return 'running'
}

/** The mark for a state. null is the spinner (running). */
export function subagentStateMark(state: SubagentState): string | null {
  switch (state) {
    case 'running':
      return null
    case 'pending':
      return '…'
    case 'waiting':
      return '⏸'
    case 'done':
      return '✓'
    case 'failed':
      return '✕'
    case 'stopped':
      return '■'
  }
}

/**
 * Whether that child's (task id) tool call is waiting for approval (item 321). An approval request has no field identifying the child, so
 * it is matched with `ApprovalItem.subtask`, which main looks up from `toolUseId` and attaches (item 93, spike 19).
 * The inbox (`approvals`) holds only requests that are waiting.
 */
export function subtaskAwaitingApproval(
  approvals: readonly ApprovalItem[],
  threadId: string,
  taskId: string
): boolean {
  for (const approval of approvals) {
    if (approval.threadId === threadId && approval.subtask?.taskId === taskId) return true
  }
  return false
}

const finishedCache = new WeakMap<readonly AiosEvent[], ReadonlyMap<string, SubtaskFinishedPayload>>()

/**
 * A table that looks up children's end notifications in the parent's list by the id of the parent's `Agent` call (item 321). Built only once per list (array)
 * - the block selector is called whenever the parent's list changes, so it does not scan every time. The values are the notification payloads themselves
 * (the same row gives the same reference), so if the selector result does not change the block is not redrawn.
 */
export function finishedSubtasksByToolUse(
  events: readonly AiosEvent[]
): ReadonlyMap<string, SubtaskFinishedPayload> {
  const cached = finishedCache.get(events)
  if (cached !== undefined) return cached
  const map = new Map<string, SubtaskFinishedPayload>()
  for (const event of events) {
    if (event.kind === 'subtask_finished' && event.payload.toolUseId !== null) {
      map.set(event.payload.toolUseId, event.payload)
    }
  }
  finishedCache.set(events, map)
  return map
}
