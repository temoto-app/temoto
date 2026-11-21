/**
 * Multiple-choice questions (T31 / ARCHITECTURE.md 4.2.2).
 *
 * The real input is `test/fixtures/ask-user-question.json` — **the permission request that CLI 2.1.207 actually sent to the
 * gateway**, with the question text and choices as they were, only the identifiers replaced with made-up values. Three things are guarded here:
 *
 * 1. A question can be read from the real shape (if it cannot be read, it falls back to the generic display).
 * 2. A question **never passes automatically** (it skips rules and the default allow).
 * 3. The returned `updatedInput` does not contain a label that is not among the choices.
 *
 * The model is not called.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalBroker, type ApprovalResult } from '../src/main/approval/broker.js'
import { asDecision } from '../src/main/ipc/handlers.js'
import { answeredInput, isAnswerRequest, questionsOf } from '../src/main/approval/questions.js'
import type { JsonValue } from '../src/shared/agent.js'
import type { ApprovalPolicy, ApprovalQuestion } from '../src/shared/thread.js'

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/ask-user-question.json'), 'utf8')
) as { toolName: string; input: JsonValue }

/** A setting that lets everything through by default. Used to check that a question does not get past it. */
const LOOSE_POLICY: ApprovalPolicy = {
  // The same "allow everything" as the T40 default. Checks that the question does not get past it.
  autoAllowAll: true,
  autoAllowTools: ['Bash', 'AskUserQuestion'],
  bashDenyPatterns: []
}

const question = (over: Partial<ApprovalQuestion> = {}): ApprovalQuestion => ({
  question: 'どれ?',
  header: '選択',
  multiSelect: false,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' }
  ],
  ...over
})

describe('questionsOf (reading questions from the real request)', () => {
  it('can read the real thing the CLI sent', () => {
    const questions = questionsOf(fixture.toolName, fixture.input)
    expect(questions).not.toBeNull()
    expect(questions).toHaveLength(1)
    expect(questions?.[0]?.question).toBe('好きな果物を1つ選んでください。')
    expect(questions?.[0]?.header).toBe('好きな果物')
    expect(questions?.[0]?.multiSelect).toBe(false)
    expect(questions?.[0]?.options.map((option) => option.label)).toEqual([
      'りんご',
      'みかん',
      'ぶどう'
    ])
  })

  it('other tools are not questions', () => {
    expect(questionsOf('Bash', { command: 'make all' } as JsonValue)).toBeNull()
  })

  it('an unreadable shape falls to null (degrades to the generic display)', () => {
    expect(questionsOf(fixture.toolName, {} as JsonValue)).toBeNull()
    expect(questionsOf(fixture.toolName, { questions: [] } as unknown as JsonValue)).toBeNull()
    // No choices / the label is not a string
    expect(
      questionsOf(fixture.toolName, { questions: [{ question: 'x', options: [] }] } as unknown as JsonValue)
    ).toBeNull()
    expect(
      questionsOf(fixture.toolName, {
        questions: [{ question: 'x', options: [{ label: 1 }] }]
      } as unknown as JsonValue)
    ).toBeNull()
  })

  it('does not accept a request with duplicate question texts (they would not be answer keys)', () => {
    const input = {
      questions: [
        { question: '同じ', options: [{ label: 'A', description: '' }] },
        { question: '同じ', options: [{ label: 'B', description: '' }] }
      ]
    } as unknown as JsonValue
    expect(questionsOf(fixture.toolName, input)).toBeNull()
  })

  it('isAnswerRequest is true only when it could be read', () => {
    expect(isAnswerRequest(questionsOf(fixture.toolName, fixture.input))).toBe(true)
    expect(isAnswerRequest(null)).toBe(false)
  })
})

describe('answeredInput (arguments returned to the backend)', () => {
  it('adds answers while keeping the original arguments', () => {
    const questions = questionsOf(fixture.toolName, fixture.input)
    expect(questions).not.toBeNull()
    const { updatedInput, summary } = answeredInput(
      fixture.input,
      questions as readonly ApprovalQuestion[],
      { '好きな果物を1つ選んでください。': ['みかん'] }
    )
    const record = updatedInput as Record<string, unknown>
    expect(record['questions']).toEqual((fixture.input as Record<string, unknown>)['questions'])
    expect(record['answers']).toEqual({ '好きな果物を1つ選んでください。': 'みかん' })
    expect(record['response']).toBeUndefined()
    expect(summary).toBe('好きな果物を1つ選んでください。 → みかん')
  })

  it("labels not in the options are dropped (the renderer's values are re-verified in main)", () => {
    const { updatedInput } = answeredInput({}, [question()], { 'どれ?': ['C'] })
    expect((updatedInput as Record<string, unknown>)['answers']).toEqual({})
  })

  it('unknown question texts are dropped', () => {
    const { updatedInput } = answeredInput({}, [question()], { 'ほかの質問': ['A'] })
    expect((updatedInput as Record<string, unknown>)['answers']).toEqual({})
  })

  it("multi select becomes one comma-separated string (the backend's encoding)", () => {
    const q = question({ multiSelect: true })
    const { updatedInput } = answeredInput({}, [q], { 'どれ?': ['A', 'B', 'A'] })
    expect((updatedInput as Record<string, unknown>)['answers']).toEqual({ 'どれ?': 'A, B' })
  })

  it('when two come for a single select, takes only the first', () => {
    const { updatedInput } = answeredInput({}, [question()], { 'どれ?': ['B', 'A'] })
    expect((updatedInput as Record<string, unknown>)['answers']).toEqual({ 'どれ?': 'B' })
  })

  it("without a selection, the free text becomes that question's answer", () => {
    const { updatedInput, summary } = answeredInput({}, [question()], {}, { 'どれ?': '  C 案  ' })
    expect((updatedInput as Record<string, unknown>)['answers']).toEqual({ 'どれ?': 'C 案' })
    expect((updatedInput as Record<string, unknown>)['annotations']).toBeUndefined()
    expect(summary).toBe('どれ? → C 案')
  })

  it('with a selection, the free text becomes a note (not put into response)', () => {
    const { updatedInput, summary } = answeredInput(
      {},
      [question()],
      { 'どれ?': ['A'] },
      { 'どれ?': 'ただし急ぎで' }
    )
    const record = updatedInput as Record<string, unknown>
    expect(record['answers']).toEqual({ 'どれ?': 'A' })
    expect(record['annotations']).toEqual({ 'どれ?': { notes: 'ただし急ぎで' } })
    // Using `response` means the backend does not pass the choice to the model (measured 2026-09-22).
    expect(record['response']).toBeUndefined()
    expect(summary).toBe('どれ? → A (ただし急ぎで)')
  })

  it('whitespace-only free text is treated as absent', () => {
    const { updatedInput } = answeredInput({}, [question()], { 'どれ?': ['A'] }, { 'どれ?': '   ' })
    expect((updatedInput as Record<string, unknown>)['annotations']).toBeUndefined()
  })
})

describe('ApprovalBroker and questions', () => {
  const makeBroker = (policy: ApprovalPolicy): ApprovalBroker =>
    new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, policy)

  const ask = (
    broker: ApprovalBroker
  ): { promise: Promise<ApprovalResult>; id: () => string } => {
    const promise = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: fixture.toolName,
      summary: '',
      input: fixture.input
    })
    return { promise, id: () => broker.list()[0]?.id ?? '' }
  }

  it('does not pass automatically even if on the default allow-list', async () => {
    const broker = makeBroker(LOOSE_POLICY)
    const { promise, id } = ask(broker)
    expect(broker.list()).toHaveLength(1)
    // "Allow" here means not answering, so the question always stops here.
    broker.decide(id(), { kind: 'deny' })
    await expect(promise).resolves.toMatchObject({ allowed: false })
  })

  it('the answer becomes updatedInput and text for the timeline', async () => {
    const broker = makeBroker(LOOSE_POLICY)
    const { promise, id } = ask(broker)
    broker.decide(id(), {
      kind: 'answer',
      answers: { '好きな果物を1つ選んでください。': ['ぶどう'] }
    })
    const result = await promise
    expect(result.allowed).toBe(true)
    expect(result.by).toBe('user')
    expect((result.updatedInput as Record<string, unknown>)['answers']).toEqual({
      '好きな果物を1つ選んでください。': 'ぶどう'
    })
    expect(result.answer).toBe('好きな果物を1つ選んでください。 → ぶどう')
  })

  it('pressing "Always allow" on a question creates no rule (the next question cannot carry an answer)', async () => {
    const broker = makeBroker(LOOSE_POLICY)
    const first = ask(broker)
    broker.decide(first.id(), { kind: 'allow-always' })
    await expect(first.promise).resolves.toMatchObject({ allowed: true })

    // The second time it also stops (if a rule existed, it would pass through).
    const second = ask(broker)
    expect(broker.list()).toHaveLength(1)
    broker.decide(second.id(), { kind: 'deny' })
    await second.promise
  })

  it('when an answer comes to a request that cannot be read as a question, it falls to a plain allow', async () => {
    const broker = makeBroker({ autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [] })
    const promise = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'Bash',
      summary: 'make all',
      input: { command: 'make all' } as JsonValue
    })
    const id = broker.list()[0]?.id ?? ''
    broker.decide(id, { kind: 'answer', answers: { x: ['y'] } })
    const result = await promise
    expect(result.allowed).toBe(true)
    expect(result.updatedInput).toBeUndefined()
  })
})

/**
 * The entry point from the renderer to main (the "values from the renderer are re-checked in main" rule of 12.7).
 *
 * **In T31 there was no `answer` branch here, so the answer arrived as a denial.** The Broker's tests passed, but it did not work on the real app.
 * Since that kind of gap happened, the whole path is pinned down.
 */
describe('asDecision (IPC entry)', () => {
  it('passes an answer as an answer', () => {
    expect(
      asDecision({ kind: 'answer', answers: { どれ: ['A'] }, texts: { どれ: 'ひとこと' } })
    ).toEqual({ kind: 'answer', answers: { どれ: ['A'] }, texts: { どれ: 'ひとこと' } })
  })

  it('passes auto only when true (TODO 1194; dropping it hides "auto-select the recommendation")', () => {
    expect(asDecision({ kind: 'answer', answers: { どれ: ['A'] }, auto: true })).toEqual({
      kind: 'answer',
      answers: { どれ: ['A'] },
      texts: {},
      auto: true
    })
    expect(asDecision({ kind: 'answer', answers: {}, auto: 'yes' })).toEqual({ kind: 'answer', answers: {}, texts: {} })
  })

  it('drops non-strings (only the shape is tidied and matching the content is left to the Broker)', () => {
    expect(
      asDecision({ kind: 'answer', answers: { どれ: ['A', 7], ほか: 'x' }, texts: { どれ: 9 } })
    ).toEqual({ kind: 'answer', answers: { どれ: ['A'] }, texts: {} })
  })

  it('the shape does not break even without an answer', () => {
    expect(asDecision({ kind: 'answer' })).toEqual({ kind: 'answer', answers: {}, texts: {} })
  })

  it('an unknown kind falls to a refusal', () => {
    expect(asDecision({ kind: 'なにか' })).toMatchObject({ kind: 'deny' })
  })

  it('"Always allow" is ignored even if a scope is sent (`scope` is gone as of T40)', () => {
    expect(asDecision({ kind: 'allow-always', scope: 'cwd' })).toEqual({ kind: 'allow-always' })
    // "Yes, manually approve edits" for plan approval (item 256). Extra fields are dropped.
    expect(asDecision({ kind: 'allow-manual', strict: false })).toEqual({ kind: 'allow-manual' })
    // TODO 994: "do not ask about Bash in this conversation". Whether it is accepted is decided again by the Broker, so only the shape is checked here.
    expect(asDecision({ kind: 'allow-thread', threadId: 'x' })).toEqual({ kind: 'allow-thread' })
  })
})
