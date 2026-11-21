/**
 * TODO 633 stage 1 (wave 33 bundle A): read the entering and leaving of a worktree, and the children that run in the worktree, from the stream (`adapter/worktree.ts`).
 * The material is the real one from spike 30 (CLI 2.1.280, `test/fixtures/stream-worktree-*.jsonl`, with paths and ids replaced).
 * Neither the model nor the CLI is called.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AiosEvent, WorktreeChangedPayload } from '../src/shared/agent.js'
import { EPHEMERAL_EVENT_KINDS } from '../src/shared/agent.js'
import { parseEventWithRaw } from '../src/main/session/adapter/parse.js'
import { WorktreeWatch } from '../src/main/session/adapter/worktree.js'
import { isDirectWorktreeOf } from '../src/main/git/worktree-path.js'
import { loadBackendPaths, loadCompatTable } from '../src/main/session/adapter/compat.js'
import { refreshesGitStatus } from '../src/renderer/src/threadStore.js'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter,
  newId: () => `e${(counter += 1)}`
}

const SUFFIX = loadBackendPaths().worktreesPathSuffix ?? null

function run(name: string, spawnCwd = '/tmp/aios-spike-repo'): { events: AiosEvent[]; watch: WorktreeWatch } {
  const watch = new WorktreeWatch(spawnCwd, loadCompatTable(), SUFFIX)
  const events = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const parsed = parseEventWithRaw(line, ctx)
      return parsed.raw === null ? [...parsed.events] : [...watch.observe(parsed.raw, parsed.events, ctx)]
    })
  return { events, watch }
}

function worktreeEvents(events: readonly AiosEvent[]): WorktreeChangedPayload[] {
  return events.flatMap((e) => (e.kind === 'worktree_changed' ? [e.payload] : []))
}

beforeEach(() => {
  counter = 0
})

describe('WorktreeWatch (TODO 633 段 1)', () => {
  it('表と置き場の末尾がある (compat の worktree / backend-paths の worktreesPathSuffix)', () => {
    expect(loadCompatTable().worktree).toBeDefined()
    expect(SUFFIX).not.toBeNull()
  })

  it('会話の途中の EnterWorktree / ExitWorktree は tool_use_result から入る・出るになる', () => {
    const { events, watch } = run('stream-worktree-enter.jsonl')
    const changes = worktreeEvents(events)
    expect(changes).toEqual([
      {
        change: 'enter',
        path: '/tmp/aios-spike-repo/.claude/worktrees/sp30-enter',
        branch: 'worktree-sp30-enter',
        returnCwd: null,
        toolUseId: 'toolu_spike30_0002'
      },
      {
        change: 'exit',
        path: '/tmp/aios-spike-repo/.claude/worktrees/sp30-enter',
        branch: 'worktree-sp30-enter',
        returnCwd: '/tmp/aios-spike-repo',
        toolUseId: 'toolu_spike30_0005'
      }
    ])
    expect(watch.currentCwd).toBe('/tmp/aios-spike-repo')
    // Enter/leave lines do not change the parser's existing lines (they only add). The kind is not saved.
    expect(EPHEMERAL_EVENT_KINDS.has('worktree_changed')).toBe(true)
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })

  it('起動の指定で最初から worktree (init の cwd が置き場の下) なら、起動時に入ったことにする', () => {
    const { events, watch } = run('stream-worktree-flag.jsonl')
    expect(worktreeEvents(events)).toEqual([
      {
        change: 'enter',
        path: '/tmp/aios-spike-repo/.claude/worktrees/sp30-flag',
        branch: 'worktree-sp30-flag',
        returnCwd: null,
        toolUseId: null,
        atLaunch: true
      }
    ])
    expect(watch.currentCwd).toBe('/tmp/aios-spike-repo/.claude/worktrees/sp30-flag')
  })

  it('同じ cwd で再開した (init の cwd が起動の cwd と同じ) なら何も出さない', () => {
    const { events } = run('stream-worktree-flag.jsonl', '/tmp/aios-spike-repo/.claude/worktrees/sp30-flag')
    expect(worktreeEvents(events)).toEqual([])
  })

  it('isolation: worktree の子は、起こした呼び出しの結果の子の id から規約でパスとブランチを組む', () => {
    const { events } = run('stream-worktree-agent.jsonl')
    expect(worktreeEvents(events)).toEqual([
      // code-review fix (TODO 700): notified at the time the child is started (tool_use) too. The path is not known yet.
      {
        change: 'child_start',
        path: '/tmp/aios-spike-repo',
        branch: null,
        returnCwd: null,
        toolUseId: 'toolu_spike30_0001'
      },
      {
        change: 'child',
        path: '/tmp/aios-spike-repo/.claude/worktrees/agent-a0000000000000001',
        branch: 'worktree-agent-a0000000000000001',
        returnCwd: null,
        toolUseId: 'toolu_spike30_0001'
      }
    ])
  })

  it('/batch の 2 本の子も 1 本ずつ (子の中の行や計画の結果は拾わない)', () => {
    const { events } = run('stream-worktree-batch.jsonl')
    const changes = worktreeEvents(events)
    expect(changes.filter((c) => c.change === 'child_start').map((c) => c.toolUseId)).toEqual([
      'toolu_spike30_0007',
      'toolu_spike30_0008'
    ])
    expect(changes.filter((c) => c.change !== 'child_start').map((c) => [c.change, c.path, c.toolUseId])).toEqual([
      ['child', '/tmp/aios-spike-repo/.claude/worktrees/agent-a0000000000000001', 'toolu_spike30_0007'],
      ['child', '/tmp/aios-spike-repo/.claude/worktrees/agent-a0000000000000002', 'toolu_spike30_0008']
    ])
  })

  it('isolation の無い子・知らない呼び出しの結果は拾わない。子の id に / や .. があれば組まない', () => {
    const watch = new WorktreeWatch('/repo', loadCompatTable(), SUFFIX)
    const assistant = (id: string, input: Record<string, unknown>): Record<string, unknown> => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] }
    })
    const launched = (id: string, agentId: string): Record<string, unknown> => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      tool_use_result: { status: 'async_launched', agentId }
    })
    expect(watch.observe(assistant('t1', { prompt: 'x' }), [], ctx)).toEqual([])
    expect(watch.observe(launched('t1', 'a1'), [], ctx)).toEqual([])
    watch.observe(assistant('t2', { isolation: 'worktree' }), [], ctx)
    expect(watch.observe(launched('t2', '../../etc'), [], ctx)).toEqual([])
    watch.observe(assistant('t3', { isolation: 'worktree' }), [], ctx)
    expect(worktreeEvents(watch.observe(launched('t3', 'a3'), [], ctx))).toEqual([
      expect.objectContaining({ change: 'child', path: `/repo${SUFFIX}/agent-a3` })
    ])
  })

  // TODO 1182: CLI 2.1.319 includes worktreePath / worktreeBranch in the final result of a foreground child (the shape is the same as "entered").
  it('TODO 1182: 子の結果に worktreePath が載っても「親が入った」とは読まず、子のパスにそれを使う', () => {
    const { events, watch } = run('stream-worktree-agent-2.1.319.jsonl')
    const changes = worktreeEvents(events)
    expect(changes.some((c) => c.change === 'enter' || c.change === 'exit')).toBe(false)
    expect(changes.filter((c) => c.change === 'child').map((c) => [c.path, c.branch, c.toolUseId])).toEqual([
      ['/tmp/aios-spike-repo/.claude/worktrees/agent-a1182000000000001', 'worktree-agent-a1182000000000001', 'toolu_1182_0001'],
      // Not included in the result of starting a background child, so under the existing convention it is built under the parent's cwd (unchanged).
      ['/tmp/aios-spike-repo/.claude/worktrees/agent-a1182000000000002', 'worktree-agent-a1182000000000002', 'toolu_1182_0003']
    ])
    expect(watch.currentCwd).toBe('/tmp/aios-spike-repo')
  })

  it('TODO 1182: 結果のパスは置き場の直下 1 段のときだけ使う。根は親の cwd でなくてよい。isolation の無い子の結果も出入りにしない', () => {
    const watch = new WorktreeWatch('/repo/sub', loadCompatTable(), SUFFIX)
    const spawn = (id: string, input: Record<string, unknown>): Record<string, unknown> => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] }
    })
    const done = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      tool_use_result: { status: 'completed', agentId: 'a9', ...extra }
    })
    // Even if the parent's cwd is a lower folder, the path the CLI created under the repository root is used as is.
    watch.observe(spawn('t1', { isolation: 'worktree' }), [], ctx)
    expect(
      worktreeEvents(watch.observe(done('t1', { worktreePath: `/repo${SUFFIX}/agent-a9`, worktreeBranch: 'b9' }), [], ctx))
    ).toEqual([expect.objectContaining({ change: 'child', path: `/repo${SUFFIX}/agent-a9`, branch: 'b9' })])
    // A path outside the location or not normalized is not used; it is built by the convention.
    watch.observe(spawn('t2', { isolation: 'worktree' }), [], ctx)
    expect(worktreeEvents(watch.observe(done('t2', { worktreePath: '/etc/x' }), [], ctx))).toEqual([
      expect.objectContaining({ change: 'child', path: `/repo/sub${SUFFIX}/agent-a9`, branch: 'worktree-agent-a9' })
    ])
    watch.observe(spawn('t3', { isolation: 'worktree' }), [], ctx)
    expect(worktreeEvents(watch.observe(done('t3', { worktreePath: `/repo${SUFFIX}/../x` }), [], ctx))).toEqual([
      expect.objectContaining({ change: 'child', path: `/repo/sub${SUFFIX}/agent-a9` })
    ])
    // Even if a child result without isolation carries a path outside the location, it is neither an enter/leave nor a child.
    watch.observe(spawn('t4', { prompt: 'x' }), [], ctx)
    expect(worktreeEvents(watch.observe(done('t4', { worktreePath: '/elsewhere/w' }), [], ctx))).toEqual([])
    expect(watch.currentCwd).toBe('/repo/sub')
    // The "entered" of a move tool call is read.
    watch.observe(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'EnterWorktree', input: {} }] } },
      [],
      ctx
    )
    const enter = done('e1', { worktreePath: `/repo${SUFFIX}/w`, worktreeBranch: 'worktree-w' })
    expect(worktreeEvents(watch.observe(enter, [], ctx))).toEqual([expect.objectContaining({ change: 'enter' })])
    expect(watch.currentCwd).toBe(`/repo${SUFFIX}/w`)
  })

  // wave 77 review fix X: enter/leave comes only from the result of a move tool call.
  it('review X: 子を続けるツール・知らないツールの結果に worktreePath が載っても出入りにしない', () => {
    const watch = new WorktreeWatch('/repo', loadCompatTable(), SUFFIX)
    const call = (id: string, name: string): Record<string, unknown> => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input: { to: 'a9', message: 'go on' } }] }
    })
    const result = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      tool_use_result: { status: 'completed', agentId: 'a9', ...extra }
    })
    const child = { worktreePath: `/repo${SUFFIX}/agent-a9`, worktreeBranch: 'worktree-agent-a9' }
    // The result of a tool that continues a child (neither spawnTools nor moveTools).
    watch.observe(call('s1', 'SendMessage'), [], ctx)
    expect(worktreeEvents(watch.observe(result('s1', child), [], ctx))).toEqual([])
    // A result whose call was not seen (the id was not kept) is the same.
    expect(worktreeEvents(watch.observe(result('x1', child), [], ctx))).toEqual([])
    // Even in the emitted shape (with originalCwd), it is not read unless it is a move tool.
    watch.observe(call('s2', 'SendMessage'), [], ctx)
    expect(worktreeEvents(watch.observe(result('s2', { ...child, originalCwd: '/elsewhere' }), [], ctx))).toEqual([])
    expect(watch.currentCwd).toBe('/repo')
    // A move tool call inside a child (with parent_tool_use_id) is not kept.
    watch.observe({ ...call('m1', 'EnterWorktree'), parent_tool_use_id: 't0' }, [], ctx)
    expect(worktreeEvents(watch.observe(result('m1', child), [], ctx))).toEqual([])
    expect(watch.currentCwd).toBe('/repo')
  })

  it('review X: 入力に isolation の無い子でも、結果のパスが置き場の直下 1 段なら子として覚える (規約では組まない)', () => {
    const watch = new WorktreeWatch('/repo/sub', loadCompatTable(), SUFFIX)
    const spawn = (id: string): Record<string, unknown> => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'isolated-reviewer', prompt: 'x' } }] }
    })
    const done = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      tool_use_result: { status: 'completed', agentId: 'a7', ...extra }
    })
    // Whether it runs in a worktree is not known at the time it is woken, so child_start is not emitted.
    expect(worktreeEvents(watch.observe(spawn('d1'), [], ctx))).toEqual([])
    expect(
      worktreeEvents(watch.observe(done('d1', { worktreePath: `/repo${SUFFIX}/agent-a7`, worktreeBranch: 'worktree-agent-a7' }), [], ctx))
    ).toEqual([
      { change: 'child', path: `/repo${SUFFIX}/agent-a7`, branch: 'worktree-agent-a7', returnCwd: null, toolUseId: 'd1' }
    ])
    // If there is no branch, it is built from the name.
    watch.observe(spawn('d2'), [], ctx)
    expect(worktreeEvents(watch.observe(done('d2', { worktreePath: `/repo${SUFFIX}/agent-a8/` }), [], ctx))).toEqual([
      expect.objectContaining({ change: 'child', path: `/repo${SUFFIX}/agent-a8`, branch: 'worktree-agent-a8' })
    ])
    // If there is no path (a child not running in a worktree), it is not built by the convention.
    watch.observe(spawn('d3'), [], ctx)
    expect(worktreeEvents(watch.observe(done('d3', {}), [], ctx))).toEqual([])
    expect(watch.currentCwd).toBe('/repo/sub')
  })

  it('表が無い (古い compat) なら何も足さない', () => {
    const watch = new WorktreeWatch('/repo', { tasks: loadCompatTable().tasks }, SUFFIX)
    const line = JSON.stringify({ type: 'system', subtype: 'init', cwd: `/repo${SUFFIX}/x` })
    const parsed = parseEventWithRaw(line, ctx)
    expect(worktreeEvents(watch.observe(parsed.raw!, parsed.events, ctx))).toEqual([])
  })

  it('TODO 699: 子の worktree の commit の知らせは elsewhere (BottomBar を取り直さない)、会話の作業フォルダのものは付かない', () => {
    const { events } = run('stream-worktree-batch.jsonl')
    const vcs = events.flatMap((e) => (e.kind === 'vcs_state_changed' ? [e] : []))
    expect(vcs.map((e) => e.payload)).toEqual([
      { change: 'commit', branch: 'worktree-agent-a0000000000000002', elsewhere: true },
      { change: 'commit', branch: 'worktree-agent-a0000000000000001', elsewhere: true }
    ])
    expect(vcs.every((e) => !refreshesGitStatus(e, 'thread-1'))).toBe(true)

    const watch = new WorktreeWatch('/repo', loadCompatTable(), SUFFIX)
    const line = (cwd: string): string => JSON.stringify({ type: 'system', subtype: 'vcs_state_changed', kind: 'push', cwd })
    const own = parseEventWithRaw(line('/repo'), ctx)
    const [mine] = watch.observe(own.raw!, own.events, ctx)
    expect(mine?.kind === 'vcs_state_changed' && mine.payload.elsewhere).toBeUndefined()
    expect(refreshesGitStatus(mine!, 'thread-1')).toBe(true)
    expect(refreshesGitStatus(mine!, 'thread-2')).toBe(false)
    // After the conversation moves into a worktree, changes in that worktree are "its own" changes.
    watch.observe(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'EnterWorktree', input: {} }] } },
      [],
      ctx
    )
    const enter = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
      tool_use_result: { worktreePath: `/repo${SUFFIX}/w`, worktreeBranch: 'worktree-w' }
    }
    watch.observe(enter, [], ctx)
    const moved = parseEventWithRaw(line(`/repo${SUFFIX}/w`), ctx)
    const [inWorktree] = watch.observe(moved.raw!, moved.events, ctx)
    expect(refreshesGitStatus(inWorktree!, 'thread-1')).toBe(true)
    const back = parseEventWithRaw(line('/repo'), ctx)
    const [original] = watch.observe(back.raw!, back.events, ctx)
    expect(refreshesGitStatus(original!, 'thread-1')).toBe(false)
  })

  // code-review fix: one judgment shared with cleanup (`git/worktree-path.ts`). A path that is not normalized is refused.
  it('isDirectWorktreeOf: 置き場の直下 1 段だけ・正規化済みの絶対パスだけ', () => {
    const suffix = '/.wt'
    expect(isDirectWorktreeOf('/repo/.wt/a', '/repo', suffix)).toBe(true)
    expect(isDirectWorktreeOf('/repo/.wt/a/b', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/repo/.wt', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/other/.wt/a', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/repo/.wt/../x', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/repo/.wt/./a', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/repo//.wt/a', '/repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('repo/.wt/a', 'repo', suffix)).toBe(false)
    expect(isDirectWorktreeOf('/repo/.wt/a/', '/repo', suffix)).toBe(true)
  })
})
