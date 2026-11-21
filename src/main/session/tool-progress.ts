/**
 * The record of the progress of running tool calls (item 259, ARCHITECTURE.md 4.6 "tool progress").
 * Pure functions that touch neither electron nor the DB; `test/tool-progress.test.ts` checks them as is.
 *
 * - Keeps only the last `tool_progress` per call (the source of `ThreadRuntime.toolProgress`).
 * - The progress of a shell running inside a subagent (`heartbeat` is false, and `toolUseId` is the parent's
 *   call that started a running child) becomes **that child's current activity** rather than the row's progress (shown by the list of item 257).
 *   The shape of `RunningSubtask` is unchanged; only the values of `lastToolName` / `activity` are replaced.
 * - A result (`tool_result`) removes that call, and the end of the turn (`result`) removes all of them. If the process dies,
 *   it disappears together with `Live`.
 *
 * The return value is "whether it needs to be redistributed to the renderer" (whether the contents changed).
 */
import type { AiosEvent } from '@shared/agent.js'
import type { RunningSubtask, ToolProgress } from '@shared/thread.js'

export function applyToolProgressEvent(
  progress: Map<string, ToolProgress>,
  subtasks: Map<string, RunningSubtask>,
  event: AiosEvent
): boolean {
  switch (event.kind) {
    case 'tool_progress': {
      const p = event.payload
      if (!p.heartbeat) {
        for (const [taskId, subtask] of subtasks) {
          if (subtask.toolUseId !== p.toolUseId) continue
          const activity = `${p.toolName} (${p.elapsedSeconds}s)`
          if (subtask.activity === activity && subtask.lastToolName === p.toolName) return false
          subtasks.set(taskId, { ...subtask, lastToolName: p.toolName, activity })
          return true
        }
      }
      const current = progress.get(p.toolUseId)
      if (current !== undefined && current.elapsedSeconds === p.elapsedSeconds && current.toolName === p.toolName) {
        return false
      }
      progress.set(p.toolUseId, {
        toolUseId: p.toolUseId,
        toolName: p.toolName,
        elapsedSeconds: p.elapsedSeconds,
        at: event.ts
      })
      return true
    }
    case 'tool_result':
      return progress.delete(event.payload.toolUseId)
    case 'result':
      if (progress.size === 0) return false
      progress.clear()
      return true
    default:
      return false
  }
}
