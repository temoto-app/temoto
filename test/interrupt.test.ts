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

describe('nextInterruptHint: clues in the middle of a turn', () => {
  it('a retry is distinguished by status code (none = connection, 429 = limit, other = API side)', () => {
    expect(reasonOfRetryStatus(null)).toBe('interrupt-network')
    expect(reasonOfRetryStatus(429)).toBe('interrupt-limit')
    expect(reasonOfRetryStatus(529)).toBe('interrupt-server')
    expect(nextInterruptHint(null, retry(null))).toBe('interrupt-network')
    expect(nextInterruptHint('interrupt-network', retry(500))).toBe('interrupt-server')
  })

  it('rate_limit is a limit only when rejected; other statuses and other kinds do not change the clue', () => {
    const limit = (status: string): AiosEvent =>
      ev({ kind: 'rate_limit', payload: { status, windowType: null, resetsAt: null, usingOverage: false } })
    expect(nextInterruptHint(null, limit('rejected'))).toBe('interrupt-limit')
    expect(nextInterruptHint(null, limit('allowed_warning'))).toBeNull()
    expect(nextInterruptHint('interrupt-network', ev({ kind: 'assistant_text', payload: { text: 'x' } }))).toBe(
      'interrupt-network'
    )
  })

  it('a result discards the clue', () => {
    expect(nextInterruptHint('interrupt-network', ev({ kind: 'result', payload: RESULT }))).toBeNull()
  })
})

describe('interruptChange: setting / clearing the marker', () => {
  it('set by a failing result; the kind is the clue, or interrupt-error if there is none', () => {
    const failed = ev({ kind: 'result', payload: { ...RESULT, ok: false } })
    expect(interruptChange('interrupt-limit', failed)).toEqual({ kind: 'set', reason: 'interrupt-limit' })
    expect(interruptChange(null, failed)).toEqual({ kind: 'set', reason: 'interrupt-error' })
  })

  it('TODO 893: a result of expired authentication is interrupt-auth regardless of the clue or ok', () => {
    const failed = ev({ kind: 'result', payload: { ...RESULT, ok: false, authFailed: true } })
    expect(interruptChange('interrupt-server', failed)).toEqual({ kind: 'set', reason: 'interrupt-auth' })
    const okButAuth = ev({ kind: 'result', payload: { ...RESULT, ok: true, authFailed: true } })
    expect(interruptChange(null, okButAuth)).toEqual({ kind: 'set', reason: 'interrupt-auth' })
  })

  it('a turn stopped by an interrupt (the user stopped it themselves) is left untouched', () => {
    expect(interruptChange(null, ev({ kind: 'result', payload: { ...RESULT, ok: false, interrupted: true } }))).toBeNull()
  })

  it("cleared by a successful result, and by the parent's body, thinking, tool or usage (the next turn started normally)", () => {
    expect(interruptChange(null, ev({ kind: 'result', payload: RESULT }))).toEqual({ kind: 'clear' })
    for (const kind of ['assistant_delta', 'assistant_text', 'thinking_delta', 'tool_use', 'turn_usage']) {
      expect(interruptChange(null, ev({ kind, payload: {} })), kind).toEqual({ kind: 'clear' })
    }
  })

  it('TODO 1184: 429, then a child agent notification, then an empty successful result leaves the marker', () => {
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

  it("a retry, a child agent's body and an approval request do not clear it", () => {
    expect(interruptChange(null, retry(null))).toBeNull()
    expect(interruptChange(null, ev({ kind: 'assistant_text', actor: 'subagent', payload: { text: 'x' } }))).toBeNull()
    expect(interruptChange(null, ev({ kind: 'permission_request', payload: {} }))).toBeNull()
  })

  it('set by a startup failure (spawn); an exit error is left to onAgentExit', () => {
    const error = (origin: string): AiosEvent => ev({ kind: 'error', payload: { message: '', code: null, origin } })
    expect(interruptChange(null, error('spawn'))).toEqual({ kind: 'set', reason: 'interrupt-error' })
    expect(interruptChange(null, error('exit'))).toBeNull()
    expect(reasonOfExit(null)).toBe('interrupt-exit')
    expect(reasonOfExit('interrupt-network')).toBe('interrupt-network')
  })
})

describe('interruption kinds are reason codes', () => {
  it('all are in REASON_CODES and both dictionaries have text for them', () => {
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

describe('resumePrompt: fixed text for resuming (owner decision 2026-10-08)', () => {
  it('JA is 「{reason}により途中で中断した。中断状況を確認して、再開して」', () => {
    expect(resumePrompt('interrupt-network', ja)).toBe(
      'ネットワークの切断により途中で中断した。中断状況を確認して、再開して'
    )
    expect(resumePrompt('interrupt-limit', ja)).toBe('使用量の上限により途中で中断した。中断状況を確認して、再開して')
  })

  it('EN has the same form', () => {
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

describe('rowBadgeOf / showsResume: list marker and resume button', () => {
  it('awaiting approval > interruption 「!」 > unread dot', () => {
    expect(rowBadgeOf(summary({ unread: true, interrupted: 'interrupt-network' }))).toBe('interrupted')
    expect(rowBadgeOf(summary({ interrupted: 'interrupt-network' }, { pendingApprovals: 1 }))).toBe('approval')
    expect(rowBadgeOf(summary({ unread: true }))).toBe('unread')
    expect(rowBadgeOf(summary({}))).toBeNull()
  })

  it('an interruption is as strong as unread (unread order, the Activity Bar dot)', () => {
    expect(attentionOf(summary({ interrupted: 'interrupt-exit' }))).toBe(1)
    expect(attentionOf(summary({}))).toBe(0)
  })

  it('the button appears only when there is a marker and no turn is running', () => {
    expect(showsResume('interrupt-network', 'idle')).toBe(true)
    expect(showsResume('interrupt-exit', 'error')).toBe(true)
    expect(showsResume('interrupt-network', 'running')).toBe(false)
    expect(showsResume('interrupt-network', 'starting')).toBe(false)
    expect(showsResume(undefined, 'idle')).toBe(false)
  })
})
