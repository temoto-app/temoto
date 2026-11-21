// @vitest-environment jsdom
/**
 * TODO 994: the one line in the approval frame saying why it is asking, and in strict mode, Bash's "do not ask about Bash in this conversation".
 *
 * - shared: `approvalQueueReasonCode` makes the reason code for the log (the strings from before wave 52), and
 *   `canAllowForThread` is true only for Bash queued in strict mode.
 * - renderer: the mapping of `approvalReasonMessage` (reason -> dictionary key), and that the keys exist in both ja and en.
 * - DOM: the strict-mode Bash frame shows four lines (Allow / Always allow / Deny / Do not ask about Bash in this conversation), and the fourth sends `allow-thread`
 *   (number 3 is Deny, as in the other frames). It does not appear in non-strict frames or frames that send outward.
 * It is built the same way as `test/approval-outbound-prompt.test.ts`. Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  approvalQueueReasonCode,
  canAllowForThread,
  type ApprovalDecision,
  type ApprovalItem,
  type ApprovalQueueReason
} from '../src/shared/thread.js'
import { approvalReasonMessage } from '../src/renderer/src/approval-reason.js'
import { translate } from '../src/renderer/src/i18n/index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const decide = vi.fn<(id: string, decision: ApprovalDecision) => Promise<void>>(async () => {})

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'req-1',
  threadId: 't1',
  threadTitle: '',
  toolName: 'Bash',
  summary: 'ls',
  input: { command: 'ls' },
  requestedAt: Date.now(),
  questions: null,
  subtask: null,
  ...over
})

const GRANT = { subjects: [{ kind: 'command-prefix' as const, value: 'ls -la' }] }

const ALL_REASONS: readonly ApprovalQueueReason[] = [
  { kind: 'question' },
  { kind: 'plan' },
  { kind: 'side-effect' },
  { kind: 'outbound', match: 'mail' },
  { kind: 'strict' },
  { kind: 'not-default' },
  { kind: 'no-command' },
  { kind: 'deny-pattern', pattern: 'sudo' },
  { kind: 'unknown' }
]

describe('理由コード (shared)', () => {
  it('ログの文字列は第 52 波より前と同じ', () => {
    expect(ALL_REASONS.map(approvalQueueReasonCode)).toEqual([
      'question',
      'plan',
      'side-effect',
      'outbound:mail',
      'strict',
      'not-default',
      'no-command',
      'deny-pattern:sudo',
      'unknown'
    ])
  })

  it('canAllowForThread は厳格モードで積み、main が提案 (threadGrant) を載せた要求だけ', () => {
    expect(canAllowForThread(item({ reason: { kind: 'strict' }, threadGrant: GRANT }))).toBe(true)
    // Not shown for a request with no suggestion (no target can be built, or a tool whose read/write nature is unknown).
    expect(canAllowForThread(item({ reason: { kind: 'strict' } }))).toBe(false)
    expect(canAllowForThread(item({ reason: { kind: 'strict' }, threadGrant: { subjects: [] } }))).toBe(false)
    // Even for non-Bash (a write path), it is shown if there is a suggestion (983 stage 3).
    expect(canAllowForThread(item({ reason: { kind: 'strict' }, toolName: 'Write', threadGrant: GRANT }))).toBe(true)
    expect(canAllowForThread(item({ reason: { kind: 'deny-pattern', pattern: 'sudo' }, threadGrant: GRANT }))).toBe(false)
    expect(canAllowForThread(item({ reason: null, threadGrant: GRANT }))).toBe(false)
    expect(canAllowForThread(item({ threadGrant: GRANT }))).toBe(false)
    expect(
      canAllowForThread(
        item({
          reason: { kind: 'strict' },
          threadGrant: GRANT,
          outbound: { channel: 'shell', match: 'x', to: null, subject: null, body: null, command: 'ls' }
        })
      )
    ).toBe(false)
    expect(canAllowForThread(item({ reason: { kind: 'strict' }, threadGrant: GRANT, plan: '# plan' }))).toBe(false)
  })
})

describe('approvalReasonMessage (renderer)', () => {
  it('理由ごとの鍵と差し込み。unknown と理由なしは出さない', () => {
    const keys = ALL_REASONS.map((reason) => approvalReasonMessage(item({ reason }))?.key ?? null)
    expect(keys).toEqual([
      'approval.reason.question',
      'approval.reason.plan',
      'approval.reason.sideEffect',
      'approval.reason.outbound',
      'approval.reason.strict',
      'approval.reason.notDefault',
      'approval.reason.noCommand',
      'approval.reason.denyPattern',
      null
    ])
    expect(approvalReasonMessage(item())).toBeNull()
    // TODO 1015: strict mode for a thread woken by a scheduled job guides the user to the job's settings (the name is inserted).
    expect(approvalReasonMessage(item({ reason: { kind: 'strict' } }), { id: 'j1', name: '朝の巡回', approvalStrict: true })).toEqual({
      key: 'approval.reason.strictScheduled',
      params: { job: '朝の巡回' }
    })
    expect(approvalReasonMessage(item({ reason: { kind: 'strict' } }), null)?.key).toBe('approval.reason.strict')
    // If the job is now OFF (an old thread from before migration 32), the job wording is not used.
    expect(approvalReasonMessage(item({ reason: { kind: 'strict' } }), { id: 'j1', name: 'x', approvalStrict: false })?.key).toBe(
      'approval.reason.strict'
    )
    expect(approvalReasonMessage(item({ reason: { kind: 'deny-pattern', pattern: 'sudo' } }), { id: 'j1', name: 'x', approvalStrict: true })?.key).toBe(
      'approval.reason.denyPattern'
    )
    expect(approvalReasonMessage(item({ reason: { kind: 'outbound', match: 'chat-webhook' } }))).toEqual({
      key: 'approval.reason.outbound',
      params: { match: 'chat-webhook' }
    })
    expect(approvalReasonMessage(item({ reason: { kind: 'deny-pattern', pattern: 'sudo' } }))?.params).toEqual({
      pattern: 'sudo'
    })
    expect(approvalReasonMessage(item({ reason: { kind: 'not-default' }, toolName: 'Write' }))?.params).toEqual({
      tool: 'Write'
    })
  })

  it('鍵は ja / en の両方にあり、厳格モードは ⋯ での解除を言う', () => {
    for (const reason of ALL_REASONS) {
      const message = approvalReasonMessage(item({ reason }))
      if (message === null) continue
      for (const locale of ['ja', 'en'] as const) {
        expect(translate(locale, message.key, message.params)).not.toBe(message.key)
      }
    }
    expect(translate('ja', 'approval.reason.strict')).toContain('⋯')
    expect(translate('en', 'approval.reason.strict')).toContain('⋯')
    expect(translate('ja', 'approval.reason.strictScheduled', { job: '朝' })).toContain('「朝」')
    expect(translate('en', 'approval.reason.strictScheduled', { job: 'morning' })).toContain('“morning”')
    for (const locale of ['ja', 'en'] as const) {
      expect(translate(locale, 'approval.reason.editJob')).not.toBe('approval.reason.editJob')
    }
    expect(translate('en', 'approval.reason.outbound', { match: 'mail' })).toContain('mail')
  })
})

describe('ApprovalPrompt: 厳格モード (TODO 994)', () => {
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

  it('厳格モードの Bash: 理由の 1 行と 4 行。3 行目が拒否 (欄)、4 行目が allow-thread を送る', async () => {
    await render({ reason: { kind: 'strict' }, threadGrant: GRANT })
    expect(host.querySelector('.approval-reason')).not.toBeNull()
    const rows = [...host.querySelectorAll<HTMLElement>('.question-choice')]
    expect(rows).toHaveLength(4)
    expect(rows[2]!.querySelector('textarea')).not.toBeNull()
    act(() => rows[3]!.click())
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-thread' })
  })

  it('厳格モードの Bash: 番号 3 は他の枠と同じく拒否 (広い許可にならない)、4 が allow-thread', async () => {
    await render({ reason: { kind: 'strict' }, threadGrant: GRANT })
    const frame = host.querySelector<HTMLElement>('.question-frame')!
    const press = (target: HTMLElement, key: string): void => {
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    press(frame, '3')
    expect(decide).not.toHaveBeenCalled()
    const textarea = host.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    // With the field empty, Enter denies.
    press(textarea, 'Enter')
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'deny' })
  })

  it('厳格モードの Bash: 番号 4 で allow-thread', async () => {
    await render({ reason: { kind: 'strict' }, threadGrant: GRANT })
    const frame = host.querySelector<HTMLElement>('.question-frame')!
    act(() => {
      frame.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }))
    })
    expect(decide).toHaveBeenCalledWith('req-1', { kind: 'allow-thread' })
  })

  it('厳格モードの Write: 3 行のまま、Always allow のヒントは厳格モードでは効かないと言う', async () => {
    await render({ reason: { kind: 'strict' }, toolName: 'Write', summary: '/a', input: { file_path: '/a' } })
    const rows = [...host.querySelectorAll<HTMLElement>('.question-choice')]
    expect(rows).toHaveLength(3)
    // Whichever language jsdom defaults to, the text is the hint for strict mode.
    expect([translate('ja', 'approval.alwaysToolStrictHint'), translate('en', 'approval.alwaysToolStrictHint')]).toContain(
      rows[1]!.title
    )
  })

  it('停止パターンで積んだ Bash: 3 行で、理由の行に停止パターンを出す', async () => {
    await render({ reason: { kind: 'deny-pattern', pattern: 'sudo' } })
    expect(host.querySelectorAll('.question-choice')).toHaveLength(3)
    expect(host.querySelector('.approval-reason')!.textContent).toContain('sudo')
  })

  it('理由の無い要求は理由の行を出さない', async () => {
    await render()
    expect(host.querySelector('.approval-reason')).toBeNull()
  })
})
