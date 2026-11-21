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
  it('ふつうの回は何も印にしない', () => {
    expect(scope({ ...base, target: '/repo/a.txt' })).toBeNull()
  })

  it('束に分ける回: 本体の作業コピーへの書き込みだけ parallel。置き場の中・本体の外・相対は repo で解く', () => {
    const turn = { ...base, parallelTurn: true }
    expect(scope({ ...turn, target: '/repo/a.txt' })).toBe('parallel')
    expect(scope({ ...turn, target: 'src/b.ts' })).toBe('parallel')
    expect(scope({ ...turn, target: '/repo/.wt/agent-1/a.txt' })).toBeNull()
    expect(scope({ ...turn, target: '/home/me/plans/p.md' })).toBeNull()
    expect(scope({ ...turn, target: '/repository/a.txt' })).toBeNull()
  })

  it('worktree で走る子: 子の worktree の外の本体は subtask。相対は子の worktree で解く', () => {
    const child = { ...base, childRoot: '/repo/.wt/agent-1' }
    expect(scope({ ...child, target: '/repo/a.txt' })).toBe('subtask')
    expect(scope({ ...child, target: 'a.txt' })).toBeNull()
    expect(scope({ ...child, target: '/repo/.wt/agent-2/a.txt' })).toBeNull()
  })

  it('会話が worktree に移っている: 本体は worktree。相対は worktree で解く', () => {
    const moved = { ...base, worktreeCwd: '/repo/.wt/feature' }
    expect(scope({ ...moved, target: '/repo/a.txt' })).toBe('worktree')
    expect(scope({ ...moved, target: 'a.txt' })).toBeNull()
    expect(scope({ ...moved, target: '../../a.txt' })).toBe('worktree')
  })

  // Code-review fix: also returns the resolved absolute path (the tracker does not mirror base / resolve).
  it('解いた絶対パスを返す (相対は子の worktree / worktree / repo の順で解く)', () => {
    expect(outsideWriteScope({ ...base, parallelTurn: true, target: 'src/../b.ts' })).toEqual({
      path: '/repo/b.ts',
      scope: 'parallel'
    })
    expect(outsideWriteScope({ ...base, worktreeCwd: '/repo/.wt/f', target: '../../a.txt' })?.path).toBe('/repo/a.txt')
  })

  // Code-review fix: a foreground isolated child writes before its worktree path is known.
  it('子の worktree のパスがまだ分からない isolated の子: 本体の作業コピーの中は subtask、置き場・外は印にしない', () => {
    const child = { ...base, isolatedChild: true }
    expect(scope({ ...child, target: '/repo/a.txt' })).toBe('subtask')
    expect(scope({ ...child, target: '/repo/.wt/agent-9/a.txt' })).toBeNull()
    expect(scope({ ...child, target: '/tmp/x' })).toBeNull()
    // If the path is known, judge by it.
    expect(scope({ ...child, childRoot: '/repo/.wt/agent-9', target: 'a.txt' })).toBeNull()
  })

  it('大文字小文字を畳んで比べる (macOS の既定のボリューム)', () => {
    expect(scope({ ...base, parallelTurn: true, target: '/REPO/a.txt' })).toBe('parallel')
  })
})

describe('OutsideWriteTracker (TODO 700)', () => {
  it('成功した候補だけ 1 回印を返す。子は起こした呼び出しで引く。次の発言で回が替わる', () => {
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
  it('child_start の後、パスが分かる前の子の書き込みも subtask。起こした呼び出しの結果で控えを捨てる', () => {
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

  it('mayMark: 束の回・worktree・子のどれも無ければ偽 (manager は行を引かずに戻る)', () => {
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

describe('startsParallelCommand (TODO 700、compat の worktree.parallelCommands)', () => {
  const commands = loadCompatTable().worktree?.parallelCommands ?? []

  it('表に /batch がある', () => {
    expect(commands).toContain('batch')
  })

  it('/<名前> の後が空白か終わりのときだけ。先頭の空白は許す', () => {
    expect(startsParallelCommand(commands, '/batch split it')).toBe(true)
    expect(startsParallelCommand(commands, '  /batch')).toBe(true)
    expect(startsParallelCommand(commands, '/batch\nmore')).toBe(true)
    expect(startsParallelCommand(commands, '/batches')).toBe(false)
    expect(startsParallelCommand(commands, 'please /batch')).toBe(false)
    expect(startsParallelCommand([], '/batch')).toBe(false)
  })
})
