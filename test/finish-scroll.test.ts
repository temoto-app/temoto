/**
 * TODO 464 (wave 23 bundle D): the moment an answer finishes, move ThreadPane to the head of the last answer.
 *
 * Pure functions (`thread/finish-scroll.ts`): the condition for the mark to advance (only when the parent's `result` arrives by push in the displayed thread), where to move (success and error go to the head of the last answer's block, or to the end when there is no body; interruption does not move), and where to place it (leave room for the pasted part; if the answer fits, the bottom edge). The wiring of ThreadPane (when hidden, `highlightEventId`, `pinned`) is checked in the source. The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiosEvent, ResultPayload } from '../src/shared/agent.js'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'
import {
  STICKY_RESERVE_PX,
  finishScrollPlan,
  finishScrollTop,
  lastResultId,
  nextTurnEnded
} from '../src/renderer/src/thread/finish-scroll.js'
import { JUMP_TOP_GAP_PX } from '../src/renderer/src/thread/jump.js'

function payload(over: Partial<ResultPayload> = {}): ResultPayload {
  return {
    ok: true,
    subtype: 'success',
    turns: 1,
    durationMs: 1000,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: null,
    denials: [],
    text: null,
    ...over
  }
}

function resultEvent(id: string, over: Partial<AiosEvent> = {}): AiosEvent {
  return {
    id,
    sessionId: 's',
    threadId: 't1',
    ts: 1,
    actor: 'main',
    kind: 'result',
    payload: payload(),
    ...over
  } as AiosEvent
}

const textEvent = (id: string): AiosEvent =>
  ({ id, sessionId: 's', threadId: 't1', ts: 1, actor: 'main', kind: 'assistant_text', payload: { text: 'x' } }) as AiosEvent

const user = (id: string): TimelineItem => ({ kind: 'user', id, ts: 0, text: 'q' })
const answer = (id: string, actor: 'main' | 'subagent' = 'main'): TimelineItem => ({
  kind: 'assistant',
  id,
  ts: 0,
  text: 'a',
  actor
})
const tool = (id: string): TimelineItem => ({
  kind: 'tool',
  id,
  ts: 0,
  toolUseId: `tu-${id}`,
  name: 'Read',
  summary: '',
  input: null,
  truncated: false,
  approval: null,
  result: null,
  children: []
})
const result = (id: string, over: Partial<ResultPayload> = {}): TimelineItem => ({
  kind: 'result',
  id,
  ts: 0,
  result: payload(over)
})
const hiddenRateLimit = (id: string): TimelineItem => ({
  kind: 'rate_limit',
  id,
  ts: 0,
  info: { status: 'allowed', windowType: null, resetsAt: null, usingOverage: false },
  notice: null
})

describe('nextTurnEnded / lastResultId: the condition for the marker to advance', () => {
  it("advances when the parent's result arrives for the displayed thread (seq is monotonic)", () => {
    const first = nextTurnEnded(null, 't1', 't1', [textEvent('a'), resultEvent('r1')])
    expect(first).toEqual({ threadId: 't1', eventId: 'r1', seq: 1 })
    const second = nextTurnEnded(first, 't1', 't1', [resultEvent('r2')])
    expect(second).toEqual({ threadId: 't1', eventId: 'r2', seq: 2 })
  })

  it('does not advance for a background thread or a batch without a result (returns the same reference)', () => {
    const prev = { threadId: 't1', eventId: 'r1', seq: 3 }
    expect(nextTurnEnded(prev, 't1', 't2', [resultEvent('r9', { threadId: 't2' })])).toBe(prev)
    expect(nextTurnEnded(prev, 't1', 't1', [textEvent('a')])).toBe(prev)
    expect(nextTurnEnded(prev, null, 't1', [resultEvent('r2')])).toBe(prev)
  })

  it("a child's result (with parentToolUseId, subagent) is not the end of the parent's turn", () => {
    expect(lastResultId([resultEvent('c1', { parentToolUseId: 'tu', actor: 'subagent' })])).toBeNull()
    expect(lastResultId([resultEvent('r1'), resultEvent('c1', { parentToolUseId: 'tu' })])).toBe('r1')
  })
})

describe('finishScrollPlan: where to move to', () => {
  it('success: the head of the last answer block of that turn (consecutive body text is one block, and invisible rows do not split the block)', () => {
    const items = [user('u1'), answer('a0'), user('u2'), answer('a1'), tool('t1'), answer('a2'), hiddenRateLimit('rl'), answer('a3'), result('r')]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a2' })
  })

  it('also moves for a turn that ended in an error', () => {
    const items = [user('u1'), answer('a1'), result('r', { ok: false, subtype: 'error_during_execution' })]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a1' })
  })

  it('for a turn where only tools follow the body and it ends, the head of the last body text that appeared', () => {
    const items = [user('u1'), answer('a1'), tool('t1'), tool('t2'), result('r')]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a1' })
  })

  it("a turn without body text (tools only, errors only) goes to the end; the previous turn's body is not looked at", () => {
    expect(finishScrollPlan([user('u1'), answer('a0'), user('u2'), tool('t1'), result('r')], 'r')).toEqual({ kind: 'bottom' })
    expect(finishScrollPlan([user('u1'), result('r', { ok: false })], 'r')).toEqual({ kind: 'bottom' })
  })

  it("a subagent's message does not count as an answer", () => {
    expect(finishScrollPlan([user('u1'), answer('s1', 'subagent'), result('r')], 'r')).toEqual({ kind: 'bottom' })
  })

  it('does not move for a turn the user stopped (interrupted)', () => {
    const items = [user('u1'), answer('a1'), result('r', { ok: false, interrupted: true })]
    expect(finishScrollPlan(items, 'r')).toBeNull()
  })

  it('does not move when there is no row for that result', () => {
    expect(finishScrollPlan([user('u1'), answer('a1')], 'r')).toBeNull()
  })
})

describe('finishScrollTop: where to place', () => {
  it('puts the head of the block at the top edge with room for the pasted question and a margin', () => {
    expect(finishScrollTop(2000, { scrollHeight: 5000, clientHeight: 600 })).toBe(2000 - STICKY_RESERVE_PX - JUMP_TOP_GAP_PX)
    expect(finishScrollTop(2000, { scrollHeight: 5000, clientHeight: 600 }, 60)).toBe(2000 - 60 - JUMP_TOP_GAP_PX)
  })

  it('when the answer fits, the bottom edge (rounded to the movable range)', () => {
    expect(finishScrollTop(4800, { scrollHeight: 5000, clientHeight: 600 })).toBe(4400)
  })

  it('0 when the conversation fits in one screen', () => {
    expect(finishScrollTop(100, { scrollHeight: 400, clientHeight: 600 })).toBe(0)
    expect(finishScrollTop(10, { scrollHeight: 5000, clientHeight: 600 })).toBe(0)
  })
})

describe('ThreadPane wiring (source)', () => {
  const source = readFileSync(join(__dirname, '../src/renderer/src/components/ThreadPane.tsx'), 'utf8')

  it('moves only once per marker seq, and treats the marker at mount time as done', () => {
    expect(source).toContain('const handledEnd = useRef<number>(turnEnded?.seq ?? 0)')
    expect(source).toContain('turnEnded.seq === handledEnd.current')
  })

  it('does not move for another thread, during a search jump, or when hidden', () => {
    expect(source).toContain('if (turnEnded.threadId !== threadId) return')
    expect(source).toMatch(/TODO 464[\s\S]*if \(highlightEventId !== null\) return/)
    expect(source).toContain('box.clientHeight === 0')
  })

  it('the highlight of a search jump is released in a few seconds (otherwise auto-scroll and 464 stop for that session)', () => {
    expect(source).toContain('const HIGHLIGHT_CLEAR_MS = 4000')
    expect(source).toMatch(/useThreads\.setState\(\{ highlightEventId: null \}\)/)
  })

  it('after moving, fits pinned to the position so that auto-scroll in the same render does not pull back by looking at the ref', () => {
    expect(source).toContain('setPinned(isAtBottom(box))')
    expect(source).toContain('if (!pinned || !pinnedRef.current) return')
  })
})
