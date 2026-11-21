/**
 * Key handling and row layout of multiple-choice questions (T31 / 4.2.2) (item 166, wave 13 bundle L. Changed to a vertical list of all questions in item 895).
 * **Pure functions only.**
 *
 * A question appears in the Composer's place, replacing the input field. All the questions are laid out vertically in one frame (895):
 *
 * - Each question's rows are the choices (numbered) and, last, "Other" (a free-text field). The cursor moves along a single
 *   vertical sequence through all questions (`Cursor` = which row of which question).
 * - ↑↓ move the cursor, a number key picks the numbered row **of the question under the cursor**, Enter / Space picks the cursor's row.
 *   Multi-select toggles the mark. Sending is the "Answer" button or ⌘/Ctrl+Enter (even for a single question, choosing alone does not send).
 * - Esc closes without answering (returned as a rejection). There are no tabs, no confirmation screen and no "answer in chat" row (895).
 *
 * As with `composer-keys.ts`, the decision is independent of the DOM. **Keys during composition (IME) are not picked up at all**
 * (T16: in Chromium `isComposing` is set; `keyCode` 229 is a fallback). The regression test is
 * `test/question-keys.test.ts`.
 */
import type { ApprovalQuestion } from '@shared/thread.js'
import type { ComposerKey } from './composer-keys.js'

/** The rows of one question. `other` is the "Other" row (last). */
export interface QuestionRows {
  /** Number of choices (rows 0 to options - 1). */
  readonly options: number
  /** Position of the "Other" row (= `options`). */
  readonly other: number
  /** Total number of rows. */
  readonly count: number
  /** Number of numbers selectable by number keys (choices + "Other"). */
  readonly numbered: number
}

export function questionRows(question: ApprovalQuestion): QuestionRows {
  const options = question.options.length
  return { options, other: options, count: options + 1, numbered: options + 1 }
}

/** The cursor across all questions: which row of which question. */
export interface Cursor {
  readonly q: number
  readonly row: number
}

/**
 * Where the cursor goes when moved up or down. It crosses question boundaries (after the first question's "Other" comes the second question's first row). Stops at the ends.
 */
export function moveQuestionCursor(cursor: Cursor, delta: number, questions: readonly ApprovalQuestion[]): Cursor {
  if (questions.length === 0) return { q: 0, row: 0 }
  let { q, row } = cursor
  let left = Math.abs(delta)
  const dir = delta < 0 ? -1 : 1
  while (left > 0) {
    const count = questionRows(questions[q]!).count
    if (dir === 1) {
      if (row + 1 < count) row += 1
      else if (q + 1 < questions.length) {
        q += 1
        row = 0
      } else break
    } else if (row > 0) row -= 1
    else if (q > 0) {
      q -= 1
      row = questionRows(questions[q]!).count - 1
    } else break
    left -= 1
  }
  return { q, row }
}

/** The action a key asks for. Applying it (rewriting state) is the screen's job. */
export type QuestionKeyAction =
  | { readonly kind: 'none' }
  /** Move the cursor up or down (stops at the ends). */
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  /** Pick the numbered row of the question under the cursor (a number key). Rows are 0-based. */
  | { readonly kind: 'choose'; readonly row: number }
  /** Pick the cursor's row (Enter / Space). */
  | { readonly kind: 'activate' }
  /** Enter in the "Other" field. Decide with the written answer. */
  | { readonly kind: 'commitText' }
  /** Esc in the "Other" field. Keep what was written and return to the list. */
  | { readonly kind: 'leaveText' }
  /** Send the answers (⌘/Ctrl+Enter). */
  | { readonly kind: 'submit' }
  /** Close without answering (the "do not answer" action). */
  | { readonly kind: 'cancel' }

export interface QuestionKeyContext {
  /** The number of rows selectable by number keys in the question under the cursor. */
  readonly numbered: number
  /** Whether the "Other" field (textarea) has focus. */
  readonly inText: boolean
  /** Whether the caret in the field is at the start / end (so ↑↓ inside the field can leave to the list). */
  readonly caretAtStart: boolean
  readonly caretAtEnd: boolean
}

const NONE: QuestionKeyAction = { kind: 'none' }

/**
 * What to do for this key.
 *
 * - During composition (IME), do nothing. Esc also yields to cancelling the composition.
 * - Only ⌘ / Ctrl + Enter is "Answer". Other keys with ⌘ / Ctrl / ⌥ are not taken (they yield to ⌘F and so on).
 * - Inside the "Other" field, typing characters and Shift+Enter (newline) are left to the field. Enter settles the answer,
 *   Esc returns to the list (what was written is not lost). ↑ at the start / ↓ at the end leaves for the list.
 * - In the list: ↑↓ / digits / Enter / Space / Esc. Tab is left to the normal focus movement (to the buttons).
 */
export function questionKeyAction(event: ComposerKey, context: QuestionKeyContext): QuestionKeyAction {
  if (event.isComposing || event.keyCode === 229) return NONE
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === 'Enter') {
    return { kind: 'submit' }
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return NONE

  if (context.inText) {
    switch (event.key) {
      case 'Escape':
        return { kind: 'leaveText' }
      case 'Enter':
        return event.shiftKey ? NONE : { kind: 'commitText' }
      case 'ArrowUp':
        return context.caretAtStart ? { kind: 'move', delta: -1 } : NONE
      case 'ArrowDown':
        return context.caretAtEnd ? { kind: 'move', delta: 1 } : NONE
      default:
        return NONE
    }
  }

  switch (event.key) {
    case 'Escape':
      return { kind: 'cancel' }
    case 'ArrowDown':
      return { kind: 'move', delta: 1 }
    case 'ArrowUp':
      return { kind: 'move', delta: -1 }
    case 'Enter':
      return event.shiftKey ? NONE : { kind: 'activate' }
    case ' ':
      return { kind: 'activate' }
    default:
      break
  }
  if (/^[1-9]$/.test(event.key)) {
    const row = Number(event.key) - 1
    if (row < context.numbered) return { kind: 'choose', row }
  }
  return NONE
}

/** Where the cursor goes when moved in a single vertical sequence (permission and plan approval rows, etc.) (stops at the ends). 0 if there are no rows. */
export function moveCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, cursor + delta))
}
