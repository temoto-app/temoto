/**
 * TODO 700 (wave 33 bundle A): the judgment (a pure function) of writes into the main working copy in a run split by worktree, and
 * recognizing the remarks that start a run split into bundles (the Adapter's table). Neither the model nor the CLI is called.
 */
import { describe, expect, it } from 'vitest'
import { OutsideWriteTracker, outsideWriteScope } from '../src/main/session/outside-writes.js'
import { startsParallelCommand } from '../src/main/session/adapter/worktree.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'

const S = '/.wt'
const base = { repoCwd: '/repo', worktreeCwd: null, childRoot: null, parallelTurn: false, suffix: S }
const scope = (context: Parameters<typeof outsideWriteScope>[0]) => outsideWriteScope(context)?.scope ?? null

describe('outsideWriteScope (TODO 700)', () => {
  it('marks nothing for an ordinary turn', () => {
    expect(scope({ ...base, target: '/repo/a.txt' })).toBeNull()
  })

  it('a turn split into bundles: only writes to the main working copy are parallel; inside the storage area, outside the main one and relative ones are resolved by repo', () => {
    const turn = { ...base, parallelTurn: true }
    expect(scope({ ...turn, target: '/repo/a.txt' })).toBe('parallel')
    expect(scope({ ...turn, target: 'src/b.ts' })).toBe('parallel')
    expect(scope({ ...turn, target: '/repo/.wt/agent-1/a.txt' })).toBeNull()
    expect(scope({ ...turn, target: '/home/me/plans/p.md' })).toBeNull()
    expect(scope({ ...turn, target: '/repository/a.txt' })).toBeNull()
  })

  it("a child running in a worktree: the main copy outside the child's worktree is subtask; relative paths are resolved by the child's worktree", () => {
    const child = { ...base, childRoot: '/repo/.wt/agent-1' }
    expect(scope({ ...child, target: '/repo/a.txt' })).toBe('subtask')
    expect(scope({ ...child, target: 'a.txt' })).toBeNull()
    expect(scope({ ...child, target: '/repo/.wt/agent-2/a.txt' })).toBeNull()
  })

  it('the conversation has moved to a worktree: the main copy is worktree; relative paths are resolved by the worktree', () => {
    const moved = { ...base, worktreeCwd: '/repo/.wt/feature' }
    expect(scope({ ...moved, target: '/repo/a.txt' })).toBe('worktree')
    expect(scope({ ...moved, target: 'a.txt' })).toBeNull()
    expect(scope({ ...moved, target: '../../a.txt' })).toBe('worktree')
  })

  // Code-review fix: also returns the resolved absolute path (the tracker does not mirror base / resolve).
  it("returns the resolved absolute path (relative paths are resolved by the child's worktree / worktree / repo in that order)", () => {
    expect(outsideWriteScope({ ...base, parallelTurn: true, target: 'src/../b.ts' })).toEqual({
      path: '/repo/b.ts',
      scope: 'parallel'
    })
    expect(outsideWriteScope({ ...base, worktreeCwd: '/repo/.wt/f', target: '../../a.txt' })?.path).toBe('/repo/a.txt')
  })

  // Code-review fix: a foreground isolated child writes before its worktree path is known.
  it('an isolated child whose worktree path is not yet known: inside the main working copy is subtask; the storage area and outside are not marked', () => {
    const child = { ...base, isolatedChild: true }
    expect(scope({ ...child, target: '/repo/a.txt' })).toBe('subtask')
    expect(scope({ ...child, target: '/repo/.wt/agent-9/a.txt' })).toBeNull()
    expect(scope({ ...child, target: '/tmp/x' })).toBeNull()
    // If the path is known, judge by it.
    expect(scope({ ...child, childRoot: '/repo/.wt/agent-9', target: 'a.txt' })).toBeNull()
  })

  it('compares with case folded (the default macOS volume)', () => {
    expect(scope({ ...base, parallelTurn: true, target: '/REPO/a.txt' })).toBe('parallel')
  })
})

describe('OutsideWriteTracker (TODO 700)', () => {
  it('returns a mark once for successful candidates only; a child is looked up by the call that spawned it; the next utterance changes the turn', () => {
    const tracker = new OutsideWriteTracker()
    tracker.startTurn('t', true)
    tracker.noteWrite('t', { toolUseId: 'a', target: '/repo/a.txt', parentToolUseId: null, repoCwd: '/repo', worktreeCwd: null })
    expect(tracker.noteResult('t', 'a', false)).toBeNull()
    tracker.noteWrite('t', { toolUseId: 'b', target: '/repo/b.txt', parentToolUseId: null, repoCwd: '/repo', worktreeCwd: null })
    expect(tracker.noteResult('t', 'b', true)).toEqual({ toolUseId: 'b', path: '/repo/b.txt', scope: 'parallel' })
    expect(tracker.noteResult('t', 'b', true)).toBeNull()
    tracker.startTurn('t', false)
    tracker.noteWrite('t', { toolUseId: 'c', target: '/repo/c.txt', parentToolUseId: null, repoCwd: '/repo', worktreeCwd: null })
    expect(tracker.noteResult('t', 'c', true)).toBeNull()
    tracker.noteChild('t', 'spawn', '/repo/.claude/worktrees/agent-1')
    tracker.noteWrite('t', { toolUseId: 'd', target: '/repo/d.txt', parentToolUseId: 'spawn', repoCwd: '/repo', worktreeCwd: null })
    expect(tracker.noteResult('t', 'd', true)?.scope).toBe('subtask')
    tracker.forget('t')
    expect(tracker.noteResult('t', 'd', true)).toBeNull()
  })

  // Code-review fix (TODO 700): a foreground isolated child's result for the call that started it (= `child`) comes after the child ends.
  it("a child's write after child_start and before the path is known is also subtask; the record is dropped by the result of the spawning call", () => {
    const tracker = new OutsideWriteTracker()
    tracker.startTurn('t', false)
    tracker.noteChildStart('t', 'spawn')
    const write = { target: '/repo/a.txt', parentToolUseId: 'spawn', repoCwd: '/repo', worktreeCwd: null }
    tracker.noteWrite('t', { ...write, toolUseId: 'e1' })
    // A write refused by the CLI's isolation check (spike 30) is not marked.
    expect(tracker.noteResult('t', 'e1', false)).toBeNull()
    tracker.noteWrite('t', { ...write, toolUseId: 'e2' })
    expect(tracker.noteResult('t', 'e2', true)).toEqual({ toolUseId: 'e2', path: '/repo/a.txt', scope: 'subtask' })
    // The end of the child (the result of the call that started it). From then on there is no record, so writes from the same parent are not marked.
    tracker.noteResult('t', 'spawn', true)
    expect(tracker.mayMark('t')).toBe(false)
    tracker.noteWrite('t', { ...write, toolUseId: 'e3' })
    expect(tracker.noteResult('t', 'e3', true)).toBeNull()
  })

  it('mayMark: false when there is no bundle turn, worktree or child (the manager returns without looking up the row)', () => {
    const tracker = new OutsideWriteTracker()
    expect(tracker.mayMark('t')).toBe(false)
    tracker.startTurn('t', false)
    expect(tracker.mayMark('t')).toBe(false)
    tracker.setWorktreeActive('t', true)
    expect(tracker.mayMark('t')).toBe(true)
    tracker.setWorktreeActive('t', false)
    expect(tracker.mayMark('t')).toBe(false)
    tracker.startTurn('t', true)
    expect(tracker.mayMark('t')).toBe(true)
    tracker.startTurn('t', false)
    tracker.noteChild('t', 's', '/repo/.wt/agent-1')
    expect(tracker.mayMark('t')).toBe(true)
    tracker.setWorktreeActive('u', false)
    expect(tracker.mayMark('u')).toBe(false)
  })
})

describe('startsParallelCommand (TODO 700, compat worktree.parallelCommands)', () => {
  const commands = loadCompatTable().worktree?.parallelCommands ?? []

  it('/batch is in the table', () => {
    expect(commands).toContain('batch')
  })

  it('only when what follows /<name> is whitespace or the end; leading whitespace is allowed', () => {
    expect(startsParallelCommand(commands, '/batch split it')).toBe(true)
    expect(startsParallelCommand(commands, '  /batch')).toBe(true)
    expect(startsParallelCommand(commands, '/batch\nmore')).toBe(true)
    expect(startsParallelCommand(commands, '/batches')).toBe(false)
    expect(startsParallelCommand(commands, 'please /batch')).toBe(false)
    expect(startsParallelCommand([], '/batch')).toBe(false)
  })
})
