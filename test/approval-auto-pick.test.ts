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
  it('reads the trailing marker in English and Japanese', () => {
    expect(isRecommendedLabel('A (Recommended)')).toBe(true)
    expect(isRecommendedLabel('A (recommended)')).toBe(true)
    expect(isRecommendedLabel('みかん (推奨)')).toBe(true)
    expect(isRecommendedLabel('みかん（推奨）')).toBe(true)
    expect(isRecommendedLabel('A')).toBe(false)
    expect(isRecommendedLabel('(Recommended) A')).toBe(false)
  })
})

describe('recommendedPick', () => {
  it('returns the label when there is one question, single select, and the first is recommended', () => {
    expect(pickOf(input(['A (Recommended)', 'B']))).toEqual({ question: 'どれ?', label: 'A (Recommended)' })
    expect(pickOf(input(['みかん (推奨)', 'りんご']))).toEqual({ question: 'どれ?', label: 'みかん (推奨)' })
  })
  it('null when the recommendation is not first, multi select, or multiple questions', () => {
    expect(pickOf(input(['A', 'B (Recommended)']))).toBeNull()
    expect(pickOf(input(['A (Recommended)', 'B'], { multiSelect: true }))).toBeNull()
    expect(pickOf(input(['A (Recommended)', 'B'], { extra: true }))).toBeNull()
    expect(pickOf(input(['A', 'B']))).toBeNull()
  })
})

describe('ApprovalBroker auto-pick', () => {
  const ask = (broker: ApprovalBroker, value: JsonValue, toolName = ASK_TOOL, threadId = 't') =>
    broker.request({ threadId, threadTitle: 'T', toolName, summary: '', input: value })

  it('autoPick is not set when OFF', () => {
    const broker = makeBroker(false)
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })

  it('when ON, autoPick is set only on target questions and not on others', () => {
    const broker = makeBroker(true)
    void ask(broker, input(['A (Recommended)', 'B']))
    void ask(broker, input(['A', 'B (Recommended)']))
    void ask(broker, input(['A (Recommended)', 'B'], { multiSelect: true }))
    const [first, second, third] = broker.list()
    expect(first?.autoPick).toEqual({ label: 'A (Recommended)', seconds: 5 })
    expect(second?.autoPick).toBeUndefined()
    expect(third?.autoPick).toBeUndefined()
  })

  it('even when ON, questions are not passed automatically in main (the countdown is in the renderer)', () => {
    const broker = makeBroker(true)
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()).toHaveLength(1)
  })

  it('only an answer matching autoPick gets the auto mark', async () => {
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

  it('auto arrives and gets the mark even through the IPC entry (asDecision)', async () => {
    const broker = makeBroker(true)
    const auto = ask(broker, input(['A (Recommended)', 'B']))
    const wire = JSON.parse(JSON.stringify({ kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] }, auto: true }))
    broker.decide(broker.list()[0]?.id ?? '', asDecision(wire))
    await expect(auto).resolves.toMatchObject({ allowed: true, autoPicked: true })
  })

  it("when conversation A is ON and conversation B is OFF, B's question gets no autoPick", () => {
    const broker = makeBroker(true, new Set(['a']))
    void ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'a')
    void ask(broker, input(['A (Recommended)', 'B']), ASK_TOOL, 'b')
    const byThread = new Map(broker.list().map((item) => [item.threadId, item]))
    expect(byThread.get('a')?.autoPick).toEqual({ label: 'A (Recommended)', seconds: 5 })
    expect(byThread.get('b')?.autoPick).toBeUndefined()
  })

  it('when a conversation is closed, its questions drop out of the countdown and an automatic answer is refused (other conversations remain)', async () => {
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

  it('a Broker without a value path (default) is OFF for all conversations', () => {
    const broker = new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, policy())
    void ask(broker, input(['A (Recommended)', 'B']))
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })

  it('a second automatic answer to an already resolved id is silently ignored (two windows)', async () => {
    const broker = makeBroker(true)
    const q = ask(broker, input(['A (Recommended)', 'B']))
    const id = broker.list()[0]?.id ?? ''
    const auto = { kind: 'answer', answers: { 'どれ?': ['A (Recommended)'] }, auto: true } as const
    expect(broker.decide(id, auto)).toBe(true)
    expect(broker.decide(id, auto)).toBe(false)
    await expect(q).resolves.toMatchObject({ autoPicked: true })
  })

  it('Plan approval (another tool) gets no autoPick', () => {
    const broker = makeBroker(true)
    void ask(broker, { plan: 'x' }, 'ExitPlanMode')
    expect(broker.list()[0]?.autoPick).toBeUndefined()
  })
})
