/**
 * Items 182 / 183 (wave 14 bundle C): the text returned to the model when an approval is denied.
 *
 * - The text is a copy of the backend's dialog screen, and it exists only in the compat table (`approvalReplies`). It was copied word for word from the
 *   CLI 2.1.280 binary (`$b` / `WR` / `LGe` / `TYt`). Here the shape of the table's values and the way they are filled (`formatApprovalReply`) are pinned down.
 * - The "talk about this question" (`clarify`) decision path was removed in TODO 910 (wave 48). If an old `clarify` decision arrives, `asDecision` falls back to deny.
 *
 * Neither the model nor the CLI is called.
 */
import { describe, expect, it } from 'vitest'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { formatApprovalReply } from '../src/main/approval/replies.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import { asDecision } from '../src/main/ipc/handlers.js'
import { APPROVAL_CANCEL_REASONS, approvalCancelCode, fallbackApprovalReply } from '../src/main/approval/reply.js'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import type { AiosEvent } from '../src/shared/agent.js'
import { isReasonCode } from '../src/shared/reason.js'

const table = loadCompatTable().approvalReplies
if (table === undefined) throw new Error('compat の approvalReplies が無い')

describe('compat の拒否の文 (CLI 2.1.280 の写し)', () => {
  it('止まって待て / 代わりにこうして の 2 つがある', () => {
    expect(table.stop).toBe(
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
    )
    expect(table.feedback.endsWith('To tell you how to proceed, the user said:\n{feedback}')).toBe(true)
  })
})

describe('aios の取り下げの文 (TODO 567)', () => {
  it('理由ごとに英語の文が表にあり、理由コードもある。表が無いときの中立な文も英語', () => {
    for (const reason of APPROVAL_CANCEL_REASONS) {
      const text = formatApprovalReply(table, { kind: 'cancelled', reason })
      expect(text).toMatch(/^The permission request was cancelled because /)
      expect(text).not.toMatch(/[ぁ-んァ-ン一-龥]/)
      expect(isReasonCode(approvalCancelCode(reason))).toBe(true)
      expect(fallbackApprovalReply({ kind: 'cancelled', reason })).toMatch(/NOT run/)
    }
    expect(fallbackApprovalReply({ kind: 'feedback', text: 'x' })).toBeNull()
  })

  it('Broker の取り下げは理由コード + cancelled の形 (日本語の文を持たない)', async () => {
    const broker = new ApprovalBroker({ onChanged: () => undefined, onDecided: () => undefined }, {
      autoAllowAll: false,
      autoAllowTools: [],
      bashDenyPatterns: []
    })
    const pending = broker.request({ threadId: 't', threadTitle: 't', toolName: 'Write', summary: '', input: {} })
    broker.cancelThread('t', 'interrupt')
    expect(await pending).toEqual({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-interrupt',
      reply: { kind: 'cancelled', reason: 'interrupt' }
    })
  })
})

describe('formatApprovalReply', () => {
  it('stop はそのまま、feedback は利用者の文を末尾に', () => {
    expect(formatApprovalReply(table, { kind: 'stop' })).toBe(table.stop)
    const text = formatApprovalReply(table, { kind: 'feedback', text: '{feedback} は置き換えない' })
    expect(text.endsWith('the user said:\n{feedback} は置き換えない')).toBe(true)
  })

})

describe('asDecision', () => {
  it('消した clarify の決定は拒否に倒す (答えに化けない)', () => {
    expect(asDecision({ kind: 'clarify', answers: { どれ: ['A'] } })).toEqual({ kind: 'deny' })
  })
  it('文の無い拒否は message を持たない (main が既定の文を選ぶ)', () => {
    expect(asDecision({ kind: 'deny' })).toEqual({ kind: 'deny' })
  })
})

describe('保存済みの古い clarify の行 (TODO 910)', () => {
  it('決定の経路を消しても、outcome.reply = clarify の行は保存・読み込みで落ちずそのまま読める', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const store = new ThreadStore(db, '/Users/tester')
    store.createThread({ id: 'thread-1', title: 't', cwd: '/Users/tester/work', allowedDirs: [], retention: 'forever', backend: 'agent-cli', modelId: null, thinking: null })
    const thread = store.getThread('thread-1')
    if (thread === null) throw new Error('no thread')
    const old = {
      id: 'p1',
      sessionId: 's',
      threadId: 'thread-1',
      ts: 5,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: 'r1',
        toolUseId: null,
        toolName: 'AskUserQuestion',
        summary: '',
        input: {},
        requestedAt: 1,
        decidedAt: 2,
        outcome: { kind: 'denied', by: 'user', message: '', reply: 'clarify' }
      }
    } as AiosEvent
    store.appendEvents(thread, 'session-1', [old])
    const read = store.readTimeline('thread-1').find((e) => e.kind === 'permission_request')
    expect(read?.kind === 'permission_request' && read.payload.outcome).toEqual({ kind: 'denied', by: 'user', message: '', reply: 'clarify' })
    db.close()
  })
})
