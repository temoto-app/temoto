// @vitest-environment jsdom
/**
 * Item 166 (wave 13 bundle L): draws the question screen (`QuestionPrompt`) in jsdom and checks the path from key input
 * to the answer that reaches `window.aios.approvals.decide`. Uses neither the model nor Electron.
 *
 * - Options are listed vertically, and the description appears under the label (previously only a hover title).
 * - "Other" is the last row: you type in the field, and Enter decides. Enter during IME composition does not decide.
 * - Item 895: all questions are listed vertically in one frame, and the "answer" button sends (there are no tabs, no confirmation screen, and no chat rows).
 * - Esc means "do not answer" (deny).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalDecision, ApprovalItem, ApprovalQuestion } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const decide = vi.fn<(id: string, decision: ApprovalDecision) => Promise<void>>(async () => {})

const fruit: ApprovalQuestion = {
  question: '好きな果物を1つ選んでください。',
  header: '好きな果物',
  multiSelect: false,
  options: [
    { label: 'りんご', description: 'りんごを選びます' },
    { label: 'みかん', description: 'みかんを選びます' },
    { label: 'ぶどう', description: 'ぶどうを選びます' }
  ]
}
const color: ApprovalQuestion = {
  question: '好きな色は? (いくつでも)',
  header: '',
  multiSelect: true,
  options: [
    { label: '赤', description: '' },
    { label: '青', description: '' }
  ]
}

const item = (questions: ApprovalQuestion[]): ApprovalItem =>
  ({
    id: 'req-1',
    threadId: 't1',
    threadTitle: '',
    toolName: 'x',
    summary: '',
    input: {},
    requestedAt: Date.now(),
    questions,
    subtask: null
  }) as unknown as ApprovalItem

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  decide.mockClear()
  ;(window as unknown as { aios: unknown }).aios = { approvals: { decide } }
  host = document.createElement('div')
  host.className = 'thread-pane'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(questions: ApprovalQuestion[]): Promise<HTMLElement> {
  const { QuestionPrompt } = await import('../src/renderer/src/components/QuestionPrompt.js')
  act(() => root.render(createElement(QuestionPrompt, { item: item(questions), waiting: 0 })))
  return host.querySelector<HTMLElement>('.question-frame')!
}

function press(target: Element, key: string, over: Partial<KeyboardEventInit> = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))
  })
}

const FRUIT = '好きな果物を1つ選んでください。'
const COLOR = '好きな色は? (いくつでも)'

function type(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submitButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('.question-submit')!

describe('QuestionPrompt (項目 166 / 895)', () => {
  it('1 問でも同じ形: header の札・質問文・番号付きカード・その他の欄・注記。タブも確認も話す行も無い', async () => {
    await render([fruit])
    expect(host.querySelector('.question-header')!.textContent).toBe('好きな果物')
    expect(host.querySelector('.question-text')!.textContent).toBe(FRUIT)
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows).toHaveLength(4) // 3 options + other
    expect(rows[0]!.querySelector('.question-label')!.textContent).toBe('1. りんご')
    expect(rows[0]!.querySelector('.question-desc')!.textContent).toBe('りんごを選びます')
    expect(rows[3]!.classList.contains('other')).toBe(true)
    expect(rows[3]!.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('.question-tab')).toBeNull()
    expect(host.querySelector('.chat-row')).toBeNull()
    expect(host.querySelector('.question-footnote')).not.toBeNull()
    // Key input is accepted as soon as it appears.
    expect(document.activeElement).toBe(host.querySelector('.question-frame'))
  })

  it('単一選択は選んでも送らない。「回答する」で送る', async () => {
    const frame = await render([fruit])
    expect(submitButton().disabled).toBe(true)
    press(frame, '2')
    expect(decide).not.toHaveBeenCalled()
    expect(host.querySelectorAll('.question-choice.picked')).toHaveLength(1)
    expect(submitButton().disabled).toBe(false)
    act(() => submitButton().click())
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'answer', answers: { [FRUIT]: ['みかん'] }, texts: {} })
  })

  it('全問が同時に出て、全部に答えるまで「回答する」は押せない。⌘Enter でも送れる', async () => {
    const frame = await render([fruit, color])
    expect(host.querySelectorAll('.question-block')).toHaveLength(2)
    press(frame, '1') // Question 1: apple
    expect(submitButton().disabled).toBe(true)
    press(frame, 'Enter', { metaKey: true })
    expect(decide).not.toHaveBeenCalled()
    // ↑↓ cross questions: row 1 of question 1 → Other (3 times) → row 1 of question 2.
    for (let i = 0; i < 4; i += 1) press(frame, 'ArrowDown')
    press(frame, '1') // Question 2: red (marked)
    press(frame, '2') // blue (marked)
    expect(submitButton().disabled).toBe(false)
    press(frame, 'Enter', { metaKey: true })
    expect(decide.mock.calls[0]![1]).toEqual({
      kind: 'answer',
      answers: { [FRUIT]: ['りんご'], [COLOR]: ['赤', '青'] },
      texts: {}
    })
  })

  it('↓ で動かして Enter で選ぶ', async () => {
    const frame = await render([fruit])
    press(frame, 'ArrowDown')
    press(frame, 'ArrowDown')
    press(frame, 'Enter')
    act(() => submitButton().click())
    expect(decide.mock.calls[0]![1]).toMatchObject({ answers: { [FRUIT]: ['ぶどう'] } })
  })

  it('「その他」は問いごとの欄。書いて Enter で決まる (変換中の Enter では決まらない)。送るのは「回答する」', async () => {
    const frame = await render([fruit])
    press(frame, '4') // Goes into the "Other" field
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    type(textarea, 'メロン\nです')
    press(textarea, 'Enter', { isComposing: true })
    expect(document.activeElement).toBe(textarea)
    press(textarea, 'Enter')
    expect(document.activeElement).toBe(frame)
    expect(decide).not.toHaveBeenCalled()
    act(() => submitButton().click())
    expect(decide.mock.calls[0]![1]).toEqual({
      kind: 'answer',
      answers: { [FRUIT]: [] },
      texts: { [FRUIT]: 'メロン\nです' }
    })
  })

  it('2 問それぞれの「その他」は別の欄で、片方だけ書いても残りが未回答なら送れない', async () => {
    const frame = await render([fruit, color])
    const areas = host.querySelectorAll('textarea')
    expect(areas).toHaveLength(2)
    act(() => areas[1]!.focus()) // Entering the field moves the cursor to that question
    type(areas[1]!, '緑')
    expect(submitButton().disabled).toBe(true)
    press(areas[1]!, 'Escape') // From the field to the frame (does not close without answering)
    expect(document.activeElement).toBe(frame)
    expect(decide).not.toHaveBeenCalled()
    press(frame, '1') // The cursor is on question 2 (it was in the field), so red of question 2
    const first = frame.querySelectorAll('.question-block')[0]!.querySelectorAll('.question-choice')[0]!
    act(() => (first as HTMLElement).click())
    expect(submitButton().disabled).toBe(false)
    act(() => submitButton().click())
    expect(decide.mock.calls[0]![1]).toMatchObject({
      kind: 'answer',
      texts: { [COLOR]: '緑' }
    })
  })

  it('Esc は答えない (拒否)。変換中の Esc は拾わない', async () => {
    const frame = await render([fruit])
    press(frame, 'Escape', { isComposing: true })
    expect(decide).not.toHaveBeenCalled()
    press(frame, 'Escape')
    // No sentence attached: main returns the CLI's default refusal sentence (stay stopped and wait) (item 183).
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny' })
  })

  it('「答えない」ボタンも拒否', async () => {
    await render([fruit, color])
    const buttons = host.querySelectorAll<HTMLButtonElement>('.question-actions button')
    act(() => buttons[1]!.click())
    expect(decide.mock.calls[0]![1]).toEqual({ kind: 'deny' })
  })
})
