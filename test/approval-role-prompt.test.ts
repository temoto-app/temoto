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

describe('ApprovalPrompt: allow this role from now on (TODO 983)', () => {
  it('shows the role row after deny (not the 994 row) and sends with the default expiry "forever"', async () => {
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

  it('when the expiry is re-chosen, sends with that expiry; pressing the choice does not select the row', async () => {
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

  it('stage 4: a Teammate row says Teammate (not job) and still sends only the expiry', async () => {
    const { translate } = await import('../src/renderer/src/i18n/index.js')
    const frame = await render({ roleGrant: { roleName: '秘書', roleKind: 'teammate', subjects: [{ kind: 'command-prefix', value: 'docker build' }] } })
    const labels = [...host.querySelectorAll('.question-choice .question-label')].map((label) => label.textContent ?? '')
    const teammateWord = translate('en', 'approval.allowRoleTeammate', { role: '秘書', subject: '' }).split('(')[0]!.trim()
    const jaWord = translate('ja', 'approval.allowRoleTeammate', { role: '秘書', subject: '' }).split('(')[0]!.trim()
    expect(labels[3]?.includes(teammateWord) || labels[3]?.includes(jaWord)).toBe(true)
    expect(labels[3]).toContain('秘書')
    press(frame, '4')
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-role', scope: 'forever' })
  })

  it('not shown in frames for the stage 0 line or frames without a role', async () => {
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
