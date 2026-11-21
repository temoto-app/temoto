/**
 * Stops background subagents as well with the stop button (TODO 1153 stage 1, ARCHITECTURE.md 4.5.4). Pure functions that touch neither electron nor the DB;
 * `test/session-stop.test.ts` ("background subagents") and `test/subtask-list.test.ts` check them.
 *
 * The backend's interrupt (turn interruption) stops **only the parent turn**, and children running in the background (`run_in_background`) keep running
 * after the parent turn ends (`test/fixtures/subagents.jsonl`: the parent's `result` comes before the child's end).
 * aios does not own the child process (children run inside the backend), so the only sure way to stop them is "stop the whole process and
 * resume on the next send". Before stopping, aios closes the children whose end has not yet come with "stop"
 * (recording a synthesized `subtask_finished`) - once the process goes down, no end notification arrives, and both the list row and the timeline
 * block would disappear or remain as "running".
 */
import { randomUUID } from 'node:crypto'
import type { AiosEvent } from '@shared/agent.js'
import type { RunningSubtask } from '@shared/thread.js'

/**
 * After the stop button, the time to wait for the background children to end (the notification when the backend stops the children in response to the interrupt). If they are still
 * there after it, stop the whole process.
 */
export const SUBTASK_STOP_GRACE_MS = 3000

/**
 * End rows that close children whose end has not yet come with "stop" (in start order). Usage stays at the last reported value
 * (showing the tokens at the time of stopping). There is no summary.
 */
export function stoppedSubtaskEvents(
  subtasks: ReadonlyMap<string, RunningSubtask>,
  base: { readonly threadId: string; readonly sessionId: string; readonly ts: number }
): AiosEvent[] {
  return [...subtasks.values()].map((subtask) => ({
    id: randomUUID(),
    sessionId: base.sessionId,
    threadId: base.threadId,
    ts: base.ts,
    actor: 'main',
    kind: 'subtask_finished',
    payload: {
      taskId: subtask.taskId,
      toolUseId: subtask.toolUseId,
      status: 'stopped',
      summary: null,
      usage: subtask.usage,
      outputFile: null
    }
  }))
}
