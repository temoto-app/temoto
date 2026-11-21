// @vitest-environment jsdom
/**
 * TODO 633 stage 2 (wave 37 bundle C): the badge for a child's worktree whose existence was confirmed. It shows '⎇ branch' (with ● if there is a commit) only when main put it in `runtime.subagentWorktrees`. In a block row it can be pressed and opens in Files; in a list row it cannot be pressed (the row itself is the button).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AiosEvent } from '../src/shared/agent.js'
import type { RunningSubtask, SubtaskWorktree, ThreadSummary } from '../src/shared/thread.js'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const childTool = {
  id: 'c1',
  sessionId: 's',
  threadId: 't1',
  ts: 1,
  actor: 'subagent',
  parentToolUseId: 'agent-1',
  kind: 'tool_use',
  payload: { toolUseId: 'c1-tu', name: 'Read', summary: 'f1.ts', input: {}, truncated: false }
} as AiosEvent

const running: RunningSubtask = {
  taskId: 'task-1',
  toolUseId: 'agent-1',
  description: 'ファイルを読む',
  subagentType: 'general-purpose',
  status: 'running',
  startedAt: Date.now() - 5_000,
  usage: null,
  usageAt: null,
  lastToolName: 'Read',
  activity: 'Reading f1.ts',
  model: null
}

const mark: SubtaskWorktree = {
  branch: 'worktree-agent-a1',
  uri: 'file:///repo/.claude/worktrees/agent-a1',
  committed: false
}

async function setup(table: Record<string, SubtaskWorktree> | undefined): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  act(() =>
    useThreads.setState({
      events: { t1: [] },
      approvals: [],
      childEvents: { t1: { 'agent-1': [childTool] } },
      threadsById: {
        t1: {
          thread: {},
          runtime: { subtasks: [running], live: true, ...(table === undefined ? {} : { subagentWorktrees: table }) }
        } as unknown as ThreadSummary
      } as never
    })
  )
}

const renderItem = (item: TimelineItem) => createElement('span', null, item.kind)

async function renderBlock(): Promise<void> {
  const { SubagentBlock } = await import('../src/renderer/src/components/SubagentBlock.js')
  act(() => root.render(createElement(SubagentBlock, { threadId: 't1', toolUseId: 'agent-1', renderItem })))
}

describe('TODO 633 stage 2: worktree mark of a child', () => {
  it('shows nothing when it is not listed', async () => {
    await setup(undefined)
    await renderBlock()
    expect(host.querySelector('.subtask-worktree')).toBeNull()
  })

  it('the chunk row is a pressable button: shows ● when there is a commit, and pressing it opens that location in Files', async () => {
    await setup({ 'agent-1': { ...mark, committed: true } })
    await renderBlock()
    const button = host.querySelector<HTMLButtonElement>('button.subtask-worktree')!
    expect(button.textContent).toBe('⎇ worktree-agent-a1 ●')
    const { useStore } = await import('../src/renderer/src/store.js')
    const reveal = vi.fn(async () => undefined)
    useStore.setState({ reveal } as never)
    act(() => button.click())
    expect(reveal).toHaveBeenCalledWith(mark.uri)
  })

  it('the mark is not pressable in a list row (no nested buttons)', async () => {
    await setup({ 'agent-1': mark })
    const { SubtaskList } = await import('../src/renderer/src/components/SubtaskList.js')
    act(() => root.render(createElement(SubtaskList, { threadId: 't1' })))
    const tag = host.querySelector('.subtask-row .subtask-worktree')!
    expect(tag.tagName).toBe('SPAN')
    expect(tag.textContent).toBe('⎇ worktree-agent-a1')
    expect(host.querySelector('.subtask-row button')).toBeNull()
  })

  it('finished child row (SubtaskFinishedNote): looks up the mark of the given thread, and leaves no trailing space when there is no mark', async () => {
    const { SubtaskFinishedNote } = await import('../src/renderer/src/components/SubtaskList.js')
    const item = {
      kind: 'subtask',
      id: 'fin-1',
      ts: 100,
      taskId: 'task-1',
      toolUseId: 'agent-1',
      description: 'ファイルを読む',
      subagentType: null,
      status: 'completed',
      summary: null,
      usage: null,
      startedAt: 0
    } as const
    await setup({ 'agent-1': mark })
    act(() => root.render(createElement(SubtaskFinishedNote, { item, threadId: 't1' })))
    expect(host.querySelector('.subtask-note-line .subtask-worktree')?.textContent).toBe('⎇ worktree-agent-a1')
    // Another thread is open (looked up by the id passed in, not by activeThreadId).
    act(() => root.render(createElement(SubtaskFinishedNote, { item, threadId: 'other' })))
    expect(host.querySelector('.subtask-worktree')).toBeNull()
    expect(host.querySelector('.subtask-note-line')?.textContent?.endsWith(' ')).toBe(false)
  })
})
