/**
 * The selection state of a multiple-choice question (T31 / ARCHITECTURE.md 4.2.2). **Pure functions only.**
 *
 * It is split out of the main component (`QuestionPrompt.tsx`) because it holds the "can we send" decision.
 * A wrong decision leaves the **session stuck** (the backend waits until the answer is returned).
 * Same standing as `composer-keys.ts`; regression coverage is in `test/approval-answers.test.ts`.
 */
import type { ApprovalQuestion } from '@shared/thread.js'

/** Question text -> the labels picked. One unless multi-select. */
export type Picked = Readonly<Record<string, readonly string[]>>

/**
 * The new state after an option is pressed.
 * Single-select **replaces** (pressing the same one again clears it); multi-select **toggles**.
 */
export function toggleOption(picked: Picked, question: ApprovalQuestion, label: string): Picked {
  const current = picked[question.question] ?? []
  if (!question.multiSelect) {
    const next = current.includes(label) ? [] : [label]
    return { ...picked, [question.question]: next }
  }
  const next = current.includes(label)
    ? current.filter((value) => value !== label)
    : [...current, label]
  return { ...picked, [question.question]: next }
}

export function isPicked(picked: Picked, question: ApprovalQuestion, label: string): boolean {
  return (picked[question.question] ?? []).includes(label)
}

/** Question text -> the free text written for that question. */
export type Texts = Readonly<Record<string, string>>

/**
 * Whether the answers can be sent.
 *
 * **Every question must have either a choice or free text.** Free text is an "answer that is none of the
 * options", so writing without choosing is valid. Conversely, sending with even one question left empty
 * reaches the backend in a form close to "did not answer", so we block it.
 */
export function canSubmitAnswers(
  questions: readonly ApprovalQuestion[],
  picked: Picked,
  texts: Texts
): boolean {
  if (questions.length === 0) return false
  return questions.every(
    (question) =>
      (picked[question.question] ?? []).length > 0 ||
      (texts[question.question] ?? '').trim() !== ''
  )
}

// ---- Item 166 (wave 13 bundle L): state for showing the question where the Composer is -----------------------
//
// "Other" (free text) is listed as the last row of the options (same shape as the CLI's question screen).
// Since the always-visible free text field was dropped, we keep per question whether "Other" is selected.
// **The shape sent to main (`answers` = question text -> label, `texts` = question text -> free text) does not change.**
// `texts` carries only the non-empty free text of questions where "Other" is selected (`sentTexts`).
// With no selection, main's `answeredInput` puts the free text as the answer itself; with a selection, it puts it in
// `annotations[question].notes` (measured in T31). For single-select "Other" and the options are exclusive, so the
// former applies; with multi-select, checks combined with "Other" give the latter.

/** Question text -> whether "Other" (free text) is selected. */
export type Others = Readonly<Record<string, boolean>>

/** The answer state of one request, combining the options, "Other" and the free text. */
export interface AnswerState {
  readonly picked: Picked
  readonly texts: Texts
  readonly others: Others
}

export const EMPTY_ANSWER_STATE: AnswerState = { picked: {}, texts: {}, others: {} }

/**
 * Selects an option. Single-select **replaces** (pressing again does not clear it: when going back and forth
 * between several questions to re-pick, it would be a nuisance if pressing the same one cleared it), and "Other" is cleared. Multi-select toggles.
 */
export function chooseOption(state: AnswerState, question: ApprovalQuestion, label: string): AnswerState {
  if (question.multiSelect) return { ...state, picked: toggleOption(state.picked, question, label) }
  return {
    ...state,
    picked: { ...state.picked, [question.question]: [label] },
    others: { ...state.others, [question.question]: false }
  }
}

/**
 * Selects "Other" (if `on` is omitted: single-select selects, multi-select toggles).
 * In single-select, selecting it clears the options (exclusive).
 */
export function chooseOther(state: AnswerState, question: ApprovalQuestion, on?: boolean): AnswerState {
  const next = on ?? (question.multiSelect ? state.others[question.question] !== true : true)
  const others = { ...state.others, [question.question]: next }
  if (question.multiSelect || !next) return { ...state, others }
  return { ...state, others, picked: { ...state.picked, [question.question]: [] } }
}

/**
 * Rewrites the free text. **Starting to write counts as selecting "Other"** (in single-select the options are cleared).
 * Emptying it keeps "Other" selected (if it vanished while the cursor is in the field, it would jump as soon as you retype).
 */
export function writeOther(state: AnswerState, question: ApprovalQuestion, text: string): AnswerState {
  const texts = { ...state.texts, [question.question]: text }
  if (text.trim() === '' || state.others[question.question] === true) return { ...state, texts }
  return chooseOther({ ...state, texts }, question, true)
}

/** The free text sent to main. Only non-empty ones for which "Other" is selected. */
export function sentTexts(questions: readonly ApprovalQuestion[], state: AnswerState): Texts {
  const out: Record<string, string> = {}
  for (const question of questions) {
    const text = state.texts[question.question] ?? ''
    if (state.others[question.question] === true && text.trim() !== '') out[question.question] = text
  }
  return out
}

/** Whether everything has an answer and can be sent (asks in the shape passed to `canSubmitAnswers`). */
export function canSubmitState(questions: readonly ApprovalQuestion[], state: AnswerState): boolean {
  return canSubmitAnswers(questions, state.picked, sentTexts(questions, state))
}
