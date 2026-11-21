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

describe('compat deny sentences (a copy of CLI 2.1.280)', () => {
  it('there are two: "stop and wait" and "do this instead"', () => {
    expect(table.stop).toBe(
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
    )
    expect(table.feedback.endsWith('To tell you how to proceed, the user said:\n{feedback}')).toBe(true)
  })
})

describe('aios withdrawal sentences (TODO 567)', () => {
  it('there is an English sentence in the table per reason and also a reason code; the neutral sentence without a table is English too', () => {
    for (const reason of APPROVAL_CANCEL_REASONS) {
      const text = formatApprovalReply(table, { kind: 'cancelled', reason })
      expect(text).toMatch(/^The permission request was cancelled because /)
      expect(text).not.toMatch(/[ぁ-んァ-ン一-龥]/)
      expect(isReasonCode(approvalCancelCode(reason))).toBe(true)
      expect(fallbackApprovalReply({ kind: 'cancelled', reason })).toMatch(/NOT run/)
    }
    expect(fallbackApprovalReply({ kind: 'feedback', text: 'x' })).toBeNull()
  })

  it("the Broker's withdrawal takes the form reason code + cancelled (has no Japanese sentence)", async () => {
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
  it("stop is as is and feedback appends the user's sentence at the end", () => {
    expect(formatApprovalReply(table, { kind: 'stop' })).toBe(table.stop)
    const text = formatApprovalReply(table, { kind: 'feedback', text: '{feedback} は置き換えない' })
    expect(text.endsWith('the user said:\n{feedback} は置き換えない')).toBe(true)
  })

})

describe('asDecision', () => {
  it('a removed clarify decision falls to a refusal (does not turn into an answer)', () => {
    expect(asDecision({ kind: 'clarify', answers: { どれ: ['A'] } })).toEqual({ kind: 'deny' })
  })
  it('a refusal without a sentence has no message (main chooses the default sentence)', () => {
    expect(asDecision({ kind: 'deny' })).toEqual({ kind: 'deny' })
  })
})

describe('old saved clarify rows (TODO 910)', () => {
  it('even after removing the decision path, a row with outcome.reply = clarify is readable as is without dropping on save or load', () => {
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
