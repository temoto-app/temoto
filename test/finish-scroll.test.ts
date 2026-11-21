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

describe('nextTurnEnded / lastResultId — 印が進む条件', () => {
  it('表示中のスレッドに親の result が届いたら進む (seq は単調)', () => {
    const first = nextTurnEnded(null, 't1', 't1', [textEvent('a'), resultEvent('r1')])
    expect(first).toEqual({ threadId: 't1', eventId: 'r1', seq: 1 })
    const second = nextTurnEnded(first, 't1', 't1', [resultEvent('r2')])
    expect(second).toEqual({ threadId: 't1', eventId: 'r2', seq: 2 })
  })

  it('裏のスレッド・result の無いバッチでは進まない (同じ参照を返す)', () => {
    const prev = { threadId: 't1', eventId: 'r1', seq: 3 }
    expect(nextTurnEnded(prev, 't1', 't2', [resultEvent('r9', { threadId: 't2' })])).toBe(prev)
    expect(nextTurnEnded(prev, 't1', 't1', [textEvent('a')])).toBe(prev)
    expect(nextTurnEnded(prev, null, 't1', [resultEvent('r2')])).toBe(prev)
  })

  it('子の result (parentToolUseId 付き・subagent) は親のターンの終わりではない', () => {
    expect(lastResultId([resultEvent('c1', { parentToolUseId: 'tu', actor: 'subagent' })])).toBeNull()
    expect(lastResultId([resultEvent('r1'), resultEvent('c1', { parentToolUseId: 'tu' })])).toBe('r1')
  })
})

describe('finishScrollPlan — 動かす先', () => {
  it('成功: そのターンの最後の回答の塊の先頭 (続けて並ぶ本文は 1 塊、見えない行は塊を切らない)', () => {
    const items = [user('u1'), answer('a0'), user('u2'), answer('a1'), tool('t1'), answer('a2'), hiddenRateLimit('rl'), answer('a3'), result('r')]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a2' })
  })

  it('エラーで終わったターンも動かす', () => {
    const items = [user('u1'), answer('a1'), result('r', { ok: false, subtype: 'error_during_execution' })]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a1' })
  })

  it('本文の後にツールだけが続いて終わったターンは、最後に出た本文の頭', () => {
    const items = [user('u1'), answer('a1'), tool('t1'), tool('t2'), result('r')]
    expect(finishScrollPlan(items, 'r')).toEqual({ kind: 'answer', headId: 'a1' })
  })

  it('本文の無いターン (ツールだけ・エラーだけ) は末尾。前のターンの本文は見ない', () => {
    expect(finishScrollPlan([user('u1'), answer('a0'), user('u2'), tool('t1'), result('r')], 'r')).toEqual({ kind: 'bottom' })
    expect(finishScrollPlan([user('u1'), result('r', { ok: false })], 'r')).toEqual({ kind: 'bottom' })
  })

  it('子エージェントの発言は回答として数えない', () => {
    expect(finishScrollPlan([user('u1'), answer('s1', 'subagent'), result('r')], 'r')).toEqual({ kind: 'bottom' })
  })

  it('自分で止めた (中断 = interrupted) ターンでは動かさない', () => {
    const items = [user('u1'), answer('a1'), result('r', { ok: false, interrupted: true })]
    expect(finishScrollPlan(items, 'r')).toBeNull()
  })

  it('その result の行が無ければ動かさない', () => {
    expect(finishScrollPlan([user('u1'), answer('a1')], 'r')).toBeNull()
  })
})

describe('finishScrollTop — 置く位置', () => {
  it('塊の頭を、貼り付けの質問の分と余白を空けて上端に', () => {
    expect(finishScrollTop(2000, { scrollHeight: 5000, clientHeight: 600 })).toBe(2000 - STICKY_RESERVE_PX - JUMP_TOP_GAP_PX)
    expect(finishScrollTop(2000, { scrollHeight: 5000, clientHeight: 600 }, 60)).toBe(2000 - 60 - JUMP_TOP_GAP_PX)
  })

  it('回答が収まるなら下端 (動かせる範囲に丸める)', () => {
    expect(finishScrollTop(4800, { scrollHeight: 5000, clientHeight: 600 })).toBe(4400)
  })

  it('会話が 1 画面に収まるなら 0', () => {
    expect(finishScrollTop(100, { scrollHeight: 400, clientHeight: 600 })).toBe(0)
    expect(finishScrollTop(10, { scrollHeight: 5000, clientHeight: 600 })).toBe(0)
  })
})

describe('ThreadPane の配線 (ソース)', () => {
  const source = readFileSync(join(__dirname, '../src/renderer/src/components/ThreadPane.tsx'), 'utf8')

  it('印の seq で 1 回だけ動かし、マウント時点の印は済みとみなす', () => {
    expect(source).toContain('const handledEnd = useRef<number>(turnEnded?.seq ?? 0)')
    expect(source).toContain('turnEnded.seq === handledEnd.current')
  })

  it('別のスレッド・検索のジャンプ中・隠れているときは動かさない', () => {
    expect(source).toContain('if (turnEnded.threadId !== threadId) return')
    expect(source).toMatch(/TODO 464[\s\S]*if \(highlightEventId !== null\) return/)
    expect(source).toContain('box.clientHeight === 0')
  })

  it('検索のジャンプの強調は数秒で解く (解かないと自動スクロールと 464 がそのセッションの間止まる)', () => {
    expect(source).toContain('const HIGHLIGHT_CLEAR_MS = 4000')
    expect(source).toMatch(/useThreads\.setState\(\{ highlightEventId: null \}\)/)
  })

  it('動かした後に pinned を位置に合わせ、同じ描画の自動スクロールが ref を見て引き戻さない', () => {
    expect(source).toContain('setPinned(isAtBottom(box))')
    expect(source).toContain('if (!pinned || !pinnedRef.current) return')
  })
})
