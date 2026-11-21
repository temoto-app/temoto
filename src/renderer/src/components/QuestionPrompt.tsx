/**
 * Shows a multiple-choice question (T31 / ARCHITECTURE.md 4.2.2) **in the Composer's place** (item 166, wave 13 bundle L).
 *
 * While a question is shown, ThreadPane hides the Composer and draws this; once answered (or "don't answer" = Esc), the
 * Composer comes back. The form started from the CLI's question screen (the note at the top of `question-keys.ts`), and
 * **item 895 (wave 47) dropped "one tab per question" and put all questions vertically in one frame**:
 *
 * - Per question: a header badge, the question text, option cards (the first line is a bold "number. label", the second a small description),
 *   and a multi-line "Other (write freely)" field. A chosen card gets a stronger border. The form is the same for a single question.
 * - Choosing does not advance or send. It is sent with the "Answer" button under the frame (disabled until every question is answered) or with Cmd/Ctrl+Enter.
 *   "Don't answer" (Esc) is a refusal (main returns the CLI's default sentence, i.e. stop and wait; item 183).
 *   There is no confirmation screen and no "answer in chat" row ("Other" is enough; owner decision 2026-10-20).
 * - Keys: Up/Down move the cursor across all questions, a digit picks that numbered row of the question under the cursor, Enter / Space chooses.
 *   When the cursor lands on an "Other" row it enters the field, and leaving returns to the frame (exit with Up at the start / Down at the end).
 * - The button row sticks to the bottom edge and stays visible even when the contents do not fit the window and scroll inside (`position: sticky`).
 * - "Always allow" is not shown (T31). How the answers are carried (`answers` / `texts`) is built by a pure function in
 *   `approval-answers.ts`, and main's `answeredInput` assembles it into the T31 shape (the notes of the per-question annotations).
 *
 * **The renderer never looks at the backend's tool name.** Only requests whose `item.questions` is not null come here.
 * The dispatch (question vs. permission/plan) is `ApprovalOrComposer` (`ApprovalPrompt.tsx`, item 182).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApprovalItem, ApprovalQuestion } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import {
  EMPTY_ANSWER_STATE,
  canSubmitState,
  chooseOption,
  chooseOther,
  isPicked,
  sentTexts,
  writeOther,
  type AnswerState
} from '../approval-answers.js'
import { moveQuestionCursor, questionKeyAction, questionRows, type Cursor } from '../question-keys.js'
import { formatHeld } from '../thread/timeline.js'
import { useT } from '../i18n/index.js'
import { PROMPT_STALE_MS, SubtaskLabel, useHeld, usePromptFrame } from './PromptParts.js'

/**
 * When showing a recommended badge, strips the trailing "(Recommended)" (in Japanese or English) from the displayed label (so the badge and the text do not overlap).
 * Display only; the value returned as the answer stays the original label (matching is main's `isRecommendedLabel`, TODO 1194).
 */
export function withoutRecommendedMark(label: string): string {
  const stripped = label.replace(/\s*[(（]\s*(?:推奨|recommended)\s*[)）]\s*$/i, '')
  return stripped === '' ? label : stripped
}

export function QuestionPrompt({
  item,
  waiting
}: {
  item: ApprovalItem
  /** The number of questions waiting behind this one in this thread. */
  waiting: number
}): React.JSX.Element | null {
  if (item.questions === null) return null
  // When the request changes, rebuild all the state (the selection and input belong to the previous question).
  return <QuestionForm key={item.id} item={item} questions={item.questions} waiting={waiting} />
}

function QuestionForm({
  item,
  questions,
  waiting
}: {
  item: ApprovalItem
  questions: readonly ApprovalQuestion[]
  waiting: number
}): React.JSX.Element {
  const t = useT()
  const decide = useThreads((state) => state.decide)
  const [answers, setAnswers] = useState<AnswerState>(EMPTY_ANSWER_STATE)
  const [cursor, setCursor] = useState<Cursor>({ q: 0, row: 0 })
  const [sent, setSent] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  /** The "Other" field of each question. */
  const textRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const ready = canSubmitState(questions, answers)
  const held = useHeld(item.requestedAt)
  // Align to the end and focus at the moment it appears (shared with the permission/plan screen).
  usePromptFrame(frameRef)

  const cursorQuestion = questions[cursor.q] ?? null
  const cursorRows = cursorQuestion === null ? null : questionRows(cursorQuestion)
  const activeText = (): HTMLTextAreaElement | null => textRefs.current[cursor.q] ?? null

  // When the cursor lands on an "Other" row it enters the field, and leaving returns to the list (the same behavior as the CLI's Other).
  const onOther = cursorRows !== null && cursor.row === cursorRows.other
  useLayoutEffect(() => {
    if (onOther) {
      textRefs.current[cursor.q]?.focus({ preventScroll: false })
    } else if (
      document.activeElement instanceof HTMLTextAreaElement &&
      textRefs.current.includes(document.activeElement)
    ) {
      frameRef.current?.focus({ preventScroll: true })
    }
  }, [onOther, cursor.q])

  // TODO 1194: countdown that picks the recommendation automatically. If anything inside the frame is touched (click, key) it is aborted and stays manual from then on.
  // The effect's dependencies are primitives only. `approvals.onChanged` can keep arriving at under 1 second intervals, and if it depended on
  // object identity the timer would be recreated every time and never finish counting. `decide` is also held as the latest through a ref.
  const pickLabel = item.autoPick?.label ?? null
  const pickSeconds = item.autoPick?.seconds ?? null
  const firstQuestion = questions[0]?.question ?? null
  const decideRef = useRef(decide)
  decideRef.current = decide
  const [countdown, setCountdown] = useState<number | null>(pickSeconds)
  const stopCountdown = (): void => setCountdown(null)
  // When auto-select is turned off in settings, main removes `autoPick`. Stop even mid-count and wait for the person's answer.
  useEffect(() => {
    if (pickLabel === null) setCountdown(null)
  }, [pickLabel])
  useEffect(() => {
    if (countdown === null || sent || pickLabel === null || firstQuestion === null) return
    if (countdown <= 0) {
      setSent(true)
      decideRef.current(item.id, { kind: 'answer', answers: { [firstQuestion]: [pickLabel] }, auto: true }).catch(() => {
        setSent(false)
        setCountdown(null)
      })
      return
    }
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown, sent, pickLabel, firstQuestion, item.id])

  const submit = (state: AnswerState): void => {
    if (sent || !canSubmitState(questions, state)) return
    setSent(true)
    // Put it back so it can be pressed again if it did not arrive (if it arrived, the request disappears and this component is removed with it).
    decide(item.id, { kind: 'answer', answers: state.picked, texts: sentTexts(questions, state) }).catch(() =>
      setSent(false)
    )
  }
  /** "Don't answer" (Esc). Declines without a sentence; main returns the CLI's default refusal sentence (stop and wait) (item 183). */
  const cancel = (): void => {
    if (sent) return
    setSent(true)
    decide(item.id, { kind: 'deny' }).catch(() => setSent(false))
  }

  const chooseRow = (q: number, row: number): void => {
    const question = questions[q]
    if (question === undefined) return
    const rows = questionRows(question)
    setCursor({ q, row })
    if (row < rows.options) {
      const label = question.options[row]?.label
      if (label !== undefined) setAnswers(chooseOption(answers, question, label))
      return
    }
    if (row === rows.other) {
      // Enter the field (if the cursor is already on this row the effect does not run, so move it here too). For multi-select, the mark is toggled as well.
      textRefs.current[q]?.focus()
      if (question.multiSelect) setAnswers(chooseOther(answers, question))
    }
  }

  /** Moves the cursor on hover. Not while typing in an "Other" field (it would steal focus from the field). */
  const hover = (q: number, row: number): void => {
    if (document.activeElement !== activeText()) setCursor({ q, row })
  }

  const commitText = (): void => {
    const question = cursorQuestion
    if (question === null) return
    const text = answers.texts[question.question] ?? ''
    // Enter on an empty field: for multi-select just clears the "Other" mark. For single-select, nothing.
    if (text.trim() === '') {
      if (question.multiSelect) setAnswers(chooseOther(answers, question, false))
    } else {
      setAnswers(chooseOther(answers, question, true))
    }
    // Leaving the field, so return focus to the frame (if the field is removed and focus drops to body, Enter stops working, item 196).
    frameRef.current?.focus({ preventScroll: true })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const textarea = activeText()
    const inText = event.target === textarea && textarea !== null
    // Enter / Space on a button (answer, don't answer) is left to the button itself. Only Esc and Cmd+Enter are picked up.
    const submitKey = event.key === 'Enter' && (event.metaKey || event.ctrlKey)
    if (!inText && event.target !== frameRef.current && event.key !== 'Escape' && !submitKey) return
    const action = questionKeyAction(event.nativeEvent, {
      numbered: cursorRows?.numbered ?? 0,
      inText,
      caretAtStart: inText && textarea.selectionStart === 0 && textarea.selectionEnd === 0,
      caretAtEnd: inText && textarea.selectionStart === textarea.value.length
    })
    if (action.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()
    switch (action.kind) {
      case 'cancel':
        cancel()
        return
      case 'submit':
        submit(answers)
        return
      case 'leaveText':
        frameRef.current?.focus({ preventScroll: true })
        return
      case 'commitText':
        commitText()
        return
      case 'move':
        setCursor(moveQuestionCursor(cursor, action.delta, questions))
        return
      case 'choose':
        chooseRow(cursor.q, action.row)
        return
      case 'activate':
        chooseRow(cursor.q, cursor.row)
        return
    }
  }

  return (
    <div className="question-prompt" role="region" aria-label={t('question.region')}>
      <div
        ref={frameRef}
        className={`question-frame${held > PROMPT_STALE_MS ? ' stale' : ''}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyDownCapture={countdown === null ? undefined : stopCountdown}
        onPointerDownCapture={countdown === null ? undefined : stopCountdown}
        aria-activedescendant={`q-${item.id}-${cursor.q}-${cursor.row}`}
      >
        <SubtaskLabel item={item} />
        <div className="question-top">
          <span className="question-kind">{t('question.title')}</span>
          {waiting > 0 ? <span className="question-waiting">{t('question.waiting', { count: waiting })}</span> : null}
          <span className="approval-held" title={t('approval.questionHeldHint')}>
            {formatHeld(held, t)}
          </span>
        </div>

        {questions.map((question, q) => {
          const rows = questionRows(question)
          return (
            <section key={question.question} className="question-body question-block">
              {question.header !== '' ? <span className="question-header">{question.header}</span> : null}
              <p className="question-text">{question.question}</p>
              {question.multiSelect ? <p className="question-hint">{t('approval.multiSelect')}</p> : null}
              <div
                className="question-choices"
                role="listbox"
                aria-multiselectable={question.multiSelect}
                aria-label={question.question}
              >
                {question.options.map((option, index) => {
                  const picked = isPicked(answers.picked, question, option.label)
                  const active = cursor.q === q && cursor.row === index
                  return (
                    <div
                      key={option.label}
                      id={`q-${item.id}-${q}-${index}`}
                      role="option"
                      aria-selected={picked}
                      className={`question-choice${active ? ' active' : ''}${picked ? ' picked' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseRow(q, index)}
                      onMouseEnter={() => hover(q, index)}
                    >
                      {question.multiSelect ? (
                        <span className="question-check" aria-hidden="true">
                          {picked ? '☑' : '☐'}
                        </span>
                      ) : null}
                      <span className="question-choice-body">
                        <span className="question-label">
                          {index + 1}.{' '}
                          {option.recommended === true ? withoutRecommendedMark(option.label) : option.label}
                          {option.recommended === true ? (
                            <span className="question-recommended">{t('question.recommended')}</span>
                          ) : null}
                          {!question.multiSelect && picked ? (
                            <span className="question-picked-mark" aria-hidden="true">
                              {' ✓'}
                            </span>
                          ) : null}
                        </span>
                        {option.description === '' ? null : (
                          <span className="question-desc">{option.description}</span>
                        )}
                      </span>
                    </div>
                  )
                })}
                <OtherRow
                  id={`q-${item.id}-${q}-${rows.other}`}
                  question={question}
                  answers={answers}
                  active={cursor.q === q && cursor.row === rows.other}
                  textRef={(el) => {
                    textRefs.current[q] = el
                  }}
                  onFocusRow={() => setCursor({ q, row: rows.other })}
                  onToggle={() => setAnswers(chooseOther(answers, question))}
                  onChange={(text) => setAnswers(writeOther(answers, question, text))}
                />
              </div>
            </section>
          )
        })}

        {countdown !== null && pickLabel !== null ? (
          <p className="question-autopick" role="status">
            {t('question.autoPick', { label: pickLabel, seconds: String(countdown) })}
            <button type="button" onClick={stopCountdown}>
              {t('question.autoPickStop')}
            </button>
          </p>
        ) : null}
        <p className="question-footnote">{t('question.footnote')}</p>
        <div className="question-actions">
          <span className="question-keys">{t('question.keys')}</span>
          <button type="button" className="question-submit" disabled={!ready || sent} onClick={() => submit(answers)}>
            {t('approval.answer')}
          </button>
          <button type="button" disabled={sent} onClick={cancel} title={t('question.noAnswerHint')}>
            {t('approval.noAnswer')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The "Other (write freely)" card. The multi-line field (resizable at the bottom right) is itself the input, and it is entered when the cursor lands on it.
 * In single-select it is exclusive with the options (typing clears the selection); in multi-select it has a mark, and typing sets the mark.
 */
function OtherRow({
  id,
  question,
  answers,
  active,
  textRef,
  onFocusRow,
  onToggle,
  onChange
}: {
  id: string
  question: ApprovalQuestion
  answers: AnswerState
  active: boolean
  textRef: (el: HTMLTextAreaElement | null) => void
  onFocusRow: () => void
  onToggle: () => void
  onChange: (text: string) => void
}): React.JSX.Element {
  const t = useT()
  const chosen = answers.others[question.question] === true
  return (
    <div
      id={id}
      role="option"
      aria-selected={chosen}
      className={`question-choice other${active ? ' active' : ''}${chosen ? ' picked' : ''}`}
      // Hover does not move the cursor (moving it would shift focus to the field and change where keystrokes go).
      onClick={onFocusRow}
    >
      {question.multiSelect ? (
        <span
          className="question-check"
          aria-hidden="true"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {chosen ? '☑' : '☐'}
        </span>
      ) : null}
      <span className="question-choice-body">
        <span className="question-label">{t('question.other')}</span>
        <textarea
          ref={textRef}
          className="question-other-input"
          value={answers.texts[question.question] ?? ''}
          placeholder={t('approval.otherPlaceholder')}
          aria-label={t('question.other')}
          rows={2}
          onFocus={onFocusRow}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </div>
  )
}
