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

describe('ApprovalPrompt: permission requests (item 182)', () => {
  it('shows what it will do and the numbered Allow / Always allow / Deny (field), and the frame takes focus the moment it appears', async () => {
    const frame = await render({}, 2)
    expect(host.querySelector('.approval-command')!.textContent).toBe('rm -rf build')
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows.map((r) => r.querySelector('.question-num')!.textContent)).toEqual(['1.', '2.', '3.'])
    expect(rows[2]!.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('.question-waiting')).not.toBeNull()
    expect(document.activeElement).toBe(frame)
  })

  it('1 allows and 2 is Always allow', async () => {
    const frame = await render()
    press(frame, '1')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow' })
    act(() => root.unmount())
    root = createRoot(host)
    const again = await render()
    press(again, '2')
    expect(decide.mock.calls[1]![1]).toEqual({ kind: 'allow-always' })
  })

  it("the gateway's own tools have no Always allow (two rows: Allow / Deny)", async () => {
    await render({ toolName: 'mcp__aios__openFile' })
    expect(host.querySelectorAll('.question-choice')).toHaveLength(2)
  })

  it('writing in the deny field and pressing Enter refuses with a message; Enter during IME composition does not send', async () => {
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

  it('pressing Enter with the deny field empty refuses without a message (main returns "stop and wait")', async () => {
    const frame = await render()
    press(frame, 'ArrowDown')
    press(frame, 'ArrowDown') // Deny line -> into the field
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    press(textarea, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny' })
  })

  it('Esc and ■ are deny + interrupt (threads.interrupt); Esc inside the field only returns to the list', async () => {
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

  it('the ■ stop button is also threads.interrupt', async () => {
    await render()
    act(() => host.querySelector<HTMLButtonElement>('.approval-stop')!.click())
    expect(interrupt).toHaveBeenCalledWith('t1')
  })

  it('a write request has "View diff" within the screen', async () => {
    await render({ toolName: 'Edit', diffable: true })
    const links = [...host.querySelectorAll('.approval-links button')].map((b) => b.textContent)
    expect(links.length).toBe(2)
  })
})

describe('ApprovalPrompt: plan approval (items 112 / 182 / 256)', () => {
  const plan = { toolName: 'ExitPlanMode', plan: '# 計画\n\n1. a', summary: '' }

  it('renders the plan as Markdown and 1 proceeds', async () => {
    const frame = await render(plan)
    expect(host.querySelector('.approval-plan h1')!.textContent).toBe('計画')
    expect(host.querySelector('.approval-command')).toBeNull()
    press(frame, '1')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow' })
  })

  it('the same 3 choices and wording as the CLI (English regardless of display language): heading, question, and three rows', async () => {
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

  it('2 is "Yes, manually approve edits" = allow-manual (main is what makes it strict mode)', async () => {
    const frame = await render(plan)
    press(frame, '2')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow-manual' })
  })

  it('the 3 choices can also be selected with ↑↓ and Enter (Enter on the 2nd row = allow-manual)', async () => {
    const frame = await render(plan)
    press(frame, 'ArrowDown')
    press(frame, 'Enter')
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'allow-manual' })
  })

  it('"No, keep planning" cannot be sent empty, and with text it is a refusal with a message', async () => {
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

  it('a permission request does not become 3 choices (the allow-manual row is for plans only)', async () => {
    await render()
    const labels = [...host.querySelectorAll('.question-label')].map((l) => l.textContent)
    expect(labels).not.toContain('Yes, manually approve edits')
  })
})

describe('ApprovalOrComposer (one at a time, hides the Composer)', () => {
  it('shows only the oldest one, and for a question the question screen', async () => {
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
