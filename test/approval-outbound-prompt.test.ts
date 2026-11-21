// @vitest-environment jsdom
/**
 * TODO 959: draws the approval frame for outbound operations (`item.outbound` of `ApprovalPrompt`) in jsdom.
 * Shows the destination, subject, and body (for a shell, the whole command) from the start, and does not show an "Always allow" line.
 * It is built the same way as `test/approval-prompt.test.ts`. Neither the model nor Electron is used.
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
    toolName: 'mcp__mail__send_message',
    summary: 'a@example.com',
    input: { to: 'a@example.com', subject: 'Hi', body: 'Hello there' },
    requestedAt: Date.now(),
    questions: null,
    subtask: null,
    ...over
  }) as unknown as ApprovalItem

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  decide.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    approvals: { decide, diff: vi.fn() },
    threads: { interrupt: vi.fn(async () => {}) }
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

async function render(over: Partial<ApprovalItem> = {}): Promise<void> {
  const { ApprovalPrompt } = await import('../src/renderer/src/components/ApprovalPrompt.js')
  act(() => root.render(createElement(ApprovalPrompt, { item: item(over), waiting: 0 })))
}

describe('ApprovalPrompt: outbound operations (TODO 959)', () => {
  it('shows destination, subject, and body, and the rows are only Allow / Deny (no Always allow)', async () => {
    await render({
      outbound: { channel: 'tool', match: 'send', to: 'a@example.com', subject: 'Hi', body: 'Hello there', command: null }
    })
    expect(host.querySelector('.approval-outbound-badge')).not.toBeNull()
    const values = [...host.querySelectorAll('.approval-outbound dd')].map((dd) => dd.textContent)
    expect(values).toEqual(['a@example.com', 'Hi', 'Hello there'])
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows).toHaveLength(2)
    expect(rows[1]!.querySelector('textarea')).not.toBeNull()
  })

  it('a shell shows the whole command', async () => {
    await render({
      toolName: 'Bash',
      summary: 'git push origin main',
      input: { command: 'git push origin main' },
      outbound: { channel: 'shell', match: 'git-push', to: null, subject: null, body: null, command: 'git push origin main' }
    })
    expect(host.querySelector('.approval-outbound-command')!.textContent).toBe('git push origin main')
    expect(host.querySelector('.approval-command')).toBeNull()
    expect(host.querySelectorAll('.question-choice')).toHaveLength(2)
  })

  it('an ordinary request shows Always allow as before', async () => {
    await render({ toolName: 'mcp__mail__get_message' })
    expect(host.querySelector('.approval-outbound-badge')).toBeNull()
    expect(host.querySelectorAll('.question-choice')).toHaveLength(3)
  })
})

describe('ApprovalPrompt: do not ask for this host in future (TODO 1029)', () => {
  it('scp (sending out) to a host in the list appears at the end (3rd row) and the numbers 1. Allow / 2. Deny do not change', async () => {
    await render({
      toolName: 'Bash',
      input: { command: 'scp a.txt kzm@winbox:/tmp/' },
      outbound: { channel: 'shell', match: 'scp', to: null, subject: null, body: null, command: 'scp a.txt kzm@winbox:/tmp/' },
      reason: { kind: 'outbound', match: 'scp' },
      quietHosts: ['kzm@winbox']
    })
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('.question-num')?.textContent)).toEqual(['1.', '2.', '3.'])
    expect(rows[2]!.textContent).toContain('kzm@winbox')
    act(() => (rows[2] as HTMLElement).click())
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-host' })
  })

  it('ssh in strict mode is the 5th row, after the 4th row (do not ask for Bash in this conversation)', async () => {
    await render({ toolName: 'Bash', input: { command: 'ssh winbox dir' }, reason: { kind: 'strict' }, quietHosts: ['winbox'], threadGrant: { subjects: [{ kind: 'command-prefix', value: 'ssh winbox' }] } })
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows).toHaveLength(5)
    expect(rows[4]!.textContent).toContain('winbox')
  })

  it('not shown when quietHosts is missing or empty', async () => {
    await render({ toolName: 'Bash', input: { command: 'ssh winbox dir' }, reason: { kind: 'strict' }, quietHosts: [], threadGrant: { subjects: [{ kind: 'command-prefix', value: 'ssh winbox' }] } })
    expect(host.querySelectorAll('.question-choice')).toHaveLength(4)
  })
})

describe('ApprovalPrompt: paths outside the working folder (TODO 1020)', () => {
  it('the heading is the wording, not the name, and the body is 「作業フォルダの外のパス: …」', async () => {
    await render({ toolName: 'ExternalDirectory', summary: '/outside', input: { path: '/outside', resources: ['/outside/*'] } })
    const kind = host.querySelector('.question-kind')!.textContent ?? ''
    expect(['作業フォルダの外', 'Outside the working folder']).toContain(kind)
    const line = host.querySelector('.approval-command')!.textContent ?? ''
    expect(line).toMatch(/^(作業フォルダの外のパス|Path outside the working folder): \/outside$/)
  })
})
