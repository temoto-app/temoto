/**
 * TODO 633 stage 2 (wave 37 bundle C): the memo of 'worktrees whose existence was confirmed' for children running in a worktree (`session/subtask-worktrees.ts`).
 * The material is events from the real fixtures of spike 30 (`test/fixtures/stream-worktree-{agent,batch}.jsonl`) run through the parser and `WorktreeWatch`.
 * git is a fake (the existence check is injected). Neither a model nor the CLI is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AiosEvent } from '../src/shared/agent.js'
import { parseEventWithRaw } from '../src/main/session/adapter/parse.js'
import { WorktreeWatch } from '../src/main/session/adapter/worktree.js'
import { loadBackendPaths, loadCompatTable } from '../src/main/session/adapter/compat.js'
import { FINISH_RECHECK_MS, SubtaskWorktrees, type SubtaskWorktreeDeps } from '../src/main/session/subtask-worktrees.js'
import type { WorktreeEntry } from '../src/main/git/worktree-cleanup.js'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter,
  newId: () => `e${(counter += 1)}`
}
const SUFFIX = loadBackendPaths().worktreesPathSuffix ?? null
const REPO = '/tmp/aios-spike-repo'

function eventsOf(name: string): AiosEvent[] {
  const watch = new WorktreeWatch(REPO, loadCompatTable(), SUFFIX)
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const parsed = parseEventWithRaw(line, ctx)
      return parsed.raw === null ? [...parsed.events] : [...watch.observe(parsed.raw, parsed.events, ctx)]
    })
}

function entry(path: string, branch: string | null, main = false): WorktreeEntry {
  return { path, head: 'abc', branch, locked: null, main }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

interface Rig {
  readonly tracker: SubtaskWorktrees
  readonly changes: string[]
  /** Worktrees git knows about (from the one after the main one). */
  worktrees: WorktreeEntry[]
  listed: number
  gitFails: boolean
  present: Set<string>
  ahead: Set<string>
  clock: number
}

function rig(): Rig {
  const state: Rig = {
    tracker: undefined as unknown as SubtaskWorktrees,
    changes: [],
    worktrees: [],
    listed: 0,
    gitFails: false,
    present: new Set(),
    ahead: new Set(),
    clock: 0
  }
  const deps: SubtaskWorktreeDeps = {
    listWorktrees: async () => {
      state.listed += 1
      return state.gitFails ? null : [entry(REPO, 'main', true), ...state.worktrees]
    },
    exists: async (path) => state.present.has(path),
    hasCommits: async (_repo, branch) => state.ahead.has(branch),
    now: () => state.clock,
    onChange: (threadId) => state.changes.push(threadId)
  }
  return Object.assign(state, { tracker: new SubtaskWorktrees(deps) })
}

const CHILD1 = `${REPO}/.claude/worktrees/agent-a0000000000000001`
const CHILD2 = `${REPO}/.claude/worktrees/agent-a0000000000000002`

beforeEach(() => {
  counter = 0
})

describe('SubtaskWorktrees (TODO 633 stage 2)', () => {
  it('shows only child worktrees that git knows and that exist (2 from /batch, one of them is missing)', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    for (const event of eventsOf('stream-worktree-batch.jsonl').filter((e) => e.kind === 'worktree_changed')) {
      r.tracker.note('t1', event, () => REPO)
    }
    await flush()
    expect(r.tracker.runtimeOf('t1')).toEqual({
      toolu_spike30_0007: {
        branch: 'worktree-agent-a0000000000000001',
        uri: `file://${CHILD1}`,
        committed: false
      }
    })
    expect(r.changes).toContain('t1')
  })

  it("becomes committed on the child's commit notification (vcs_state_changed), but not when the branch differs", async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001'), entry(CHILD2, 'worktree-agent-a0000000000000002')]
    r.present.add(CHILD1)
    r.present.add(CHILD2)
    const events = eventsOf('stream-worktree-batch.jsonl')
    for (const event of events) r.tracker.note('t1', event, () => REPO)
    await flush()
    const table = r.tracker.runtimeOf('t1')
    expect(table?.['toolu_spike30_0007']?.committed).toBe(true)
    expect(table?.['toolu_spike30_0008']?.committed).toBe(true)
  })

  it('shows the real path resolved by git branch even when the guessed path is off because of a subdirectory cwd', async () => {
    const r = rig()
    const real = '/tmp/aios-spike-repo/.claude/worktrees/real-place'
    r.worktrees = [entry(real, 'worktree-agent-a0000000000000001')]
    r.present.add(real)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(Object.values(r.tracker.runtimeOf('t1') ?? {}).map((w) => w.uri)).toEqual([`file://${real}`])
  })

  it('shows nothing when git does not know it, git cannot be called, or the directory is missing', async () => {
    const r = rig()
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')).toBeNull()
    const gitless = rig()
    gitless.gitFails = true
    for (const event of eventsOf('stream-worktree-agent.jsonl')) gitless.tracker.note('t1', event, () => REPO)
    await flush()
    expect(gitless.tracker.runtimeOf('t1')).toBeNull()
    const stale = rig()
    stale.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    for (const event of eventsOf('stream-worktree-agent.jsonl')) stale.tracker.note('t1', event, () => REPO)
    await flush()
    expect(stale.tracker.runtimeOf('t1')).toBeNull()
  })

  it('picks up a worktree created later by re-querying on a progress notification, and does not call git when the interval is short', async () => {
    const r = rig()
    const events = eventsOf('stream-worktree-agent.jsonl').filter((e) => e.kind === 'worktree_changed')
    for (const event of events) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.listed).toBe(1)
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    const progress = { id: 'p', sessionId: 's', threadId: 't', ts: 1, actor: 'subagent', kind: 'subtask_progress', payload: { taskId: 'a' } } as unknown as AiosEvent
    r.clock = 100
    r.tracker.note('t1', progress, () => REPO)
    await flush()
    expect(r.listed).toBe(1)
    r.clock = 5000
    r.tracker.note('t1', progress, () => REPO)
    await flush()
    expect(r.listed).toBe(2)
    expect(r.tracker.runtimeOf('t1')).not.toBeNull()
  })

  it('re-queries when the child ends: the mark of a worktree removed by the CLI is cleared, and the commit is rechecked with git', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(false)
    const finished = { id: 'f', sessionId: 's', threadId: 't', ts: 1, actor: 'main', kind: 'subtask_finished', payload: { taskId: 'a', toolUseId: 'toolu_spike30_0001', status: 'completed', summary: null, usage: null, outputFile: null } } as unknown as AiosEvent
    // Even a commit that no vcs notice reported is found at the final review of the end.
    r.ahead.add('worktree-agent-a0000000000000001')
    r.tracker.note('t1', finished, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(true)
    // A child with no commit: the CLI removes the worktree (spike 32). Asking for the end again clears the mark.
    r.worktrees = []
    r.tracker.note('t1', finished, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')).toBeNull()
  })

  it('does nothing after stop, and forget drops the record', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    r.tracker.forget('t1')
    expect(r.tracker.runtimeOf('t1')).toBeNull()
    r.tracker.stop()
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t2', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t2')).toBeNull()
  })

  /** A foreground child (code-review 1): reorders the real sequence so that the end comes before `worktree_changed` (`child`). */
  function foregroundOrder(): AiosEvent[] {
    const events = eventsOf('stream-worktree-agent.jsonl')
    const finished = events.filter((e) => e.kind === 'subtask_finished')
    const rest = events.filter((e) => e.kind !== 'subtask_finished')
    const at = rest.findIndex((e) => e.kind === 'worktree_changed' && e.payload.change === 'child')
    return [...rest.slice(0, at), ...finished, ...rest.slice(at)]
  }

  it('foreground child: confirms as finished even when the end came first, and checks the commit with git', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    r.ahead.add('worktree-agent-a0000000000000001')
    for (const event of foregroundOrder()) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(true)
  })

  it('foreground child: applies a vcs_state_changed (branch match) that arrived before the entry, and does not apply a different branch', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    const commit = (branch: string): AiosEvent =>
      ({ id: 'v', sessionId: 's', threadId: 't', ts: 1, actor: 'main', kind: 'vcs_state_changed', payload: { change: 'commit', branch, elsewhere: true } }) as unknown as AiosEvent
    r.tracker.note('t1', commit('other-branch'), () => REPO)
    r.tracker.note('t1', commit('worktree-agent-a0000000000000001'), () => REPO)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(true)
    const other = rig()
    other.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    other.present.add(CHILD1)
    other.tracker.note('t1', commit('other-branch'), () => REPO)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) other.tracker.note('t1', event, () => REPO)
    await flush()
    expect(other.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(false)
  })

  it('queries once more when the end arrives during a check (code-review 2)', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    const events = eventsOf('stream-worktree-agent.jsonl')
    const child = events.find((e) => e.kind === 'worktree_changed' && e.payload.change === 'child') as AiosEvent
    const finished = events.find((e) => e.kind === 'subtask_finished') as AiosEvent
    r.tracker.note('t1', child, () => REPO) // The check starts running (still in the middle of an await).
    r.ahead.add('worktree-agent-a0000000000000001')
    r.tracker.note('t1', finished, () => REPO)
    await flush()
    expect(r.listed).toBe(2)
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.committed).toBe(true)
  })

  it('keeps the current mark when git does not answer (null) (code-review 3)', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    const events = eventsOf('stream-worktree-agent.jsonl')
    for (const event of events.filter((e) => e.kind === 'worktree_changed')) r.tracker.note('t1', event, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')).not.toBeNull()
    r.gitFails = true
    r.tracker.note('t1', events.find((e) => e.kind === 'subtask_finished') as AiosEvent, () => REPO)
    await flush()
    expect(r.tracker.runtimeOf('t1')?.['toolu_spike30_0001']?.branch).toBe('worktree-agent-a0000000000000001')
  })

  it('runtimeOf returns the same value until something changes (code-review 8)', async () => {
    const r = rig()
    r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
    r.present.add(CHILD1)
    for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
    await flush()
    const first = r.tracker.runtimeOf('t1')
    expect(r.tracker.runtimeOf('t1')).toBe(first)
    r.tracker.forget('t1')
    expect(r.tracker.runtimeOf('t1')).toBeNull()
  })

  describe('recheck after the end (code-review 7)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('queries once more shortly after the end check and clears the mark of a worktree that disappeared late', async () => {
      const r = rig()
      r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
      r.present.add(CHILD1)
      for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
      await flush()
      expect(r.tracker.runtimeOf('t1')).not.toBeNull()
      const before = r.listed
      r.worktrees = [] // The CLI removed it a little later.
      await vi.advanceTimersByTimeAsync(FINISH_RECHECK_MS + 10)
      await flush()
      expect(r.listed).toBe(before + 1)
      expect(r.tracker.runtimeOf('t1')).toBeNull()
      await vi.advanceTimersByTimeAsync(FINISH_RECHECK_MS * 3)
      expect(r.listed).toBe(before + 1)
    })

    it('the reservation is dropped on stop', async () => {
      const r = rig()
      r.worktrees = [entry(CHILD1, 'worktree-agent-a0000000000000001')]
      r.present.add(CHILD1)
      for (const event of eventsOf('stream-worktree-agent.jsonl')) r.tracker.note('t1', event, () => REPO)
      await flush()
      const before = r.listed
      r.tracker.stop()
      await vi.advanceTimersByTimeAsync(FINISH_RECHECK_MS * 2)
      expect(r.listed).toBe(before)
    })
  })
})
