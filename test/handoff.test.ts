/**
 * TODO 961: the handoff text of "lighten and continue in a new conversation" (`@shared/handoff.ts`), and the cutting out of the material events (`src/main/session/handoff.ts`). Pure functions. The model is not called.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import type { ExportTurn } from '../src/shared/conversation-export.js'
import {
  HANDOFF_MAX_TOKENS,
  HANDOFF_TEXT_MAX_TOKENS,
  buildHandoffText,
  estimateTokens
} from '../src/shared/handoff.js'
import {
  eventsSinceReset,
  handoffTurns,
  inheritedEvents,
  lastOwnQuestionId
} from '../src/main/session/handoff.js'

const turn = (number: number, question: string, answers: string[]): ExportTurn => ({
  number,
  question: { id: `q${number}`, ts: number, text: question },
  answers
})

describe('estimateTokens', () => {
  it('ASCII は 3.5 文字で 1、それ以外は 1 文字で 1 (切り上げ)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcdefg')).toBe(2)
    expect(estimateTokens('日本語')).toBe(3)
    expect(estimateTokens('ab日本')).toBe(3)
  })
})

describe('buildHandoffText', () => {
  it('発言と回答を順に並べ、前置きと「# New message」で挟む。小さければ何も落とさない', () => {
    const result = buildHandoffText([turn(1, 'Q1', ['A1']), turn(2, 'Q2', ['A2a', 'A2b'])], 'Title')
    expect(result.omittedTurns).toBe(0)
    expect(result.text).toContain('"Title"')
    expect(result.text.indexOf('Q1')).toBeLessThan(result.text.indexOf('A1'))
    expect(result.text.indexOf('A1')).toBeLessThan(result.text.indexOf('Q2'))
    expect(result.text).toContain('A2b')
    expect(result.text.endsWith('# New message\n\n')).toBe(true)
    expect(result.tokens).toBe(estimateTokens(result.text))
  })

  it('ターンが無ければ空', () => {
    expect(buildHandoffText([], 'T')).toEqual({ text: '', tokens: 0, omittedTurns: 0 })
  })

  it('1 つの回答が長すぎれば頭を残して切り、落とした量を書く', () => {
    const long = 'x'.repeat(Math.ceil(HANDOFF_TEXT_MAX_TOKENS * 3.5) + 3_500)
    const result = buildHandoffText([turn(1, 'Q', [long])], 'T')
    expect(result.text).toMatch(/\[… about \d+ tokens omitted\]/)
    expect(result.tokens).toBeLessThan(HANDOFF_TEXT_MAX_TOKENS + 500)
  })

  it('全体が上限を超えたら、最初のターンと新しい側を残し、間を 1 行にする', () => {
    // One turn is about 3,000 tokens (3,000 Japanese characters) × 20 = 60,000.
    const turns = Array.from({ length: 20 }, (_, i) => turn(i + 1, `質問${i + 1}`, ['あ'.repeat(3_000)]))
    const result = buildHandoffText(turns, 'T')
    expect(result.tokens).toBeLessThanOrEqual(HANDOFF_MAX_TOKENS)
    expect(result.omittedTurns).toBeGreaterThan(0)
    expect(result.text).toContain('質問1\n')
    expect(result.text).toContain('質問20')
    expect(result.text).toMatch(/Turns 2–\d+ \(\d+ turns\) were omitted here/)
    // What is kept is the first turn plus a continuous run at the end.
    const kept = turns.filter((t) => result.text.includes(`${t.question!.text}\n`)).map((t) => t.number)
    expect(kept[0]).toBe(1)
    expect(kept.slice(1)).toEqual(Array.from({ length: kept.length - 1 }, (_, i) => 21 - (kept.length - 1) + i))
    expect(kept.length + result.omittedTurns).toBe(20)
  })

  it('最新のターン 1 つで上限を超えるなら、最新だけを上限で切る', () => {
    const huge = turn(3, '最後', Array.from({ length: 10 }, () => 'い'.repeat(5_000)))
    const result = buildHandoffText([turn(1, '最初', ['a']), turn(2, '中', ['b']), huge], 'T')
    expect(result.omittedTurns).toBe(2)
    expect(result.tokens).toBeLessThanOrEqual(HANDOFF_MAX_TOKENS + 100)
    expect(result.text).toContain('最後')
    expect(result.text).not.toContain('最初\n')
  })
})

const ev = (kind: string, payload: unknown, extra: Partial<AiosEvent> = {}): AiosEvent =>
  ({ id: `${kind}-${Math.random()}`, sessionId: 's', threadId: 't', ts: 1, actor: 'main', kind, payload, ...extra }) as AiosEvent

describe('材料のイベント (main)', () => {
  it('最後の /clear より後だけ。圧縮より前は残す。子の行は区切りにしない', () => {
    const events = [
      ev('user_text', { text: 'old' }),
      ev('conversation_reset', { trigger: 'clear' }),
      ev('user_text', { text: 'mid' }),
      ev('context_compacted', { trigger: 'auto' }),
      ev('conversation_reset', { trigger: 'clear' }, { actor: 'subagent' }),
      ev('user_text', { text: 'new' })
    ]
    const kept = eventsSinceReset(events).map((e) => (e.payload as { text?: string }).text).filter(Boolean)
    expect(kept).toEqual(['mid', 'new'])
  })

  it('本文に redaction を掛け、最後の発言の id を返す (自分の行の発言)', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(90)
    const turns = handoffTurns([ev('user_text', { text: `key ${secret}` }), ev('assistant_text', { text: 'ok' })])
    expect(turns[0]?.question?.text).not.toContain(secret)
    const id = turns[0]?.question?.id
    expect(id).toBeDefined()
    expect(lastOwnQuestionId(turns, new Set([id!]))).toBe(id)
    expect(lastOwnQuestionId([], new Set([id!]))).toBeNull()
  })

  it('TODO 992 の 1: 分岐は分岐点の発言の直前まで、引き継ぎはそのターンの終わりまで。見つからなければ null', () => {
    const q1 = ev('user_text', { text: 'q1' }, { id: 'q1' })
    const a1 = ev('assistant_text', { text: 'a1' })
    const sub = ev('user_text', { text: 'child' }, { actor: 'subagent' })
    const a1b = ev('assistant_text', { text: 'a1b' })
    const q2 = ev('user_text', { text: 'q2' }, { id: 'q2' })
    const a2 = ev('assistant_text', { text: 'a2' })
    const events = [q1, a1, sub, a1b, q2, a2]
    expect(inheritedEvents(events, 'q2', 'before')).toEqual([q1, a1, sub, a1b])
    // A child line is not a separator (it runs up to just before the parent's next message).
    expect(inheritedEvents(events, 'q1', 'through')).toEqual([q1, a1, sub, a1b])
    expect(inheritedEvents(events, 'q2', 'through')).toEqual(events)
    expect(inheritedEvents(events, 'missing', 'before')).toBeNull()
  })

  it('TODO 992 の 1: 帯から飛ぶ先は自分の行の発言だけ', () => {
    const turns = handoffTurns([
      ev('user_text', { text: 'inherited' }, { id: 'p1' }),
      ev('user_text', { text: 'own' }, { id: 'o1' }),
      ev('user_text', { text: 'inherited later' }, { id: 'p2' })
    ])
    expect(lastOwnQuestionId(turns, new Set(['o1']))).toBe('o1')
    expect(lastOwnQuestionId(turns, new Set())).toBeNull()
  })
})
