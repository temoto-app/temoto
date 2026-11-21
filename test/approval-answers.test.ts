/**
 * The selection state and the check of whether it can be sent (T31 / 4.2.2). It is a pure function in the renderer, so no DOM is needed.
 *
 * Getting this wrong leaves the **session stuck** (the backend waits until an answer comes back).
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_ANSWER_STATE,
  canSubmitAnswers,
  canSubmitState,
  chooseOption,
  chooseOther,
  isPicked,
  sentTexts,
  toggleOption,
  writeOther,
  type Picked
} from '../src/renderer/src/approval-answers.js'
import { answeredInput } from '../src/main/approval/questions.js'
import type { ApprovalQuestion } from '../src/shared/thread.js'

const single: ApprovalQuestion = {
  question: 'どれ?',
  header: '',
  multiSelect: false,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' }
  ]
}
const multi: ApprovalQuestion = { ...single, question: 'どれとどれ?', multiSelect: true }

describe('toggleOption', () => {
  it('single select replaces', () => {
    let picked: Picked = {}
    picked = toggleOption(picked, single, 'A')
    picked = toggleOption(picked, single, 'B')
    expect(picked['どれ?']).toEqual(['B'])
  })

  it('single select deselects when the same one is pressed again', () => {
    const picked = toggleOption(toggleOption({}, single, 'A'), single, 'A')
    expect(picked['どれ?']).toEqual([])
  })

  it('multi select toggles', () => {
    let picked: Picked = {}
    picked = toggleOption(picked, multi, 'A')
    picked = toggleOption(picked, multi, 'B')
    expect(picked['どれとどれ?']).toEqual(['A', 'B'])
    picked = toggleOption(picked, multi, 'A')
    expect(picked['どれとどれ?']).toEqual(['B'])
  })

  it('isPicked is true only for chosen ones', () => {
    const picked = toggleOption({}, single, 'A')
    expect(isPicked(picked, single, 'A')).toBe(true)
    expect(isPicked(picked, single, 'B')).toBe(false)
  })
})

describe('canSubmitAnswers', () => {
  it('can submit when every question has a choice', () => {
    const picked = toggleOption(toggleOption({}, single, 'A'), multi, 'B')
    expect(canSubmitAnswers([single, multi], picked, {})).toBe(true)
  })

  it('cannot submit if even one question is empty', () => {
    expect(canSubmitAnswers([single, multi], toggleOption({}, single, 'A'), {})).toBe(false)
  })

  it('a question filled with free text counts as answered', () => {
    const picked = toggleOption({}, single, 'A')
    expect(canSubmitAnswers([single, multi], picked, { 'どれとどれ?': 'ほかの案' })).toBe(true)
  })

  it('cannot submit with neither a choice nor free text (it would be the same as not answering)', () => {
    expect(canSubmitAnswers([single], {}, { 'どれ?': '   ' })).toBe(false)
    expect(canSubmitAnswers([single], {}, {})).toBe(false)
    expect(canSubmitAnswers([], {}, {})).toBe(false)
  })
})

/**
 * Item 166 (wave 13 bundle L): the state where "Other" is the last line of the choices. **The shape sent to main stays as in T31**
 * (`answers` = question text -> label, `texts` = question text -> free text). At the end it passes through main's `answeredInput`, and
 * the shape of `updatedInput` that reaches the model is checked too (the T31 pitfall: free text is not `response`; if nothing is chosen it is the answer itself,
 * and if something is chosen it is `annotations[question].notes`).
 */
describe('answer state (item 166)', () => {
  it('single select replaces, and choosing the same one again does not clear it (to re-choose while moving between questions)', () => {
    let state = chooseOption(EMPTY_ANSWER_STATE, single, 'A')
    state = chooseOption(state, single, 'A')
    expect(state.picked['どれ?']).toEqual(['A'])
    state = chooseOption(state, single, 'B')
    expect(state.picked['どれ?']).toEqual(['B'])
  })

  it('in single select, "Other" and the options are exclusive', () => {
    let state = chooseOption(EMPTY_ANSWER_STATE, single, 'A')
    state = writeOther(state, single, 'どれでもない')
    expect(state.picked['どれ?']).toEqual([])
    expect(state.others['どれ?']).toBe(true)
    // Choosing a different option removes "Other", and what was written is not sent (it stays in the field).
    state = chooseOption(state, single, 'B')
    expect(state.others['どれ?']).toBe(false)
    expect(state.texts['どれ?']).toBe('どれでもない')
    expect(sentTexts([single], state)).toEqual({})
  })

  it('in multi select, "Other" toggles with its mark and can be combined with options', () => {
    let state = chooseOption(EMPTY_ANSWER_STATE, multi, 'A')
    state = chooseOther(state, multi)
    expect(state.others['どれとどれ?']).toBe(true)
    expect(state.picked['どれとどれ?']).toEqual(['A'])
    state = chooseOther(state, multi)
    expect(state.others['どれとどれ?']).toBe(false)
  })

  it('once typing starts, "Other" counts as chosen, and stays chosen even when emptied', () => {
    let state = writeOther(EMPTY_ANSWER_STATE, multi, 'x')
    expect(state.others['どれとどれ?']).toBe(true)
    state = writeOther(state, multi, '')
    expect(state.others['どれとどれ?']).toBe(true)
    // Free text that is only whitespace is not sent and does not count as an answer.
    expect(sentTexts([multi], writeOther(state, multi, '   '))).toEqual({})
  })

  it('whether it can be sent is decided by the sent form (`sentTexts`) — text in a field whose "Other" was cleared cannot be sent', () => {
    const written = writeOther(EMPTY_ANSWER_STATE, single, '自由記述')
    expect(canSubmitState([single], written)).toBe(true)
    const unchecked = chooseOther(written, single, false)
    expect(canSubmitState([single], unchecked)).toBe(false)
  })

  it('through main it takes the T31 form: "Other" in single select is the answer itself', () => {
    const state = writeOther(chooseOption(EMPTY_ANSWER_STATE, single, 'A'), single, 'どれでもない')
    const { updatedInput } = answeredInput({ questions: [] }, [single], state.picked, sentTexts([single], state))
    expect(updatedInput).toEqual({ questions: [], answers: { 'どれ?': 'どれでもない' } })
  })

  it('through main it takes the T31 form: choices + "Other" in multi select go to the notes of annotations (response is not used)', () => {
    let state = chooseOption(EMPTY_ANSWER_STATE, multi, 'A')
    state = chooseOption(state, multi, 'B')
    state = writeOther(state, multi, '両方ほしい')
    const { updatedInput } = answeredInput({}, [multi], state.picked, sentTexts([multi], state))
    expect(updatedInput).toEqual({
      answers: { 'どれとどれ?': 'A, B' },
      annotations: { 'どれとどれ?': { notes: '両方ほしい' } }
    })
    expect(updatedInput).not.toHaveProperty('response')
  })
})
