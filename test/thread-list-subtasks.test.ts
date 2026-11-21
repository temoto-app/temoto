// @vitest-environment jsdom
/**
 * Item 322 (wave 17 bundle H): even when the parent returns to `idle`, if subagents running in the background (`ThreadRuntime.subtasks`, item 93) exist, the list row must not look stopped.
 *
 * Rendering `ThreadRow` (`src/renderer/src/components/ThreadList.tsx`) directly in jsdom, it checks:
 * - `state: 'idle'` + 2 children -> a spinner and `×2` appear
 * - 0 children -> nothing appears (as before, idle shows nothing)
 * - only a shell running in the background (not in `subtasks`, as noted in item 105) -> nothing appears
 * Neither a model nor Electron is used (the same design as `test/subagent-block-dom.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RunningSubtask, ThreadSummary } from '../src/shared/thread.js'

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

const subtask = (taskId: string): RunningSubtask => ({
  taskId,
  toolUseId: null,
  description: `子 ${taskId}`,
  subagentType: 'general-purpose',
  status: 'running',
  startedAt: 0,
  usage: null,
  usageAt: null,
  lastToolName: null,
  activity: null,
  model: null
})

function summaryOf(subtasks: readonly RunningSubtask[]): ThreadSummary {
  return {
    thread: {
      id: 't1',
      title: 'タイトル',
      cwdName: 'proj',
      forkedFrom: null,
      rainbow: null,
      unread: false
    },
    runtime: {
      state: 'idle',
      pendingApprovals: 0,
      subtasks
    },
    preview: null
  } as unknown as ThreadSummary
}

async function renderRow(summary: ThreadSummary): Promise<void> {
  const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
  act(() => root.render(createElement(ThreadRow, { summary, active: false, sortKey: 'recent' })))
}

describe('ThreadRow: how background child agents are shown (item 322)', () => {
  it('idle + 2 children shows the spinner and ×2', async () => {
    await renderRow(summaryOf([subtask('a'), subtask('b')]))
    expect(host.querySelector('.state-spinner')).not.toBeNull()
    expect(host.querySelector('.thread-row-subtasks')?.textContent).toBe('×2')
  })

  it('the bubble for 1 child is singular (small observation of TODO 322, wave 17 bundle J: fixed EN `1 subagents running`)', async () => {
    await renderRow(summaryOf([subtask('a')]))
    const badge = host.querySelector('.thread-row-subtasks')
    expect(badge?.textContent).toBe('×1')
    expect(badge?.getAttribute('aria-label')).toBe('1 subagent running')
  })

  it('the bubble for 2 children stays plural', async () => {
    await renderRow(summaryOf([subtask('a'), subtask('b')]))
    expect(host.querySelector('.thread-row-subtasks')?.getAttribute('aria-label')).toBe('2 subagents running')
  })

  it('0 children shows neither the spinner nor a count (stays idle)', async () => {
    await renderRow(summaryOf([]))
    expect(host.querySelector('.state-spinner')).toBeNull()
    expect(host.querySelector('.thread-row-subtasks')).toBeNull()
  })

  it('a background-only shell (isBackgroundShell) is assumed not to be in subtasks, so it is not shown', async () => {
    // A row of isBackgroundShell is only added by applySubtaskEvent for isSubagent (confirmed in test/subtask-list.test.ts), so here the 'not listed' state is rendered as is, to check only that the list does not wrongly show anything.
    await renderRow(summaryOf([]))
    expect(host.querySelector('.state-spinner')).toBeNull()
    expect(host.querySelector('.thread-row-subtasks')).toBeNull()
  })
})
