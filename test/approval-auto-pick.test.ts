/**
 * Auto-pick mode, which picks automatically when the question's "(recommended)" is first (TODO 1194, ARCHITECTURE 4.2.2).
 *
 * What is guarded: the judgment of the badge (English and Japanese), the only thing auto-picked is "one question, single choice, recommended first", no `autoPick` when OFF,
 * and main puts the auto mark only on an answer that matches the request's `autoPick` (the renderer's `auto` is not trusted).
 * TODO 1222: auto-pick is per conversation (default OFF). When conversation A is ON and B is OFF, B's question does not get it; turning it off removes it.
 * The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { asDecision } from '../src/main/ipc/handlers.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import { ASK_TOOL, isRecommendedLabel, questionsOf, recommendedPick } from '../src/main/approval/questions.js'
import type { JsonValue } from '../src/shared/agent.js'
import type { ApprovalPolicy } from '../src/shared/thread.js'

const input = (
  labels: readonly string[],
  over: { multiSelect?: boolean; extra?: boolean } = {}
): JsonValue => ({
  questions: [
    {
      question: 'どれ?',
      header: 'h',
      multiSelect: over.multiSelect === true,
      options: labels.map((label) => ({ label, description: '' }))
    },
    ...(over.extra === true
      ? [{ question: 'もう 1 つ?', header: 'h2', multiSelect: false, options: [{ label: 'x', description: '' }] }]
      : [])
  ]
})

const policy = (): ApprovalPolicy => ({
  autoAllowAll: true,
  autoAllowTools: [],
  bashDenyPatterns: []
})

const pickOf = (value: JsonValue): ReturnType<typeof recommendedPick> =>
  recommendedPick(questionsOf(ASK_TOOL, value))

/** `on` makes only conversation `t` ON. `threads` is the set of conversations that are ON, and a test rewrites it later (instead of rereading from SessionManager). */
const makeBroker = (on: boolean, threads: Set<string> = new Set(on ? ['t'] : [])): ApprovalBroker => {
  const broker = new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, policy())
  broker.setAutoPickLookup((threadId) => threads.has(threadId))
  return broker
}

describe('isRecommendedLabel', () => {
  it('英語と日本語の末尾の印を読む', () => {
    expect(isRecommendedLabel('A (Recommended)')).toBe(true)
    expect(isRecommendedLabel('A (recommended)')).toBe(true)
    expect(isRecommendedLabel('みかん (推奨)')).toBe(true)
    expect(isRecommendedLabel('みかん（推奨）')).toBe(true)
    expect(isRecommendedLabel('A')).toBe(false)
    expect(isRecommendedLabel('(Recommended) A')).toBe(false)
  })
})

describe('recommendedPick', () => {
  it('1 問・単一選択・先頭が推奨なら札を返す', () => {
    expect(pickOf(input(['A (Recommended)', 'B']))).toEqual({ question: 'どれ?', label: 'A (Recommended)' })
    expect(pickOf(input(['みかん (推奨)', 'りんご']))).toEqual({ question: 'どれ?', label: 'みかん (推奨)' })
  })
  it('推奨が先頭でない・複数選択・複数の質問は null', () => {
    expect(pickOf(input(['A', 'B (Recommended)']))).toBeNull()
    expect(pickOf(input(['A (Recommended)', 'B'], { multiSelect: true }))).toBeNull()
    expect(pickOf(input(['A (Recommended)', 'B'], { extra: true }))).toBeNull()
    expect(pickOf(input(['A', 'B']))).toBeNull()
  })
})

describe('ApprovalBroker の自動選択', () => {
  const ask = (broker: ApprovalBroker, value: JsonValue, toolName = ASK_TOOL, threadId = 't') =>
    broker.request({ threadId, threadTitle: 'T', toolName, summary: '', input: value })

  it('OFF なら autoPick は付かない', () => {
    const broker = makeBroker(false)
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })

  it('ON で対象の質問だけに autoPick が付き、対象外は付かない', () => {
    const broker = makeBroker(true)
    void ask(broker, input(['A (Recommended)', 'B']))
    void ask(broker, input(['A', 'B (Recommended)']))
    void ask(broker, input(['A (Recommended)', 'B'], { multiSelect: true }))
    const [first, second, third] = broker.list()
    expect(first?.autoPick).toEqual({ label: 'A (Recommended)', seconds: 5 })
    expect(second?.autoPick).toBeUndefined()
    expect(third?.autoPick).toBeUndefined()
  })

  it('ON でも質問は main では自動で通らない (カウントダウンは renderer)', () => {
    const broker = makeBroker(true)
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()).toHaveLength(1)
  })

  it('autoPick と一致する答えだけ自動の印が付く', async () => {
    const broker = makeBroker(true)
    const auto = ask(broker, input(['A (Recommended)', 'B']))
    broker.decide(broker.list()[0]?.id ?? '', {
      kind: 'answer',
      answers: { 'どれ?': ['A (Recommended)'] },
      auto: true
    })
    await expect(auto).resolves.toMatchObject({ allowed: true, autoPicked: true })

    // It chose something other than the recommendation but claims auto -> no mark
    const lie = ask(broker, input(['A (Recommended)', 'B']))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'answer', answers: { 'どれ?': ['B'] }, auto: true })
    expect((await lie).autoPicked).toBeUndefined()
  })

  it('IPC の受け口 (asDecision) を通しても auto が届き、印が付く', async () => {
    const broker = makeBroker(true)
    const auto = ask(broker, input(['A (Recommended)', 'B']))
    const wire = JSON.parse(JSON.stringify({ kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] }, auto: true }))
    broker.decide(broker.list()[0]?.id ?? '', asDecision(wire))
    await expect(auto).resolves.toMatchObject({ allowed: true, autoPicked: true })
  })

  it('会話 A が ON・会話 B が OFF のとき B の質問に autoPick は付かない', () => {
    const broker = makeBroker(true, new Set(['a']))
    void ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'a')
    void ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'b')
    const byThread = new Map(broker.list().map((item) => [item.threadId, item]))
    expect(byThread.get('a')?.autoPick).toEqual({ label: 'A (Recommended)', seconds: 5 })
    expect(byThread.get('b')?.autoPick).toBeUndefined()
  })

  it('会話を切ると、その会話のカウントダウン中の質問から外れ、自動の答えは拒む (他の会話は残る)', async () => {
    const threads = new Set(['a', 'b'])
    const broker = makeBroker(true, threads)
    const q = ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'a')
    void ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'b')
    const id = broker.list().find((item) => item.threadId === 'a')?.id ?? ''
    threads.delete('a')
    broker.autoPickDisabled('a')
    expect(broker.list().find((item) => item.threadId === 'a')?.autoPick).toBeUndefined()
    expect(broker.list().find((item) => item.threadId === 'b')?.autoPick).toBeDefined()
    const auto = { kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] }, auto: true } as const
    expect(broker.decide(id, auto)).toBe(false)
    expect(broker.list()).toHaveLength(2)
    // A human answer (no auto) passes, and gets no mark
    expect(broker.decide(id, { kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] } })).toBe(true)
    expect((await q).autoPicked).toBeUndefined()
  })

  it('値の口が無い Broker (既定) は全会話 OFF', () => {
    const broker = new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, policy())
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })

  it('解決済みの id への 2 回目の自動の答えは黙って無視する (2 つの窓)', async () => {
    const broker = makeBroker(true)
    const q = ask(broker, input(['A (Recommended)', 'B']))
    const id = broker.list()[0]?.id ?? ''
    const auto = { kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] }, auto: true } as const
    expect(broker.decide(id, auto)).toBe(true)
    expect(broker.decide(id, auto)).toBe(false)
    await expect(q).resolves.toMatchObject({ autoPicked: true })
  })

  it('Plan の承認 (別のツール) には autoPick は付かない', () => {
    const broker = makeBroker(true)
    void ask(broker, { plan: 'x' }, 'ExitPlanMode')
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })
})
