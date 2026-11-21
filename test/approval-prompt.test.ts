// @vitest-environment jsdom
/**
 * Item 182 (wave 14 bundle C): the screen that shows permission requests and plan approvals in the Composer's place (`ApprovalPrompt`) is actually drawn in jsdom,
 * and what reaches `window.aios.approvals.decide` / `threads.interrupt` from key operations is checked. Neither the model nor Electron is used
 * (built the same way as `test/question-prompt.test.ts` of item 166).
 *
 * - Permission requests: `1. Allow` / `2. Always allow` / `3. Deny` (the CLI's Yes / Yes, and don't ask again / No).
 *   The deny line is the field: write and Enter sends "do this instead"; Enter with nothing sends a denial with no text (stop and wait).
 * - Plan: `1. Yes, auto-accept edits` / `2. Yes, manually approve edits` / `3. No, keep planning` (item 256, the same three choices as the CLI). The third cannot be sent empty.
 * - Esc and ■ are deny + interrupt (`threads.interrupt`; item 96 cancels the pending approval first).
 * - One at a time: `ApprovalOrComposer` shows only the oldest one and hides the Composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalDecision, ApprovalItem } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const decide = vi.fn<(id: string, decision: ApprovalDecision) => Promise<void>>(async () => {})
const interrupt = vi.fn<(threadId: string) => Promise<void>>(async () => {})

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem =>
  ({
    id: 'req-1',
    threadId: 't1',
    threadTitle: '',
    toolName: 'Bash',
    summary: 'rm -rf build',
    input: { command: 'rm -rf build' },
    requestedAt: Date.now(),
    questions: null,
    subtask: null,
    ...over
  }) as unknown as ApprovalItem

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  decide.mockClear()
  interrupt.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    approvals: { decide, diff: vi.fn() },
    threads: { interrupt }
  }
  host = document.createElement('div')
  host.className = 'thread-pane'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(over: Partial<ApprovalItem> = {}, waiting = 0): Promise<HTMLElement> {
  const { ApprovalPrompt } = await import('../src/renderer/src/components/ApprovalPrompt.js')
  act(() => root.render(createElement(ApprovalPrompt, { item: item(over), waiting })))
  return host.querySelector<HTMLElement>('.question-frame')!
}

function press(target: Element, key: string, over: Partial<KeyboardEventInit> = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))
  })
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ApprovalPrompt: 権限の要求 (項目 182)', () => {
  it('何をするかと、番号つきの 許可 / Always allow / 拒否 (欄) が並び、出た瞬間に枠が focus を持つ', async () => {
    const frame = await render({}, 2)
    expect(host.querySelector('.approval-command')!.textContent).toBe('rm -rf build')
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows.map((r) => r.querySelector('.question-num')!.textContent)).toEqual(['1.', '2.', '3.'])
    expect(rows[2]!.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('.question-waiting')).not.toBeNull()
    expect(document.activeElement).toBe(frame)
  })

  it('1 で許可、2 で Always allow', async () => {
    const frame = await render()
    press(frame, '1')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow' })
    act(() => root.unmount())
    root = createRoot(host)
    const again = await render()
    press(again, '2')
    expect(decide.mock.calls[1]![1]).toEqual({ kind: 'allow-always' })
  })

  it('gateway 自身のツールには Always allow が無い (行は 許可 / 拒否 の 2 つ)', async () => {
    await render({ toolName: 'mcp__aios__openFile' })
    expect(host.querySelectorAll('.question-choice')).toHaveLength(2)
  })

  it('拒否の欄に書いて Enter なら文つきで断る。変換中の Enter では送らない', async () => {
    const frame = await render()
    press(frame, '3')
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    type(textarea, 'ls にして')
    press(textarea, 'Enter', { isComposing: true })
    expect(decide).not.toHaveBeenCalled()
    press(textarea, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny', message: 'ls にして' })
  })

  it('拒否の欄が空のまま Enter なら文なしで断る (main が「止まって待て」を返す)', async () => {
    const frame = await render()
    press(frame, 'ArrowDown')
    press(frame, 'ArrowDown') // Deny line -> into the field
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    press(textarea, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny' })
  })

  it('Esc と ■ は拒否 + 中断 (threads.interrupt)。欄の中の Esc は一覧に戻るだけ', async () => {
    const frame = await render()
    press(frame, '3')
    const textarea = host.querySelector('textarea')!
    press(textarea, 'Escape')
    expect(interrupt).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(frame)
    press(frame, 'Escape')
    expect(interrupt).toHaveBeenCalledWith('t1')
    expect(decide).not.toHaveBeenCalled()
  })

  it('■ 停止のボタンも threads.interrupt', async () => {
    await render()
    act(() => host.querySelector<HTMLButtonElement>('.approval-stop')!.click())
    expect(interrupt).toHaveBeenCalledWith('t1')
  })

  it('書き込みの要求には「差分を見る」が画面の中にある', async () => {
    await render({ toolName: 'Edit', diffable: true })
    const links = [...host.querySelectorAll('.approval-links button')].map((b) => b.textContent)
    expect(links.length).toBe(2)
  })
})

describe('ApprovalPrompt: 計画の承認 (項目 112 / 182 / 256)', () => {
  const plan = { toolName: 'ExitPlanMode', plan: '# 計画\n\n1. a', summary: '' }

  it('計画を Markdown で描き、1 で進める', async () => {
    const frame = await render(plan)
    expect(host.querySelector('.approval-plan h1')!.textContent).toBe('計画')
    expect(host.querySelector('.approval-command')).toBeNull()
    press(frame, '1')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow' })
  })

  it('CLI と同じ 3 択と文言 (表示言語によらず英文): 見出し・問い・3 つの行', async () => {
    await render(plan)
    expect(host.querySelector('.question-kind')!.textContent).toBe('Ready to code?')
    expect(host.querySelector('.approval-plan-heading')!.textContent).toBe('Here is the plan:')
    expect(host.querySelector('.question-text')!.textContent).toBe(
      'A plan has been written up and is ready to execute. Would you like to proceed?'
    )
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows.map((r) => r.querySelector('.question-num')!.textContent)).toEqual(['1.', '2.', '3.'])
    expect(rows.map((r) => r.querySelector('.question-label')!.textContent)).toEqual([
      'Yes, auto-accept edits',
      'Yes, manually approve edits',
      'No, keep planning'
    ])
    // Only the third is the field ("Tell … what to change").
    expect(rows.map((r) => r.querySelector('textarea') !== null)).toEqual([false, false, true])
  })

  it('2 で「Yes, manually approve edits」= allow-manual (厳格モードにするのは main)', async () => {
    const frame = await render(plan)
    press(frame, '2')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow-manual' })
  })

  it('↑↓ と Enter でも 3 択を選べる (2 行目で Enter = allow-manual)', async () => {
    const frame = await render(plan)
    press(frame, 'ArrowDown')
    press(frame, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow-manual' })
  })

  it('「No, keep planning」は空では送れず、書けば文つきの拒否', async () => {
    const frame = await render(plan)
    press(frame, '3')
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    press(textarea, 'Enter')
    expect(decide).not.toHaveBeenCalled()
    type(textarea, 'テストを先に')
    press(textarea, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny', message: 'テストを先に' })
  })

  it('権限の要求は 3 択にならない (allow-manual の行は計画だけ)', async () => {
    await render()
    const labels = [...host.querySelectorAll('.question-label')].map((l) => l.textContent)
    expect(labels).not.toContain('Yes, manually approve edits')
  })
})

describe('ApprovalOrComposer (1 件ずつ、Composer は隠す)', () => {
  it('一番古い 1 件だけを出し、質問なら質問の画面', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { ApprovalOrComposer } = await import('../src/renderer/src/components/ApprovalPrompt.js')
    const question = item({
      id: 'q',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'どれ?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }] }]
    })
    act(() => useThreads.setState({ approvals: [question, item({ id: 'p' })] }))
    act(() => root.render(createElement(ApprovalOrComposer, { threadId: 't1' })))
    expect(host.querySelectorAll('.question-prompt')).toHaveLength(1)
    expect(host.querySelector('.approval-prompt')).toBeNull()
    expect(host.querySelector<HTMLElement>('.composer')?.hidden).toBe(true)
    act(() => useThreads.setState({ approvals: [item({ id: 'p' })] }))
    expect(host.querySelector('.approval-prompt')).not.toBeNull()
    act(() => useThreads.setState({ approvals: [] }))
    expect(host.querySelector('.question-prompt')).toBeNull()
    expect(host.querySelector<HTMLElement>('.composer')?.hidden).toBe(false)
  })
})
