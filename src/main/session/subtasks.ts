/**
 * The record of running subagents (how item 93 is shown, ARCHITECTURE.md 4.6.3).
 * Pure functions that touch neither electron nor the DB; `test/subtask-list.test.ts` checks them as is.
 *
 * - `subtask_started` is added only when `isSubagent` is true (tool runs are not counted - the same set as the eviction
 *   check `isEvictable`).
 * - `subtask_progress` updates only known ids (the progress of a tool run comes as an unknown id).
 * - Removed on `subtask_finished`. The end does not say whether it was a subagent, so an unknown id does nothing.
 *
 * The return value is "whether it needs to be redistributed to the renderer" (whether the contents changed).
 */
import type { AiosEvent } from '@shared/agent.js'
import type { RunningSubtask } from '@shared/thread.js'

export function applySubtaskEvent(
  running: Map<string, RunningSubtask>,
  event: AiosEvent,
  /** The parent's call that started a child -> the model's display name (TODO 403, written by `applySubagentModel`). */
  models?: ReadonlyMap<string, string>
): boolean {
  switch (event.kind) {
    case 'subtask_started': {
      const p = event.payload
      if (!p.isSubagent || running.has(p.taskId)) return false
      running.set(p.taskId, {
        taskId: p.taskId,
        toolUseId: p.toolUseId,
        description: p.description,
        subagentType: p.subagentType,
        status: 'running',
        startedAt: event.ts,
        usage: null,
        usageAt: null,
        lastToolName: null,
        activity: null,
        model: p.toolUseId === null ? null : (models?.get(p.toolUseId) ?? null)
      })
      return true
    }
    case 'subtask_progress': {
      const p = event.payload
      const current = running.get(p.taskId)
      if (current === undefined) return false
      const next: RunningSubtask = {
        ...current,
        description: p.description ?? current.description,
        status: p.status ?? current.status,
        usage: p.usage ?? current.usage,
        usageAt: p.usage === null ? current.usageAt : event.ts,
        lastToolName: p.lastToolName ?? current.lastToolName,
        activity: p.activity ?? current.activity
      }
      if (
        next.description === current.description &&
        next.status === current.status &&
        next.usageAt === current.usageAt &&
        next.lastToolName === current.lastToolName &&
        next.activity === current.activity
      ) {
        return false
      }
      running.set(p.taskId, next)
      return true
    }
    case 'subtask_finished':
      return running.delete(event.payload.taskId)
    default:
      return false
  }
}

/** Upper bound on the number of children's models remembered per thread (TODO 403). */
export const MAX_SUBAGENT_MODELS = 200

/**
 * The display name of a child's model (TODO 403, ARCHITECTURE.md 4.6.3). Updates `models` (the parent's call -> display name) and the running
 * child's `model`. True if the contents changed (redistribute to the renderer).
 *
 * - If the parent's `tool_use` has `subagentModel` (the model the parent specified), put it in provisionally. A value not in the table is not put in.
 *   **A call already known from the child's own message is not overwritten** (the arrival order is the parent's call, then the child's message, but just in case).
 * - The model of the child's `turn_usage` (`actor: 'subagent'`, `parentToolUseId` = the parent's call that started the child) is the model that
 *   actually ran, so it overwrites the provisional value. If it is not in the table, the reported name is kept.
 *
 * `label` is the Adapter's `modelLabel` (full name or alias -> `Sonnet 5`). How the CLI reads names is not known here.
 */
export function applySubagentModel(
  running: Map<string, RunningSubtask>,
  models: Map<string, string>,
  confirmed: Set<string>,
  event: AiosEvent,
  label: (model: string) => string | null
): boolean {
  let toolUseId: string
  let name: string
  if (event.kind === 'tool_use' && event.actor === 'main' && event.payload.subagentModel !== undefined) {
    toolUseId = event.payload.toolUseId
    if (toolUseId === '' || confirmed.has(toolUseId)) return false
    const requested = label(event.payload.subagentModel)
    if (requested === null) return false
    name = requested
  } else if (
    event.kind === 'turn_usage' &&
    event.actor === 'subagent' &&
    event.parentToolUseId !== undefined &&
    event.payload.model !== null
  ) {
    toolUseId = event.parentToolUseId
    name = label(event.payload.model) ?? event.payload.model
    confirmed.add(toolUseId)
  } else {
    return false
  }
  let changed = false
  if (models.get(toolUseId) !== name) {
    models.set(toolUseId, name)
    changed = true
    // Do not accumulate without limit in a long-used thread. Discard from the oldest call (that block then shows only the elapsed time).
    while (models.size > MAX_SUBAGENT_MODELS) {
      const oldest = models.keys().next().value
      if (oldest === undefined) break
      models.delete(oldest)
      confirmed.delete(oldest)
    }
  }
  for (const [taskId, subtask] of running) {
    if (subtask.toolUseId === toolUseId && subtask.model !== name) {
      running.set(taskId, { ...subtask, model: name })
      changed = true
    }
  }
  return changed
}
