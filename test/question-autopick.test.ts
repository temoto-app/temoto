// @vitest-environment jsdom
/**
 * TODO 1194: the countdown that automatically picks the recommended option (`QuestionPrompt`). Drawn in jsdom, advanced with fake timers.
 * - If `item.autoPick` is absent, no countdown appears and nothing is sent (same as OFF).
 * - If present, a 5-second countdown appears, and at 0 it returns the recommended option with `auto: true` added to `answer`.
 * - Touching it (a key, a click, or the stop button) halts it, and it does not send after the time has passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalDecision, ApprovalItem } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const decide = vi.fn<(id: string, decision: ApprovalDecision) => Promise<void>>(async () => {})

const QUESTION = 'どれにする?'
const item = (autoPick: boolean): ApprovalItem =>
  ({
    id: 'req-1',
    threadId: 't1',
    threadTitle: '',
    toolName: 'x',
    summary: '',
    input: {},
    requestedAt: Date.now(),
    questions: [
      {
        question: QUESTION,
        header: '',
        multiSelect: false,
        options: [
          { label: 'A (Recommended)', description: '', recommended: true },
          { label: 'B', description: '' }
        ]
      }
    ],
    ...(autoPick ? { autoPick: { label: 'A (Recommended)', seconds: 5 } } : {}),
    subtask: null
  }) as unknown as ApprovalItem

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
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
  vi.useRealTimers()
})

async function render(autoPick: boolean): Promise<void> {
  const { QuestionPrompt } = await import('../src/renderer/src/components/QuestionPrompt.js')
  act(() => root.render(createElement(QuestionPrompt, { item: item(autoPick), waiting: 0 })))
}

const tick = (seconds: number): void => {
  for (let i = 0; i < seconds; i += 1) act(() => void vi.advanceTimersByTime(1000))
}

describe('QuestionPrompt の推奨の自動選択 (TODO 1194)', () => {
  it('autoPick が無ければカウントダウンは出ず、時間が過ぎても送らない', async () => {
    await render(false)
    expect(host.querySelector('.question-autopick')).toBeNull()
    tick(10)
    expect(decide).not.toHaveBeenCalled()
  })

  it('カウントダウンが出て、0 で auto: true の答えを返す', async () => {
    await render(true)
    expect(host.querySelector('.question-autopick')).not.toBeNull()
    tick(4)
    expect(decide).not.toHaveBeenCalled()
    tick(1)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith('req-1', {
      kind: 'answer',
      answers: { [QUESTION]: ['A (Recommended)'] },
      auto: true
    })
  })

  it('キーに触れると止まり、以後は送らない', async () => {
    await render(true)
    tick(2)
    act(() => {
      host.querySelector('.question-frame')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(host.querySelector('.question-autopick')).toBeNull()
    tick(10)
    expect(decide).not.toHaveBeenCalled()
  })

  it('「止める」で止まる', async () => {
    await render(true)
    act(() => host.querySelector<HTMLButtonElement>('.question-autopick button')!.click())
    tick(10)
    expect(decide).not.toHaveBeenCalled()
  })
})
