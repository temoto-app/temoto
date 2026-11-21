/**
 * Multiple-choice questions (ARCHITECTURE.md 4.2.2, T31).
 *
 * The backend's "question tool" **arrives as a permission request like any other tool** (measured in T31).
 * The only difference is that the answer is returned in `updatedInput` of `allow`, so from aios's side it is
 * not "approve / deny" but "answer / don't answer".
 *
 * This file is **pure functions only**. What is backend-specific is these three:
 * - the tool name (`ASK_TOOL`)
 * - the shape of the arguments (`questions[]`, and `answers` / `response` that return the answer)
 * - the encoding that **a multiple selection is one comma-separated string**
 *
 * which puts it in the same position as `TARGET_PATH_KEYS` in `policy.ts` (not a forbidden word of constraint 6, but
 * a candidate to move to compat/ when another backend is added. The same homework as TODO 39).
 *
 * The renderer is **not given the tool name**. If `ApprovalItem.questions` is not null, it is
 * "a request that asks for an answer", and the renderer changes the display by looking only at that.
 */
import type { JsonValue } from '@shared/agent.js'
import type { ApprovalQuestion } from '@shared/thread.js'

/** The name of the tool that asks questions (backend-specific). */
export const ASK_TOOL = 'AskUserQuestion'

/** Upper limit for display and matching. A brake so that a broken request cannot wreck the UI. */
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 12

/**
 * Whether this request asks for an "answer".
 *
 * It is treated as a question only when it could be read in an answerable form. If it cannot be read, null is returned
 * and the caller falls back to **the generic display + allow / deny as before** (degradation).
 */
export function questionsOf(toolName: string, input: JsonValue): readonly ApprovalQuestion[] | null {
  if (toolName !== ASK_TOOL) return null
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = (input as Record<string, unknown>)['questions']
  if (!Array.isArray(raw) || raw.length === 0) return null

  const questions: ApprovalQuestion[] = []
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    const question = record['question']
    const options = record['options']
    if (typeof question !== 'string' || question.trim() === '') return null
    if (!Array.isArray(options) || options.length === 0) return null

    const parsed: { label: string; description: string; recommended?: boolean }[] = []
    for (const option of options.slice(0, MAX_OPTIONS)) {
      if (typeof option !== 'object' || option === null || Array.isArray(option)) return null
      const label = (option as Record<string, unknown>)['label']
      const description = (option as Record<string, unknown>)['description']
      if (typeof label !== 'string' || label.trim() === '') return null
      parsed.push({
        label,
        description: typeof description === 'string' ? description : '',
        ...(isRecommendedLabel(label) ? { recommended: true } : {})
      })
    }
    const header = record['header']
    questions.push({
      question,
      header: typeof header === 'string' ? header : '',
      multiSelect: record['multiSelect'] === true,
      options: parsed
    })
  }
  // The question text is the key of the answer, so if there are duplicates the answer cannot be returned.
  const texts = new Set(questions.map((q) => q.question))
  if (texts.size !== questions.length) return null
  return questions
}

/**
 * Whether the end of a label is "(Recommended)" or its Japanese equivalent (TODO 1194). The backend puts the recommended option first and puts this marker at the end of its label
 * (English and Japanese only. The full-width parentheses are read too). The renderer is not given the string; it gets `ApprovalQuestionOption.recommended`.
 */
export function isRecommendedLabel(label: string): boolean {
  return /[(（]\s*(?:推奨|recommended)\s*[)）]\s*$/i.test(label.trim())
}

/** Seconds of the countdown for picking the recommendation automatically (owner decision 2026-11-08: about 5 seconds, interrupted by touching). */
export const AUTO_PICK_SECONDS = 5

/**
 * Whether a question may have its recommendation picked automatically (TODO 1194). Returns the label only when **there is one question, it is single-choice, and the first option is the recommendation**.
 * Multiple choice, a recommendation that is not first, and several questions (which have a confirmation screen) are null (stop as before).
 */
export function recommendedPick(questions: readonly ApprovalQuestion[] | null): { question: string; label: string } | null {
  if (questions === null || questions.length !== 1) return null
  const only = questions[0] as ApprovalQuestion
  if (only.multiSelect) return null
  const first = only.options[0]
  if (first === undefined || first.recommended !== true) return null
  return { question: only.question, label: first.label }
}

/**
 * Whether it is outside "always allow". A question has different contents every time, so a rule keyed by tool name
 * **cannot hold what to answer to the next question**. Pressing it would be meaningless, so no rule is made.
 */
export function isAnswerRequest(questions: readonly ApprovalQuestion[] | null): boolean {
  return questions !== null && questions.length > 0
}

/**
 * Validate an answer from the renderer and build the `updatedInput` to return to the backend.
 *
 * - The key is **the question text itself**. Unknown question texts are dropped.
 * - An option is dropped unless it is **a label of that question** (input from the renderer is re-verified in main).
 * - A multiple selection becomes **one comma-separated string** (the backend's encoding).
 *   If a single-choice question gets two or more, only the first is taken.
 * - Where free text (`texts`) goes **depends on whether there is a selection**. This is what was decided by measuring in T31:
 *   - No selection -> it becomes the answer itself for that question ("not any of them, but this").
 *   - A selection -> attach it to `annotations[<question>].notes`.
 *
 *   **`response` is not used.** If `response` is present, the backend passes only that to the model as
 *   "the user answered this", and **does not tell it which option was selected** (measured 2026-09-22:
 *   when "tangerine" was selected with a note added, the model did not know the selection and answered "apple").
 *   `annotations.notes` reaches the model together with the selection, so we put it there.
 * - The original arguments (`questions` and `metadata`) are left as they are. **Do not rebuild them**:
 *   keeping the shape the backend gave is the only way not to drop keys we do not know.
 */
export function answeredInput(
  input: JsonValue,
  questions: readonly ApprovalQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
  texts: Readonly<Record<string, string>> = {}
): { updatedInput: JsonValue; summary: string } {
  const base =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, JsonValue>)
      : {}

  const clean: Record<string, string> = {}
  const notes: Record<string, { notes: string }> = {}
  const shown: string[] = []

  for (const question of questions) {
    const labels = question.options.map((option) => option.label)
    const picked = [...new Set((answers[question.question] ?? []).filter((l) => labels.includes(l)))]
    const text = (texts[question.question] ?? '').trim()

    if (picked.length > 0) {
      const value = question.multiSelect ? picked.join(', ') : (picked[0] as string)
      clean[question.question] = value
      if (text !== '') notes[question.question] = { notes: text }
      shown.push(`${label(question)} → ${text === '' ? value : `${value} (${text})`}`)
      continue
    }
    if (text !== '') {
      clean[question.question] = text
      shown.push(`${label(question)} → ${text}`)
    }
  }

  const updated: Record<string, JsonValue> = { ...base, answers: clean }
  if (Object.keys(notes).length > 0) updated['annotations'] = notes as unknown as JsonValue

  return { updatedInput: updated, summary: shown.join(' / ') }
}

/**
 * The heading of a question as shown in the timeline.
 *
 * **Use the question text itself** (the label `header` can be empty and cannot distinguish several questions).
 * Cut it to a length that fits one line of an approval: the `summary` of this request is made by
 * `summarize` of `manager`, but a question's arguments have no direct string value, so it is **empty** - what was asked
 * appears only here.
 */
function label(question: ApprovalQuestion): string {
  const text = question.question.replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}
