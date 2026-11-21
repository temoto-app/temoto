/**
 * The way item 93 is shown (ARCHITECTURE.md 4.6.3 'Display'). Pure functions only.
 *
 * - main's memo (`applySubtaskEvent`): adds only children, updates the usage and the last tool as progress comes in, and removes a child when it ends. Progress with unchanged contents is not redistributed.
 * - Timeline (`foldTimeline`): a finished child is one line at the position of `subtask_finished`. The description is from the start.
 * - An end that did not see a tool start or run is not shown.
 * - How the list is counted and written (`thread/subtasks.ts`).
 *
 * The rows are synthetic (there is no real concurrent fixture yet; remainder of TODO 93). The shape is the same as item 93 in `test/parse-event.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent, SubtaskEndStatus, SubtaskUsage } from '../src/shared/agent.js'
import type { RunningSubtask } from '../src/shared/thread.js'
import { applySubtaskEvent } from '../src/main/session/subtasks.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import type { ApprovalItem } from '../src/shared/thread.js'
import {
  finishedElapsedMs,
  finishedSubtasksByToolUse,
  formatElapsed,
  formatTokens,
  subagentState,
  subagentStateMark,
  subtaskAwaitingApproval,
  subtaskElapsedMs,
  totalSubtaskTokens
} from '../src/renderer/src/thread/subtasks.js'

let seq = 0
function base(ts: number): { id: string; sessionId: string; threadId: string; ts: number; actor: 'main' } {
  seq += 1
  return { id: `e${seq}`, sessionId: 's', threadId: 't', ts, actor: 'main' }
}

function started(taskId: string, ts: number, isSubagent = true): AiosEvent {
  return {
    ...base(ts),
    kind: 'subtask_started',
    payload: {
      taskId,
      toolUseId: `tu-${taskId}`,
      description: `説明 ${taskId}`,
      subagentType: isSubagent ? 'general-purpose' : null,
      isSubagent,
      isBackgroundShell: false
    }
  }
}

function progress(
  taskId: string,
  ts: number,
  patch: { usage?: SubtaskUsage | null; lastToolName?: string | null; status?: RunningSubtask['status'] | null } = {}
): AiosEvent {
  return {
    ...base(ts),
    kind: 'subtask_progress',
    payload: {
      taskId,
      toolUseId: `tu-${taskId}`,
      description: null,
      activity: null,
      subagentType: null,
      status: patch.status ?? null,
      usage: patch.usage ?? null,
      lastToolName: patch.lastToolName ?? null,
      summary: null
    }
  }
}

function finished(
  taskId: string,
  ts: number,
  status: SubtaskEndStatus = 'completed',
  usage: SubtaskUsage | null = { totalTokens: 12_345, toolUses: 3, durationMs: 42_000 }
): AiosEvent {
  return {
    ...base(ts),
    kind: 'subtask_finished',
    payload: { taskId, toolUseId: `tu-${taskId}`, status, summary: `要約 ${taskId}`, usage, outputFile: null }
  }
}

describe("applySubtaskEvent (main's record)", () => {
  it('only adds children, updates usage and the last tool on progress, and removes at the end', () => {
    const running = new Map<string, RunningSubtask>()
    expect(applySubtaskEvent(running, started('a', 100))).toBe(true)
    expect(applySubtaskEvent(running, started('shell', 100, false))).toBe(false)
    expect([...running.keys()]).toEqual(['a'])
    expect(running.get('a')).toMatchObject({ status: 'running', startedAt: 100, usage: null, usageAt: null })

    const usage = { totalTokens: 500, toolUses: 1, durationMs: 1500 }
    expect(applySubtaskEvent(running, progress('a', 200, { usage, lastToolName: 'Read' }))).toBe(true)
    expect(running.get('a')).toMatchObject({ usage, usageAt: 200, lastToolName: 'Read' })

    // When progress does not carry the last tool, keep the previous value. Also reflect progress that is only a state change.
    expect(applySubtaskEvent(running, progress('a', 300, { status: 'paused' }))).toBe(true)
    expect(running.get('a')).toMatchObject({ status: 'paused', lastToolName: 'Read', usageAt: 200 })

    expect(applySubtaskEvent(running, finished('a', 400))).toBe(true)
    expect(running.size).toBe(0)
  })

  it('does not re-broadcast for progress that changes nothing, progress and ends of unknown ids, or duplicate starts', () => {
    const running = new Map<string, RunningSubtask>()
    applySubtaskEvent(running, started('a', 100))
    const before = running.get('a')
    expect(applySubtaskEvent(running, progress('a', 200))).toBe(false)
    expect(running.get('a')).toBe(before)
    expect(applySubtaskEvent(running, progress('shell', 200, { lastToolName: 'Bash' }))).toBe(false)
    expect(applySubtaskEvent(running, finished('orphan', 300))).toBe(false)
    expect(applySubtaskEvent(running, started('a', 400))).toBe(false)
    expect(running.get('a')?.startedAt).toBe(100)
  })
})

describe('the child agent row of foldTimeline (item 93)', () => {
  it('a finished child is one row at the position of subtask_finished. Description and kind from the start, and the start row and progress are not shown', () => {
    const events: AiosEvent[] = [
      { ...base(1), kind: 'user_text', payload: { text: '2 本走らせて' } },
      started('a', 10),
      started('b', 11),
      progress('a', 20, { usage: { totalTokens: 1, toolUses: 1, durationMs: 1 } }),
      finished('b', 30, 'failed', null),
      finished('a', 40)
    ]
    const items = foldTimeline(events).items
    expect(items.map((item) => item.kind)).toEqual(['user', 'subtask', 'subtask'])
    const [, b, a] = items
    expect(b).toMatchObject({
      kind: 'subtask',
      taskId: 'b',
      description: '説明 b',
      subagentType: 'general-purpose',
      status: 'failed',
      usage: null,
      startedAt: 11
    })
    expect(a).toMatchObject({ taskId: 'a', status: 'completed', summary: '要約 a', startedAt: 10 })
  })

  it('an end of tool execution, and an end whose start was not seen (a previous page, a child from before resume) are not shown', () => {
    const items = foldTimeline([
      started('shell', 1, false),
      finished('shell', 2),
      finished('orphan', 3, 'failed')
    ]).items
    expect(items).toEqual([])
  })

  it('the same end arriving twice gives one row', () => {
    const items = foldTimeline([started('a', 1), finished('a', 2), finished('a', 3)]).items
    expect(items).toHaveLength(1)
  })
})

describe('how the list is counted and written (thread/subtasks.ts)', () => {
  const child = (patch: Partial<RunningSubtask> = {}): RunningSubtask => ({
    taskId: 'a',
    toolUseId: null,
    description: 'x',
    subagentType: null,
    status: 'running',
    startedAt: 1_000,
    usage: null,
    usageAt: null,
    lastToolName: null,
    activity: null,
    model: null,
    ...patch
  })

  it('elapsed time: from the start if there is no report, and if there is, the reported value plus the time since receiving it', () => {
    expect(subtaskElapsedMs(child(), 6_000)).toBe(5_000)
    expect(
      subtaskElapsedMs(
        child({ usage: { totalTokens: 1, toolUses: 1, durationMs: 30_000 }, usageAt: 5_000 }),
        7_000
      )
    ).toBe(32_000)
    // Even if the clock goes back, do not make it negative.
    expect(subtaskElapsedMs(child(), 0)).toBe(0)
  })

  it("a finished child's duration: prefers the reported value, and otherwise start to end", () => {
    expect(finishedElapsedMs({ totalTokens: 1, toolUses: 1, durationMs: 9_000 }, 0, 100_000)).toBe(9_000)
    expect(finishedElapsedMs(null, 1_000, 4_500)).toBe(3_500)
  })

  it('formatElapsed / formatTokens', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(7_900)).toBe('0:07')
    expect(formatElapsed(184_000)).toBe('3:04')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(123_456)).toBe('123k')
    expect(formatTokens(1_250_000)).toBe('1.2M')
  })

  it('total tokens count a child with no report as 0', () => {
    expect(
      totalSubtaskTokens([
        child({ usage: { totalTokens: 100, toolUses: 1, durationMs: 1 } }),
        child({ taskId: 'b' }),
        child({ taskId: 'c', usage: { totalTokens: 50, toolUses: 1, durationMs: 1 } })
      ])
    ).toBe(150)
  })
})

describe('item 321: child state (material for color and marker)', () => {
  const sub = (status: RunningSubtask['status']): RunningSubtask => ({
    taskId: 'a',
    toolUseId: 'tu-a',
    description: 'd',
    subagentType: null,
    status,
    startedAt: 0,
    usage: null,
    usageAt: null,
    lastToolName: null,
    activity: null,
    model: null
  })

  it('the end notice wins, and awaiting approval is attached only to running children', () => {
    expect(subagentState(sub('running'), null, false)).toBe('running')
    expect(subagentState(sub('pending'), null, false)).toBe('pending')
    expect(subagentState(sub('running'), null, true)).toBe('waiting')
    expect(subagentState(sub('paused'), null, false)).toBe('waiting')
    expect(subagentState(sub('running'), 'completed', true)).toBe('done')
    expect(subagentState(undefined, 'failed', false)).toBe('failed')
    expect(subagentState(undefined, 'stopped', false)).toBe('stopped')
    expect(subagentState(undefined, null, true)).toBeNull()
  })

  it('the marker differs per state (only while running a spinner = null)', () => {
    const marks = (['running', 'pending', 'waiting', 'done', 'failed', 'stopped'] as const).map(subagentStateMark)
    expect(marks).toEqual([null, '…', '⏸', '✓', '✕', '■'])
  })

  it('awaiting approval is matched with the inbox by subtask.taskId and the thread', () => {
    const item = { threadId: 't', subtask: { taskId: 'a', description: 'd' } } as unknown as ApprovalItem
    const parent = { threadId: 't', subtask: null } as unknown as ApprovalItem
    expect(subtaskAwaitingApproval([parent, item], 't', 'a')).toBe(true)
    expect(subtaskAwaitingApproval([item], 'other', 'a')).toBe(false)
    expect(subtaskAwaitingApproval([parent], 't', 'a')).toBe(false)
  })

  it("looks up the end notice by the parent call's id, and the same array gives the same table (the payload is also the same reference)", () => {
    const events = [started('a', 1), finished('a', 2, 'failed'), finished('b', 3)]
    const map = finishedSubtasksByToolUse(events)
    expect(map.get('tu-a')?.status).toBe('failed')
    expect(map.get('tu-b')?.status).toBe('completed')
    expect(finishedSubtasksByToolUse(events)).toBe(map)
    expect(map.get('tu-a')).toBe((events[1] as Extract<AiosEvent, { kind: 'subtask_finished' }>).payload)
  })
})
