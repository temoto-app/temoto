// @vitest-environment jsdom
/**
 * TODO 983 stage 1 (4.2.5 point 5.): the "allow this role from now on" line in the approval frame and the choice of expiry. Drawn in jsdom, and the sent decision is checked
 * (built the same way as `test/approval-prompt.test.ts`; a separate file to avoid conflicts between parallel work).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ApprovalDecision, ApprovalItem } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const decide = vi.fn<(id: string, decision: ApprovalDecision) => Promise<void>>(async () => {})

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem =>
  ({
    id: 'req-1',
    threadId: 't1',
    threadTitle: '',
    toolName: 'Bash',
    summary: 'docker build . && docker push x',
    input: { command: 'docker build . && docker push x' },
    requestedAt: Date.now(),
    questions: null,
    subtask: null,
    reason: { kind: 'strict' },
    roleGrant: {
      roleName: '朝の集計',
      subjects: [
        { kind: 'command-prefix', value: 'docker build' },
        { kind: 'command-prefix', value: 'docker push' }
      ]
    },
    ...over
  }) as unknown as ApprovalItem

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  decide.mockClear()
  ;(window as unknown as { aios: unknown }).aios = { approvals: { decide, diff: vi.fn() }, threads: { interrupt: vi.fn() } }
  host = document.createElement('div')
  host.className = 'thread-pane'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(over: Partial<ApprovalItem> = {}): Promise<HTMLElement> {
  const { ApprovalPrompt } = await import('../src/renderer/src/components/ApprovalPrompt.js')
  act(() => root.render(createElement(ApprovalPrompt, { item: item(over), waiting: 0 })))
  return host.querySelector<HTMLElement>('.question-frame')!
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('ApprovalPrompt: この role には今後も許す (TODO 983)', () => {
  it('拒否の次に role の行を出し (994 の行は出さない)、既定の期限「ずっと」で送る', async () => {
    const frame = await render()
    const labels = [...host.querySelectorAll('.question-choice .question-label')].map((label) => label.textContent ?? '')
    expect(labels).toHaveLength(4)
    expect(labels[3]).toContain('朝の集計')
    expect(labels[3]).toContain('docker build …, docker push …')
    expect(labels.some((label) => label.includes('Bash'))).toBe(false)
    const select = host.querySelector<HTMLSelectElement>('.approval-role-scope')!
    expect(select.value).toBe('forever')
    press(frame, '4')
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-role', scope: 'forever' })
  })

  it('期限を選び直すと、その期限で送る。選択を押しても行は選ばれない', async () => {
    await render()
    const select = host.querySelector<HTMLSelectElement>('.approval-role-scope')!
    act(() => {
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(decide).not.toHaveBeenCalled()
    act(() => {
      select.value = 'today'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const row = host.querySelectorAll<HTMLElement>('.question-choice')[3]!
    act(() => {
      row.querySelector<HTMLElement>('.question-label')!.click()
    })
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-role', scope: 'today' })
  })

  it('段 0 の線の枠・role の無い枠には出さない', async () => {
    await render({ reason: { kind: 'persistence', match: 'shell-startup', target: '~/.zshrc' } })
    expect(host.querySelector('.approval-role-scope')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await render({ roleGrant: null, reason: { kind: 'strict' }, threadGrant: { subjects: [{ kind: 'command-prefix', value: 'ls -la' }] } })
    expect(host.querySelector('.approval-role-scope')).toBeNull()
    // Strict Bash with no role is still the item 994 line, as before.
    const labels = [...host.querySelectorAll('.question-choice .question-label')].map((label) => label.textContent ?? '')
    expect(labels.some((label) => label.includes('ls -la'))).toBe(true)
  })
})
