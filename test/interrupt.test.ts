/**
 * TODO 521 (wave 26 bundle B): the judgment that an answer was interrupted (main's `session/interrupt.ts`), and how it is shown,
 * plus the canned text for resuming (renderer's `thread/resume.ts`). Pure functions only. For the form that goes through
 * SessionManager, see the interrupt-marker test in `session-manager.test.ts`. Does not call the model.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { INTERRUPT_REASONS, isInterruptReason, type ThreadSummary } from '../src/shared/thread.js'
import { REASON_CODES } from '../src/shared/reason.js'
import {
  interruptChange,
  nextInterruptHint,
  reasonOfExit,
  reasonOfRetryStatus
} from '../src/main/session/interrupt.js'
import { interruptReasonLabel, resumePrompt, rowBadgeOf, showsResume } from '../src/renderer/src/thread/resume.js'
import { attentionOf } from '../src/renderer/src/thread-sort.js'
import { translate, type MessageParams } from '../src/renderer/src/i18n/index.js'
import type { MessageKey } from '../src/renderer/src/i18n/ja.js'

const ja = (key: MessageKey, params?: MessageParams): string => translate('ja', key, params)
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const RESULT: ResultPayload = {
  ok: true,
  subtype: 'success',
  turns: 1,
  durationMs: 1,
  costUsd: 0,
  usage: { inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: null,
  denials: [],
  text: null
}

function ev(partial: Record<string, unknown>): AiosEvent {
  return { id: 'e', sessionId: 's', threadId: 't', ts: 1, actor: 'main', ...partial } as unknown as AiosEvent
}

const retry = (errorStatus: number | null): AiosEvent =>
  ev({ kind: 'api_retry', payload: { attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus } })

describe('nextInterruptHint — ターンの途中の手がかり', () => {
  it('再試行は状態コードで分ける (無し = 接続、429 = 上限、他 = API 側)', () => {
    expect(reasonOfRetryStatus(null)).toBe('interrupt-network')
    expect(reasonOfRetryStatus(429)).toBe('interrupt-limit')
    expect(reasonOfRetryStatus(529)).toBe('interrupt-server')
    expect(nextInterruptHint(null, retry(null))).toBe('interrupt-network')
    expect(nextInterruptHint('interrupt-network', retry(500))).toBe('interrupt-server')
  })

  it('rate_limit は rejected のときだけ上限。他の状態や他の種別は手がかりを変えない', () => {
    const limit = (status: string): AiosEvent =>
      ev({ kind: 'rate_limit', payload: { status, windowType: null, resetsAt: null, usingOverage: false } })
    expect(nextInterruptHint(null, limit('rejected'))).toBe('interrupt-limit')
    expect(nextInterruptHint(null, limit('allowed_warning'))).toBeNull()
    expect(nextInterruptHint('interrupt-network', ev({ kind: 'assistant_text', payload: { text: 'x' } }))).toBe(
      'interrupt-network'
    )
  })

  it('result で手がかりを捨てる', () => {
    expect(nextInterruptHint('interrupt-network', ev({ kind: 'result', payload: RESULT }))).toBeNull()
  })
})

describe('interruptChange — 印を立てる / 消す', () => {
  it('失敗の result で立てる。種類は手がかり、無ければ interrupt-error', () => {
    const failed = ev({ kind: 'result', payload: { ...RESULT, ok: false } })
    expect(interruptChange('interrupt-limit', failed)).toEqual({ kind: 'set', reason: 'interrupt-limit' })
    expect(interruptChange(null, failed)).toEqual({ kind: 'set', reason: 'interrupt-error' })
  })

  it('TODO 893: 認証切れの result は手がかりや ok に関わらず interrupt-auth', () => {
    const failed = ev({ kind: 'result', payload: { ...RESULT, ok: false, authFailed: true } })
    expect(interruptChange('interrupt-server', failed)).toEqual({ kind: 'set', reason: 'interrupt-auth' })
    const okButAuth = ev({ kind: 'result', payload: { ...RESULT, ok: true, authFailed: true } })
    expect(interruptChange(null, okButAuth)).toEqual({ kind: 'set', reason: 'interrupt-auth' })
  })

  it('割り込みで止めたターン (利用者が自分で止めた) は触らない', () => {
    expect(interruptChange(null, ev({ kind: 'result', payload: { ...RESULT, ok: false, interrupted: true } }))).toBeNull()
  })

  it('成功の result と、親の本文・thinking・ツール・使用量で消す (次のターンが正常に始まった)', () => {
    expect(interruptChange(null, ev({ kind: 'result', payload: RESULT }))).toEqual({ kind: 'clear' })
    for (const kind of ['assistant_delta', 'assistant_text', 'thinking_delta', 'tool_use', 'turn_usage']) {
      expect(interruptChange(null, ev({ kind, payload: {} })), kind).toEqual({ kind: 'clear' })
    }
  })

  it('TODO 1184: 429 → 子エージェントの知らせ → 中身の無い成功の result で印が残る', () => {
    let hint = nextInterruptHint(null, ev({ kind: 'rate_limit', payload: { status: 'rejected' } }))
    expect(interruptChange(hint, ev({ kind: 'result', payload: { ...RESULT, ok: false } }))).toEqual({
      kind: 'set',
      reason: 'interrupt-limit'
    })
    hint = null
    // A subagent's text does not move the parent's marker.
    expect(interruptChange(hint, ev({ kind: 'assistant_text', actor: 'subagent', payload: { text: 'x' } }))).toBeNull()
    const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
    expect(interruptChange(hint, ev({ kind: 'result', payload: { ...RESULT, turns: 0, usage: zeroUsage } }))).toBeNull()
    expect(interruptChange(hint, ev({ kind: 'result', payload: { ...RESULT, turns: 1, usage: zeroUsage } }))).toBeNull()
    expect(interruptChange(hint, ev({ kind: 'result', payload: { ...RESULT, turns: 0 } }))).toBeNull()
    // A successful result from a real model call clears it.
    expect(interruptChange(hint, ev({ kind: 'result', payload: RESULT }))).toEqual({ kind: 'clear' })
  })

  it('再試行・子エージェントの本文・承認要求では消さない', () => {
    expect(interruptChange(null, retry(null))).toBeNull()
    expect(interruptChange(null, ev({ kind: 'assistant_text', actor: 'subagent', payload: { text: 'x' } }))).toBeNull()
    expect(interruptChange(null, ev({ kind: 'permission_request', payload: {} }))).toBeNull()
  })

  it('起動の失敗 (spawn) で立てる。exit の error は onAgentExit に任せる', () => {
    const error = (origin: string): AiosEvent => ev({ kind: 'error', payload: { message: '', code: null, origin } })
    expect(interruptChange(null, error('spawn'))).toEqual({ kind: 'set', reason: 'interrupt-error' })
    expect(interruptChange(null, error('exit'))).toBeNull()
    expect(reasonOfExit(null)).toBe('interrupt-exit')
    expect(reasonOfExit('interrupt-network')).toBe('interrupt-network')
  })
})

describe('中断の種類は理由コード', () => {
  it('全部が REASON_CODES にあり、両方の辞書に文言がある', () => {
    for (const reason of INTERRUPT_REASONS) {
      expect(REASON_CODES).toContain(reason)
      expect(interruptReasonLabel(reason, ja)).not.toBe(`reason.${reason}`)
      expect(interruptReasonLabel(reason, en)).not.toBe(`reason.${reason}`)
    }
    expect(isInterruptReason('interrupt-exit')).toBe(true)
    expect(isInterruptReason('path-excluded')).toBe(false)
    expect(isInterruptReason(null)).toBe(false)
  })
})

describe('resumePrompt — 再開の定型文 (オーナー決定 2026-10-08)', () => {
  it('JA は「{reason}により途中で中断した。中断状況を確認して、再開して」', () => {
    expect(resumePrompt('interrupt-network', ja)).toBe(
      'ネットワークの切断により途中で中断した。中断状況を確認して、再開して'
    )
    expect(resumePrompt('interrupt-limit', ja)).toBe('使用量の上限により途中で中断した。中断状況を確認して、再開して')
  })

  it('EN も同じ形', () => {
    expect(resumePrompt('interrupt-exit', en)).toBe(
      'The response was interrupted by the CLI exiting. Check where it stopped and resume.'
    )
  })
})

type Summary = Pick<ThreadSummary, 'thread' | 'runtime'>
function summary(thread: Record<string, unknown>, runtime: Record<string, unknown> = {}): Summary {
  return {
    thread: { unread: false, ...thread },
    runtime: { state: 'idle', pendingApprovals: 0, ...runtime }
  } as unknown as Summary
}

describe('rowBadgeOf / showsResume — 一覧の印と再開のボタン', () => {
  it('承認待ち > 中断の「!」> 未読の点', () => {
    expect(rowBadgeOf(summary({ unread: true, interrupted: 'interrupt-network' }))).toBe('interrupted')
    expect(rowBadgeOf(summary({ interrupted: 'interrupt-network' }, { pendingApprovals: 1 }))).toBe('approval')
    expect(rowBadgeOf(summary({ unread: true }))).toBe('unread')
    expect(rowBadgeOf(summary({}))).toBeNull()
  })

  it('中断は未読と同じ強さ (未読順・Activity Bar の点)', () => {
    expect(attentionOf(summary({ interrupted: 'interrupt-exit' }))).toBe(1)
    expect(attentionOf(summary({}))).toBe(0)
  })

  it('ボタンは印があって、ターンが走っていないときだけ', () => {
    expect(showsResume('interrupt-network', 'idle')).toBe(true)
    expect(showsResume('interrupt-exit', 'error')).toBe(true)
    expect(showsResume('interrupt-network', 'running')).toBe(false)
    expect(showsResume('interrupt-network', 'starting')).toBe(false)
    expect(showsResume(undefined, 'idle')).toBe(false)
  })
})
