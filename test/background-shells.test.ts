/**
 * TODO 1196: the list's spinner covers "all of the AI's work tied to the conversation". Pure functions only (neither the model nor the CLI is called).
 *
 * - main's copy (`applyBackgroundShellEvent` / `activeBackgroundShells`): counts only shells that were moved to the background, and only for the
 *   limit time since they started. A foreground shell is not counted; once moved to the background it is counted. The full set (`background_tasks`) fixes
 *   missed end notifications.
 * - Fixture (`test/fixtures/background-shell-2.1.319.jsonl`): **synthetic lines**. The real one is not yet captured. The shape is copied from the CLI 2.1.319
 *   binary's output schema (`task_started.is_backgrounded` / `task_updated.patch.is_backgrounded` /
 *   `background_tasks_changed` REPLACE semantics), and from the tool_result sentence when a shell moved to the background on timeout.
 *   The order (full set -> task_started) matches the real child fixture (`subagents.jsonl`).
 * - The renderer's judgment (`busyOf`): true if any of the parent's turn, a child, or a background shell is busy. Awaiting approval is false.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import {
  SET_GRACE_MS,
  activeBackgroundShells,
  applyBackgroundShellEvent,
  nextBackgroundShellExpiry,
  type BackgroundShell
} from '../src/main/session/background-shells.js'
import { busyOf } from '../src/renderer/src/thread-sort.js'

const TIMEOUT = 30 * 60_000

function event(kind: AiosEvent['kind'], payload: unknown, ts = 1_000): AiosEvent {
  return { id: `e-${Math.random()}`, sessionId: 's', threadId: 't', ts, actor: 'main', kind, payload } as unknown as AiosEvent
}

const started = (taskId: string, extra: Record<string, unknown> = {}, ts = 1_000): AiosEvent =>
  event(
    'subtask_started',
    {
      taskId,
      toolUseId: `tu-${taskId}`,
      description: taskId,
      subagentType: null,
      isSubagent: false,
      isBackgroundShell: true,
      ...extra
    },
    ts
  )

const finished = (taskId: string): AiosEvent =>
  event('subtask_finished', {
    taskId,
    toolUseId: `tu-${taskId}`,
    status: 'completed',
    summary: null,
    usage: null,
    outputFile: null
  })

const movedToBackground = (taskId: string, ts = 1_000): AiosEvent => event('subtask_backgrounded', { taskId }, ts)

const backgroundSet = (ids: readonly string[], ts = 1_000): AiosEvent =>
  event('background_tasks', { shellTaskIds: ids }, ts)

describe('applyBackgroundShellEvent / activeBackgroundShells (TODO 1196)', () => {
  it('background shells are counted from start to end', () => {
    const shells = new Map<string, BackgroundShell>()
    expect(applyBackgroundShellEvent(shells, started('a', { backgrounded: true }))).toBe(true)
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(1)
    expect(applyBackgroundShellEvent(shells, finished('a'))).toBe(true)
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(0)
  })

  it('a version with no report (no is_backgrounded) is regarded as background as before', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('a'))
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(1)
  })

  it('foreground shells are not counted and are counted once moved to background (a long command moved to background on timeout)', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('a', { backgrounded: false }))
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(0)
    expect(applyBackgroundShellEvent(shells, movedToBackground('a'))).toBe(true)
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(1)
    // The second time, no change.
    expect(applyBackgroundShellEvent(shells, movedToBackground('a'))).toBe(false)
  })

  it('even if the end notice of a foreground shell is missed, it is not counted after the turn (does not keep spinning)', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('fg', { backgrounded: false }))
    // The end notification still does not come.
    expect(activeBackgroundShells(shells, 10 * 60_000, TIMEOUT)).toBe(0)
  })

  it('a background shell not in the full set drops out (a safety net for missed end notices); foreground shells stay', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('a', { backgrounded: true }))
    applyBackgroundShellEvent(shells, started('fg', { backgrounded: false }))
    const later = 1_000 + SET_GRACE_MS
    expect(applyBackgroundShellEvent(shells, backgroundSet([], later))).toBe(true)
    expect(activeBackgroundShells(shells, later, TIMEOUT)).toBe(0)
    expect([...shells.keys()]).toEqual(['fg'])
    // The same set arrives again: no change.
    expect(applyBackgroundShellEvent(shells, backgroundSet([], later))).toBe(false)
  })

  it('a shell that has once been in the full set drops out if absent from the next set without waiting for the grace period', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, backgroundSet(['a'], 1_000))
    applyBackgroundShellEvent(shells, started('a', { backgrounded: true }, 1_000))
    expect(applyBackgroundShellEvent(shells, backgroundSet([], 1_001))).toBe(true)
    expect(shells.size).toBe(0)
  })

  it('review Y: even if an old set that does not contain a shell just moved to background arrives later, it is not removed (not evicted by over-removal)', () => {
    const shells = new Map<string, BackgroundShell>()
    // b1 is running in the background and is in the set.
    applyBackgroundShellEvent(shells, backgroundSet(['b1'], 1_000))
    applyBackgroundShellEvent(shells, started('b1', { backgrounded: true }, 1_000))
    // Right after b2 is registered in the background (task_started), a set built before b2's registration (only b1) arrives.
    applyBackgroundShellEvent(shells, started('b2', { backgrounded: true }, 60_000))
    expect(applyBackgroundShellEvent(shells, backgroundSet(['b1'], 60_010))).toBe(false)
    expect(activeBackgroundShells(shells, 60_010, TIMEOUT)).toBe(2)
    // A set containing b2 arrives next.
    expect(applyBackgroundShellEvent(shells, backgroundSet(['b1', 'b2'], 60_020))).toBe(true)
    // Same right after moving from the foreground to the background (the start was long ago): the grace period counts from the time it moved to the background.
    applyBackgroundShellEvent(shells, started('b3', { backgrounded: false }, 0))
    applyBackgroundShellEvent(shells, movedToBackground('b3', 120_000))
    expect(applyBackgroundShellEvent(shells, backgroundSet(['b1', 'b2'], 120_005))).toBe(false)
    expect(activeBackgroundShells(shells, 120_005, TIMEOUT)).toBe(3)
    // If b2 / b3 are in the next set, it counts normally from then on; if they drop out, they are removed.
    applyBackgroundShellEvent(shells, backgroundSet(['b1', 'b2', 'b3'], 120_100))
    expect(applyBackgroundShellEvent(shells, backgroundSet(['b1', 'b3'], 120_200))).toBe(true)
    expect([...shells.keys()].sort()).toEqual(['b1', 'b3'])
  })

  it('review Y: a shell past the grace period that never entered a set drops out with a set that does not contain it (does not keep spinning)', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('a', { backgrounded: true }, 1_000))
    expect(applyBackgroundShellEvent(shells, backgroundSet([], 1_000 + SET_GRACE_MS - 1))).toBe(false)
    expect(applyBackgroundShellEvent(shells, backgroundSet([], 1_000 + SET_GRACE_MS))).toBe(true)
    expect(shells.size).toBe(0)
  })

  it("counts even if the full set arrives before the start notice, and the start time stays the set's time", () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, backgroundSet(['a'], 500))
    expect(applyBackgroundShellEvent(shells, started('a', { backgrounded: true }, 900))).toBe(false)
    expect(shells.get('a')).toEqual({ startedAt: 500, backgroundedAt: 500, listed: true })
  })

  it('a foreground shell that entered the full set is regarded as moved to background', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('a', { backgrounded: false }))
    applyBackgroundShellEvent(shells, backgroundSet(['a']))
    expect(activeBackgroundShells(shells, 2_000, TIMEOUT)).toBe(1)
  })

  it('a shell past the time limit from its start is not counted (never spins forever on endless work)', () => {
    const shells = new Map<string, BackgroundShell>()
    applyBackgroundShellEvent(shells, started('dev-server', { backgrounded: true }, 0))
    expect(activeBackgroundShells(shells, TIMEOUT - 1, TIMEOUT)).toBe(1)
    expect(activeBackgroundShells(shells, TIMEOUT, TIMEOUT)).toBe(0)
  })

  it('review Y: the time limit boundary is the earliest start of the counted shells + the time limit (null if none)', () => {
    const shells = new Map<string, BackgroundShell>()
    expect(nextBackgroundShellExpiry(shells, 0, TIMEOUT)).toBeNull()
    applyBackgroundShellEvent(shells, started('fg', { backgrounded: false }, 0))
    expect(nextBackgroundShellExpiry(shells, 0, TIMEOUT)).toBeNull()
    applyBackgroundShellEvent(shells, started('b', { backgrounded: true }, 2_000))
    applyBackgroundShellEvent(shells, started('a', { backgrounded: true }, 1_000))
    expect(nextBackgroundShellExpiry(shells, 3_000, TIMEOUT)).toBe(1_000 + TIMEOUT)
    // Expired ones are excluded, up to the next boundary.
    expect(nextBackgroundShellExpiry(shells, 1_000 + TIMEOUT, TIMEOUT)).toBe(2_000 + TIMEOUT)
    expect(nextBackgroundShellExpiry(shells, 2_000 + TIMEOUT, TIMEOUT)).toBeNull()
  })

  it('does not touch subagent work or progress of unknown ids', () => {
    const shells = new Map<string, BackgroundShell>()
    expect(
      applyBackgroundShellEvent(shells, started('agent', { isSubagent: true, isBackgroundShell: false, subagentType: 'x' }))
    ).toBe(false)
    expect(applyBackgroundShellEvent(shells, movedToBackground('unknown'))).toBe(false)
    expect(applyBackgroundShellEvent(shells, finished('unknown'))).toBe(false)
    expect(shells.size).toBe(0)
  })
})

describe('fixture: a background Bash and a Bash moved to background on timeout (synthetic, CLI 2.1.319 schema)', () => {
  const fixture = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'background-shell-2.1.319.jsonl'),
    'utf8'
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
  let counter = 0
  const ctx = {
    sessionId: 'session-1196',
    threadId: 'thread-1196',
    now: () => 1_700_000_000_000,
    newId: () => `e${(counter += 1)}`
  }
  const events = fixture.flatMap((line) => [...parseEvent(line, ctx)])

  it('the start carries foreground or background, moving to background has its own kind, and the full set carries only shell ids', () => {
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
    const starts = events.flatMap((e) =>
      e.kind === 'subtask_started' ? [[e.payload.taskId, e.payload.isBackgroundShell, e.payload.backgrounded]] : []
    )
    expect(starts).toEqual([
      ['b1196000000000001', true, true],
      ['b1196000000000002', true, false]
    ])
    const moved = events.flatMap((e) => (e.kind === 'subtask_backgrounded' ? [e.payload.taskId] : []))
    expect(moved).toEqual(['b1196000000000002'])
    // review Y: do not produce an empty elapsed time from a diff that only moved to the background (a receiver triggered by elapsed time would come up empty).
    const emptyProgress = events.filter(
      (e) => e.kind === 'subtask_progress' && e.payload.status === null && e.payload.description === null && e.payload.usage === null
    )
    expect(emptyProgress).toEqual([])
    const sets = events.flatMap((e) => (e.kind === 'background_tasks' ? [e.payload.shellTaskIds] : []))
    expect(sets).toEqual([
      ['b1196000000000001'],
      ['b1196000000000001', 'b1196000000000002'],
      ['b1196000000000002'],
      []
    ])
  })

  it('counts per turn end (result): 2 → 1 → 0 (stops when all end)', () => {
    const shells = new Map<string, BackgroundShell>()
    const atResult: number[] = []
    for (const e of events) {
      applyBackgroundShellEvent(shells, e)
      if (e.kind === 'result') atResult.push(activeBackgroundShells(shells, e.ts, TIMEOUT))
    }
    expect(atResult).toEqual([2, 1, 0])
    expect(shells.size).toBe(0)
  })

  it('even if all end notices are missed, it returns to 0 with the full set alone', () => {
    const shells = new Map<string, BackgroundShell>()
    for (const e of events) {
      if (e.kind === 'subtask_finished') continue
      applyBackgroundShellEvent(shells, e)
    }
    expect(activeBackgroundShells(shells, 1_700_000_000_000, TIMEOUT)).toBe(0)
    expect(shells.size).toBe(0)
  })
})

describe('busyOf — all AI work tied to a conversation (TODO 1196)', () => {
  const summary = (state: string, subtasks = 0, backgroundShells?: number) => ({
    runtime: {
      state,
      subtasks: Array.from({ length: subtasks }, () => ({})),
      ...(backgroundShells === undefined ? {} : { backgroundShells })
    }
  })

  it("spins during the parent's turn", () => {
    expect(busyOf(summary('running'))).toBe(true)
    expect(busyOf(summary('starting'))).toBe(true)
  })

  it('spins even if the parent is idle when background shells or children remain', () => {
    expect(busyOf(summary('idle', 0, 1))).toBe(true)
    expect(busyOf(summary('idle', 1))).toBe(true)
  })

  it('stops when all end (field absent or 0)', () => {
    expect(busyOf(summary('idle'))).toBe(false)
    expect(busyOf(summary('idle', 0, 0))).toBe(false)
  })

  it('waiting for approval or a question does not spin even if background work remains (a different mark)', () => {
    expect(busyOf(summary('awaiting-approval'))).toBe(false)
    expect(busyOf(summary('awaiting-approval', 1, 1))).toBe(false)
  })
})
