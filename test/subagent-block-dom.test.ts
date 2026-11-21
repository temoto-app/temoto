// @vitest-environment jsdom
/**
 * Item 257 (wave 15 bundle A): renders in jsdom the block of a subagent (`SubagentBlock`) and the list above the prompt field (`SubtaskList`). Neither a model nor Electron is used.
 *
 * - The block looks up only its own children's rows (`childEvents`). By default it shows the last few steps and '+N'; pressing it shows all, and pressing again folds it back.
 * - While running, the first line on top is 'current activity · elapsed time · tokens · tool count'.
 * - The list is one vertical line per entry (TODO 403): status mark · description · model · elapsed time · tokens · current activity. Pressing it scrolls to the block and highlights its frame. ↑↓ moves between rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AiosEvent } from '../src/shared/agent.js'
import type { ApprovalItem, RunningSubtask, ThreadSummary } from '../src/shared/thread.js'
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

const childTool = (n: number): AiosEvent =>
  ({
    id: `c${n}`,
    sessionId: 's',
    threadId: 't1',
    ts: n,
    actor: 'subagent',
    parentToolUseId: 'agent-1',
    kind: 'tool_use',
    payload: { toolUseId: `c${n}-tu`, name: 'Read', summary: `f${n}.ts`, input: {}, truncated: false }
  }) as AiosEvent

const running: RunningSubtask = {
  taskId: 'task-1',
  toolUseId: 'agent-1',
  description: 'ファイルを読む',
  subagentType: 'general-purpose',
  status: 'running',
  startedAt: Date.now() - 5_000,
  usage: { totalTokens: 12_300, toolUses: 6, durationMs: 4_000 },
  usageAt: Date.now(),
  lastToolName: 'Read',
  activity: 'Reading f6.ts',
  model: null
}

async function setup(
  events: readonly AiosEvent[],
  subtasks: readonly RunningSubtask[],
  extra: { parent?: readonly AiosEvent[]; approvals?: readonly ApprovalItem[]; live?: boolean } = {}
) {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  act(() =>
    useThreads.setState({
      events: { t1: extra.parent ?? [] },
      approvals: extra.approvals ?? [],
      childEvents: { t1: { 'agent-1': events } },
      threadsById: {
        // The default (when omitted) is the backend that is running (an observation of item 333, wave 18).
        t1: { thread: {}, runtime: { subtasks, live: extra.live ?? true } } as unknown as ThreadSummary
      } as never
    })
  )
  return useThreads
}

const renderItem = (item: TimelineItem) =>
  createElement('span', { className: 'step' }, item.kind === 'tool' ? item.summary : item.kind)

async function renderBlock(): Promise<void> {
  const { SubagentBlock } = await import('../src/renderer/src/components/SubagentBlock.js')
  act(() => root.render(createElement(SubagentBlock, { threadId: 't1', toolUseId: 'agent-1', renderItem })))
}

const steps = (): string[] => [...host.querySelectorAll('.step')].map((el) => el.textContent ?? '')

describe('SubagentBlock (項目 257)', () => {
  it('既定は直近 3 手と「+N」。押すと全部、もう一度で畳む', async () => {
    await setup([1, 2, 3, 4, 5, 6].map(childTool), [])
    await renderBlock()
    expect(steps()).toEqual(['f4.ts', 'f5.ts', 'f6.ts'])
    const more = host.querySelector<HTMLButtonElement>('.subagent-more')!
    expect(more.textContent).toMatch(/3/)
    act(() => more.click())
    expect(steps()).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'])
    const collapse = host.querySelectorAll<HTMLButtonElement>('.subagent-more')
    expect(collapse).toHaveLength(1)
    act(() => collapse[0]!.click())
    expect(steps()).toHaveLength(3)
    // Holds the id of the jump destination, and the conversation search's jump target (`ev-<id>`).
    expect(host.querySelector('#subagent-agent-1')).not.toBeNull()
    expect(host.querySelector('#ev-c6')).not.toBeNull()
  })

  it('子の行も動いている控えも無ければ何も描かない (子を起こさないツール呼び出し)', async () => {
    await setup([], [])
    await renderBlock()
    expect(host.innerHTML).toBe('')
  })

  it('動いている間は先頭にいまの活動・トークン・ツール回数の 1 行', async () => {
    await setup([childTool(1)], [running])
    await renderBlock()
    const line = host.querySelector('.subagent-running')!
    expect(line.querySelector('.subagent-activity')?.textContent).toBe('Reading f6.ts')
    expect(line.querySelector('.subagent-stats')?.textContent).toMatch(/12\.3k/)
    expect(line.querySelector('.subagent-stats')?.textContent).toMatch(/6/)
  })
})

describe('SubtaskList (項目 257 → TODO 403 で 1 本 = 1 行の縦の一覧)', () => {
  it('見出しは独立した 1 行、1 本 = 1 行のボタン。押すと塊へスクロールして枠を強調する', async () => {
    await setup([childTool(1)], [running])
    const { SubtaskList } = await import('../src/renderer/src/components/SubtaskList.js')
    const { SubagentBlock } = await import('../src/renderer/src/components/SubagentBlock.js')
    act(() =>
      root.render(
        createElement('div', null, [
          createElement(SubagentBlock, { key: 'b', threadId: 't1', toolUseId: 'agent-1', renderItem }),
          createElement(SubtaskList, { key: 'l', threadId: 't1' })
        ])
      )
    )
    const list = host.querySelector('.subtask-list')!
    const header = list.querySelector('.subtask-header')!
    expect(header.textContent).toMatch(/1/)
    // The heading is a separate element outside the row container (.subtask-rows).
    expect(header.closest('.subtask-rows')).toBeNull()
    const chips = list.querySelectorAll<HTMLButtonElement>('.subtask-rows > .subtask-row')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toContain('ファイルを読む')

    const block = host.querySelector<HTMLElement>('#subagent-agent-1')!
    const scroll = vi.fn()
    block.scrollIntoView = scroll
    act(() => chips[0]!.click())
    expect(scroll).toHaveBeenCalled()
    expect(host.querySelector('#subagent-agent-1')?.classList.contains('flash')).toBe(true)
  })
})

/**
 * Item 321 (wave 17 bundle G): tells states apart by the color of the vertical line (the block's class) and by a mark. It does not rely on color alone, so it checks both the class and the mark's text.
 */
describe('項目 321: 子の塊の状態の色と印', () => {
  const finishedEvent = (status: 'completed' | 'failed' | 'stopped'): AiosEvent =>
    ({
      id: `fin-${status}`,
      sessionId: 's',
      threadId: 't1',
      ts: 100,
      actor: 'main',
      kind: 'subtask_finished',
      payload: {
        taskId: 'task-1',
        toolUseId: 'agent-1',
        status,
        summary: 'done',
        usage: { totalTokens: 19_500, toolUses: 1, durationMs: 16_000 },
        outputFile: null
      }
    }) as AiosEvent

  const approval = (taskId: string): ApprovalItem =>
    ({
      id: 'ap-1',
      threadId: 't1',
      threadTitle: 't',
      toolName: 'Bash',
      summary: 'rm -rf /tmp/x',
      input: { command: 'rm -rf /tmp/x' },
      requestedAt: Date.now(),
      questions: null,
      subtask: { taskId, description: 'ファイルを読む' }
    }) as ApprovalItem

  const block = (): HTMLElement => host.querySelector<HTMLElement>('#subagent-agent-1')!
  const mark = (): Element => block().querySelector('.subagent-running .subtask-mark')!

  it('動いている: 縦線は既定の色 (subagent-state-running) で、印はスピナー', async () => {
    await setup([childTool(1)], [running])
    await renderBlock()
    expect(block().classList.contains('subagent-state-running')).toBe(true)
    expect(mark().querySelector('.spinner, svg, span')).not.toBeNull()
    expect(mark().textContent).not.toMatch(/[⏸✓✕■]/)
  })

  it('承認待ち: その子のツール呼び出しの承認が受信箱にあれば ⏸ と「承認待ち」', async () => {
    await setup([childTool(1)], [running], { approvals: [approval('task-1')] })
    await renderBlock()
    expect(block().classList.contains('subagent-state-waiting')).toBe(true)
    expect(mark().textContent).toBe('⏸')
    expect(block().querySelector('.subagent-activity')?.textContent).toMatch(/承認待ち|Waiting for permission/)
    expect(block().querySelector('.subagent-activity')?.textContent).toContain('Reading f6.ts')
  })

  it('別の子の承認では承認待ちにならない', async () => {
    await setup([childTool(1)], [running], { approvals: [approval('task-other')] })
    await renderBlock()
    expect(block().classList.contains('subagent-state-running')).toBe(true)
  })

  for (const [status, cls, glyph] of [
    ['completed', 'subagent-state-done', '✓'],
    ['failed', 'subagent-state-failed', '✕'],
    ['stopped', 'subagent-state-stopped', '■']
  ] as const) {
    it(`終わった (${status}): ${glyph} と、所要時間・トークン・ツール回数の行を残す`, async () => {
      await setup([childTool(1)], [], { parent: [finishedEvent(status)] })
      await renderBlock()
      expect(block().classList.contains(cls)).toBe(true)
      expect(mark().textContent).toBe(glyph)
      const stats = block().querySelector('.subagent-stats')?.textContent ?? ''
      expect(stats).toMatch(/0:16/)
      expect(stats).toMatch(/19\.5k/)
    })
  }

  it('終わりの通知も控えも無い (前のページの子) なら色も印も付けない', async () => {
    await setup([childTool(1)], [])
    await renderBlock()
    // (`flash` is left over from a jump from the list in an earlier check. Only the state class is checked.)
    expect([...block().classList].filter((name) => name.startsWith('subagent-state-'))).toEqual([])
    expect(block().querySelector('.subagent-running')).toBeNull()
  })

  it('一覧のボタンにも同じ印: 動いている = スピナー、承認待ち = ⏸', async () => {
    const second: RunningSubtask = { ...running, taskId: 'task-2', toolUseId: 'agent-2', description: '別の子' }
    await setup([childTool(1)], [running, second], { approvals: [approval('task-2')] })
    const { SubtaskList } = await import('../src/renderer/src/components/SubtaskList.js')
    act(() => root.render(createElement(SubtaskList, { threadId: 't1' })))
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.subtask-row')]
    expect(chips).toHaveLength(2)
    expect(chips[0]!.classList.contains('subagent-state-running')).toBe(true)
    expect(chips[0]!.querySelector('.subtask-mark')?.textContent).not.toBe('⏸')
    expect(chips[1]!.classList.contains('subagent-state-waiting')).toBe(true)
    expect(chips[1]!.querySelector('.subtask-mark')?.textContent).toBe('⏸')
    expect(chips[1]!.title).toMatch(/承認待ち|Waiting for permission/)
  })
})

/**
 * Observation for item 333 (wave 18, owner decision 2026-10-03): once a child becomes Stopped / Failed, the rows of tool calls inside its block that have no result yet are not left as 'running'. They are aligned with the same 'interrupted' (`tool.interrupted`) as the parent's tool calls (280-5). Rows of a child whose parent process died while still awaiting approval (with no end notice at all) are treated the same way. `renderItem` is not the real `ToolBlock` but a light substitute that only shows `item.interrupted` as text (checking the block's wiring, the `ended` judgment and passing `live` to `foldSubagentBlock`, is enough; the wording and appearance are checked in `test/timeline-interrupted.test.ts`).
 */
describe('項目 333: 停止した子の未完の行は「中断」(第 18 波)', () => {
  const interruptionRenderItem = (item: TimelineItem) =>
    createElement(
      'span',
      { className: 'step' },
      item.kind !== 'tool'
        ? item.kind
        : item.interrupted === true
          ? 'INTERRUPTED'
          : item.result === null
            ? 'RUNNING'
            : 'DONE'
    )

  async function renderWithInterruptionMarkers(): Promise<void> {
    const { SubagentBlock } = await import('../src/renderer/src/components/SubagentBlock.js')
    act(() =>
      root.render(
        createElement(SubagentBlock, { threadId: 't1', toolUseId: 'agent-1', renderItem: interruptionRenderItem })
      )
    )
  }

  const finishedEvent = (status: 'completed' | 'failed' | 'stopped'): AiosEvent =>
    ({
      id: `fin-${status}`,
      sessionId: 's',
      threadId: 't1',
      ts: 100,
      actor: 'main',
      kind: 'subtask_finished',
      payload: {
        taskId: 'task-1',
        toolUseId: 'agent-1',
        status,
        summary: 'done',
        usage: { totalTokens: 1000, toolUses: 1, durationMs: 1000 },
        outputFile: null
      }
    }) as AiosEvent

  it('子が Stopped になった: 未完の子のツールは RUNNING のまま残らず INTERRUPTED になる', async () => {
    await setup([childTool(1)], [], { parent: [finishedEvent('stopped')] })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })

  it('子が Failed になった: 同じく INTERRUPTED', async () => {
    await setup([childTool(1)], [], { parent: [finishedEvent('failed')] })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })

  it('子が Completed (正常終了) なら、普通の DONE のまま (結果は別イベントで届いている想定ではなく、ここでは未完の行が無い通常の場合)', async () => {
    // A row whose result arrived is neither Completed nor interrupted when Stopped (as in 280-5: the result wins).
    const done: AiosEvent = {
      id: 'c1-result',
      sessionId: 's',
      threadId: 't1',
      ts: 2,
      actor: 'subagent',
      parentToolUseId: 'agent-1',
      kind: 'tool_result',
      payload: { toolUseId: 'c1-tu', ok: true, bytes: 5 }
    } as AiosEvent
    await setup([childTool(1), done], [], { parent: [finishedEvent('completed')] })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['DONE'])
  })

  it('動いている最中 (終わりの通知も無く、全体のプロセスも生きている) は RUNNING のまま', async () => {
    await setup([childTool(1)], [running], { live: true })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['RUNNING'])
  })

  it('承認待ちのまま親プロセスが死んだ子 (終わりの通知が無い、状態なし) も INTERRUPTED になる', async () => {
    // There is no running record (`subtasks: []`, since the process died it is also gone from the runtime), and no end notice either (it died without seeing `subtask_finished`), but the thread-wide `runtime.live` is false.
    await setup([childTool(1)], [], { live: false })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })

  it('再起動後に保存済みのイベントから描くとき (live: false) も同じ結果になる', async () => {
    await setup([childTool(1)], [], { parent: [finishedEvent('failed')], live: false })
    await renderWithInterruptionMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })
})

/**
 * TODO 351 (351-3, wave 18 bundle D): if the CLI process dies while awaiting approval, main (`ApprovalBroker`) withdraws the dangling approval as `allowed: false, by: 'system'` (nobody rejected it). `ToolBlock` in `ThreadPane.tsx` checks `denied` before `interrupted` when the approval is `denied`, so that row showed 'rejected' instead of 'interrupted'. The 'interrupted' derived from `runtime.live` in bundle C does not apply to this path (the row that has an approval event). `statusRenderItem` is a substitute that copies `ToolBlock`'s display priority as is (pending -> denied(user) -> [interrupted or denied(system)] -> running/done).
 */
describe('項目 351-3: 承認の取り下げ (by: system) は「中断」、利用者の拒否は「拒否」のまま', () => {
  const statusRenderItem = (item: TimelineItem) => {
    if (item.kind !== 'tool') return createElement('span', { className: 'step' }, item.kind)
    const deniedBySystem =
      item.approval !== null && item.approval.outcome.kind === 'denied' && item.approval.outcome.by === 'system'
    const text =
      item.approval !== null && item.approval.outcome.kind === 'pending'
        ? 'AWAITING_APPROVAL'
        : item.approval !== null && item.approval.outcome.kind === 'denied' && !deniedBySystem
          ? 'DENIED'
          : item.result === null
            ? item.interrupted === true || deniedBySystem
              ? 'INTERRUPTED'
              : 'RUNNING'
            : 'DONE'
    return createElement('span', { className: 'step' }, text)
  }

  async function renderWithStatusMarkers(): Promise<void> {
    const { SubagentBlock } = await import('../src/renderer/src/components/SubagentBlock.js')
    act(() =>
      root.render(createElement(SubagentBlock, { threadId: 't1', toolUseId: 'agent-1', renderItem: statusRenderItem }))
    )
  }

  const permissionEvent = (
    outcome: { kind: 'pending' } | { kind: 'denied'; by: 'user' | 'system'; message: string }
  ): AiosEvent =>
    ({
      id: `perm-${outcome.kind}-${'by' in outcome ? outcome.by : ''}`,
      sessionId: 's',
      threadId: 't1',
      ts: 50,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: 'req-1',
        toolUseId: 'c1-tu',
        toolName: 'Bash',
        summary: 'rm -rf /tmp/x',
        requestedAt: 40,
        decidedAt: outcome.kind === 'pending' ? null : 60,
        outcome
      }
    }) as AiosEvent

  it('承認待ちのまま親プロセスが死に、system が取り下げた (by: system) → INTERRUPTED (拒否ではない)', async () => {
    await setup(
      [childTool(1), permissionEvent({ kind: 'pending' }), permissionEvent({ kind: 'denied', by: 'system', message: 'セッションが終了しました' })],
      [],
      { live: false }
    )
    await renderWithStatusMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })

  it('利用者が自分で断った (by: user) ときは、これまでどおり DENIED のまま', async () => {
    await setup(
      [childTool(1), permissionEvent({ kind: 'pending' }), permissionEvent({ kind: 'denied', by: 'user', message: '却下' })],
      [],
      { live: true }
    )
    await renderWithStatusMarkers()
    expect(steps()).toEqual(['DENIED'])
  })

  it('再起動後に保存済みのイベントから描くとき (live: false) も同じ結果になる (system の取り下げ)', async () => {
    await setup(
      [childTool(1), permissionEvent({ kind: 'pending' }), permissionEvent({ kind: 'denied', by: 'system', message: 'セッションが終了しました' })],
      [],
      { live: false }
    )
    await renderWithStatusMarkers()
    expect(steps()).toEqual(['INTERRUPTED'])
  })
})

/**
 * TODO 403 (wave 21 bundle C): the columns of a list row (status mark · description · model · elapsed time · tokens · current activity) and ↑↓; the first line of the block and the model of finished children's rows. The model is only in the runtime (`subtasks[].model` / `subagentModels`).
 */
describe('TODO 403: 子の一覧の行の列と model', () => {
  const withModel: RunningSubtask = { ...running, model: 'Sonnet 5' }

  async function renderList(): Promise<void> {
    const { SubtaskList } = await import('../src/renderer/src/components/SubtaskList.js')
    act(() => root.render(createElement(SubtaskList, { threadId: 't1' })))
  }

  it('行の列は 印 · 説明 · model · 経過時間 · トークン · いまの活動 の順', async () => {
    await setup([childTool(1)], [withModel])
    await renderList()
    const row = host.querySelector<HTMLButtonElement>('.subtask-row')!
    const cells = [...row.children].map((el) => el.className.split(' ')[0])
    expect(cells).toEqual([
      'subtask-mark',
      'subtask-desc',
      'subtask-model',
      'subtask-time',
      'subtask-tokens',
      'subtask-activity'
    ])
    expect(row.querySelector('.subtask-desc')?.textContent).toBe('ファイルを読む')
    expect(row.querySelector('.subtask-model')?.textContent).toBe('Sonnet 5')
    expect(row.querySelector('.subtask-time')?.textContent).toMatch(/^\d+:\d{2}$/)
    expect(row.querySelector('.subtask-tokens')?.textContent).toBe('12.3k')
    expect(row.querySelector('.subtask-activity')?.textContent).toBe('Reading f6.ts')
    expect(row.title).toContain('Sonnet 5')
  })

  it('model がまだ無い子・経過の来ていない子は空の列 (列は揃えたまま)', async () => {
    const fresh: RunningSubtask = {
      ...running,
      usage: null,
      usageAt: null,
      activity: null,
      lastToolName: null,
      model: null
    }
    await setup([], [fresh])
    await renderList()
    const row = host.querySelector<HTMLButtonElement>('.subtask-row')!
    expect(row.querySelector('.subtask-model')?.textContent).toBe('')
    expect(row.querySelector('.subtask-tokens')?.textContent).toBe('')
    expect(row.querySelector('.subtask-activity')?.textContent).toBe('')
  })

  it('↑↓ で行を移る (端で止まる)', async () => {
    const second: RunningSubtask = { ...running, taskId: 'task-2', toolUseId: 'agent-2', description: '別の子' }
    const third: RunningSubtask = { ...running, taskId: 'task-3', toolUseId: 'agent-3', description: '三つ目' }
    await setup([], [running, second, third])
    await renderList()
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.subtask-row')]
    const list = host.querySelector<HTMLElement>('.subtask-rows')!
    const press = (key: string): void => {
      act(() => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    rows[0]!.focus()
    press('ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    press('End')
    expect(document.activeElement).toBe(rows[2])
    press('ArrowDown')
    expect(document.activeElement).toBe(rows[2])
    press('ArrowUp')
    expect(document.activeElement).toBe(rows[1])
  })

  it('塊の先頭の 1 行 (動いている間) も model · 経過時間 · トークン の並び', async () => {
    await setup([childTool(1)], [withModel])
    await renderBlock()
    const stats = host.querySelector('.subagent-running .subagent-stats')?.textContent ?? ''
    expect(stats).toMatch(/^Sonnet 5 · \d+:\d{2} · 12\.3k/)
  })

  it('終わった子の塊と行: runtime に model があれば出し、無ければ所要時間から (再起動後)', async () => {
    const finished = {
      id: 'fin-1',
      sessionId: 's',
      threadId: 't1',
      ts: 100,
      actor: 'main',
      kind: 'subtask_finished',
      payload: {
        taskId: 'task-1',
        toolUseId: 'agent-1',
        status: 'completed',
        summary: null,
        usage: { totalTokens: 19_500, toolUses: 1, durationMs: 16_000 },
        outputFile: null
      }
    } as AiosEvent
    const store = await setup([childTool(1)], [], { parent: [finished] })
    act(() =>
      store.setState((state) => ({
        activeThreadId: 't1',
        threadsById: {
          t1: {
            ...state.threadsById['t1']!,
            runtime: { ...state.threadsById['t1']!.runtime, subagentModels: { 'agent-1': 'Haiku 4.5' } }
          }
        } as never
      }))
    )
    await renderBlock()
    expect(host.querySelector('.subagent-stats')?.textContent).toMatch(/^Haiku 4\.5 · 0:16/)

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
      usage: { totalTokens: 19_500, toolUses: 1, durationMs: 16_000 },
      startedAt: 0
    } as const
    act(() => root.render(createElement(SubtaskFinishedNote, { item, threadId: 't1' })))
    expect(host.querySelector('.subtask-note-line')?.textContent).toMatch(/Haiku 4\.5 · .* · 0:16/)

    // After a restart (not in the runtime): no model is shown, and the duration stays as it is.
    act(() =>
      store.setState((state) => ({
        threadsById: {
          t1: { ...state.threadsById['t1']!, runtime: { subtasks: [], live: false } }
        } as never
      }))
    )
    expect(host.querySelector('.subtask-note-line')?.textContent).not.toContain('Haiku')
    expect(host.querySelector('.subtask-note-line')?.textContent).toMatch(/0:16/)
  })
})
