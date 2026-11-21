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

describe('ApprovalPrompt: 外へ出す操作 (TODO 959)', () => {
  it('宛先・件名・本文を出し、行は 許可 / 拒否 だけ (Always allow なし)', async () => {
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

  it('シェルはコマンド全体を出す', async () => {
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

  it('ふつうの要求は今までどおり Always allow を出す', async () => {
    await render({ toolName: 'mcp__mail__get_message' })
    expect(host.querySelector('.approval-outbound-badge')).toBeNull()
    expect(host.querySelectorAll('.question-choice')).toHaveLength(3)
  })
})

describe('ApprovalPrompt: このホストは今後聞かない (TODO 1029)', () => {
  it('一覧のホストへの scp (外へ送る) は末尾 (3 行目) に出し、1. 許可 / 2. 拒否 の番号は変えない', async () => {
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

  it('厳格モードの ssh は 4 行目 (この会話では Bash を聞かない) の後の 5 行目', async () => {
    await render({ toolName: 'Bash', input: { command: 'ssh winbox dir' }, reason: { kind: 'strict' }, quietHosts: ['winbox'], threadGrant: { subjects: [{ kind: 'command-prefix', value: 'ssh winbox' }] } })
    const rows = [...host.querySelectorAll('.question-choice')]
    expect(rows).toHaveLength(5)
    expect(rows[4]!.textContent).toContain('winbox')
  })

  it('quietHosts が無い・空なら出さない', async () => {
    await render({ toolName: 'Bash', input: { command: 'ssh winbox dir' }, reason: { kind: 'strict' }, quietHosts: [], threadGrant: { subjects: [{ kind: 'command-prefix', value: 'ssh winbox' }] } })
    expect(host.querySelectorAll('.question-choice')).toHaveLength(4)
  })
})

describe('ApprovalPrompt: 作業フォルダの外のパス (TODO 1020)', () => {
  it('見出しは名前ではなく文言、本文は「作業フォルダの外のパス: …」', async () => {
    await render({ toolName: 'ExternalDirectory', summary: '/outside', input: { path: '/outside', resources: ['/outside/*'] } })
    const kind = host.querySelector('.question-kind')!.textContent ?? ''
    expect(['作業フォルダの外', 'Outside the working folder']).toContain(kind)
    const line = host.querySelector('.approval-command')!.textContent ?? ''
    expect(line).toMatch(/^(作業フォルダの外のパス|Path outside the working folder): \/outside$/)
  })
})
