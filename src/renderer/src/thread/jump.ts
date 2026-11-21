/**
 * The decision for jumping between "my questions" (ARCHITECTURE.md 5.1.4, TODO 53; qlm compatible).
 *
 * Pure functions that touch neither the DOM nor React. The caller (`components/JumpNav.tsx`) passes the
 * scroll dimensions of `.thread-body` and the top edge of each question (a coordinate inside the container, oldest first).
 * The constants were copied from the real qlm (`public/app.js`). Only the slack at the bottom is matched to aios's
 * `pinned` decision (onScroll of ThreadPane, 80px), so the position where "to the last answer" can no longer
 * be pressed coincides with the position where auto-scroll starts to apply.
 */

/** The margin (px) when the destination is put at the top edge. With 0, the message's frame sticks to the top edge and looks cut off. */
export const JUMP_TOP_GAP_PX = 8

/** The box is shown only for conversations that can scroll at least this much. For a conversation that fits one screen it is just in the way. */
export const JUMP_MIN_SCROLL_PX = 160

/** The slack (px) for counting as "at the bottom". The same value as `pinned` in ThreadPane. */
export const STICK_BOTTOM_SLACK_PX = 80

export interface ScrollMetrics {
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
}

export function isAtBottom(box: ScrollMetrics, slack: number = STICK_BOTTOM_SLACK_PX): boolean {
  const gap = box.scrollHeight - box.clientHeight - box.scrollTop
  return !Number.isFinite(gap) || gap < slack
}

/**
 * Which question is being read now (1-based; 0 if there are no questions).
 *
 * **If at the bottom, unconditionally the last question.** If there is not enough space below the body, the last question
 * cannot rise to the top edge (the browser clamps scrollTop at its limit), so with the top-edge criterion alone
 * it would stop at "N-1 / N even though everything is visible" (behavior confirmed on real qlm).
 * Otherwise, the last question that starts above the line `scrollTop + GAP + 1`. The 1px of leniency is so that
 * right after placing at the top edge (`scrollTop = top - GAP`) it still counts as "in that question".
 * If no question has been reached yet (the margin at the start), it counts as the first question.
 */
export function currentQuestionIndex(tops: readonly number[], box: ScrollMetrics): number {
  if (tops.length === 0) return 0
  if (isAtBottom(box)) return tops.length
  const line = box.scrollTop + JUMP_TOP_GAP_PX + 1
  let idx = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! > line) break
    idx = i + 1
  }
  return idx === 0 ? 1 : idx
}

/** The scrollTop that puts that question at the top edge (with the margin). `scrollIntoView` is not used (it cannot place the margin). */
export function jumpScrollTop(top: number): number {
  return Math.max(0, top - JUMP_TOP_GAP_PX)
}

export interface JumpNavState {
  /** True only for a conversation with at least one question that needs scrolling. If false, the box is not shown at all. */
  readonly visible: boolean
  /** The current question (1-based). */
  readonly index: number
  /** The number of questions. */
  readonly count: number
  readonly canFirst: boolean
  readonly canPrev: boolean
  readonly canNext: boolean
  readonly canLast: boolean
}

export const HIDDEN_JUMP_NAV: JumpNavState = {
  visible: false,
  index: 0,
  count: 0,
  canFirst: false,
  canPrev: false,
  canNext: false,
  canLast: false
}

/**
 * Showing / hiding the box and the 4 enabled flags. "To the first question" can be pressed **only when below the position where
 * that question is put at the top edge** (a plain `scrollTop > 0` would allow pressing right after jumping, because of the margin).
 */
export function jumpNavState(tops: readonly number[], box: ScrollMetrics): JumpNavState {
  const room = box.scrollHeight - box.clientHeight
  if (tops.length === 0 || !(room >= JUMP_MIN_SCROLL_PX)) return HIDDEN_JUMP_NAV
  const index = currentQuestionIndex(tops, box)
  return {
    visible: true,
    index,
    count: tops.length,
    canFirst: box.scrollTop > jumpScrollTop(tops[0]!),
    canPrev: index >= 2,
    canNext: index < tops.length,
    canLast: !isAtBottom(box)
  }
}

/** If nothing changed, the state is not replaced (during a response it is re-measured on every delta). */
export function sameJumpNav(a: JumpNavState, b: JumpNavState): boolean {
  return (
    a.visible === b.visible &&
    a.index === b.index &&
    a.count === b.count &&
    a.canFirst === b.canFirst &&
    a.canPrev === b.canPrev &&
    a.canNext === b.canNext &&
    a.canLast === b.canLast
  )
}

/** The vertical range of one question (a coordinate inside the container). `bottom` is the bottom edge of the message row (`ev-<id>`). */
export interface QuestionSpan {
  readonly top: number
  readonly bottom: number
}

/**
 * The question shown stuck to the top edge (TODO 355, wave 19 bundle A). A 0-based index, -1 if not shown.
 *
 * - **The question of the section that the row currently at the top edge of ThreadPane belongs to.** A section = from the top edge of that question to just before the
 *   top edge of the next question. The reference line is `scrollTop + GAP + 1`, same as `currentQuestionIndex`: the margin right after a jump (the next question was
 *   placed at the top edge with an 8px margin) is the tail of the previous section, but sticking the previous question there would hide the place we jumped to.
 *   Not shown if the reference line is above the first question (the margin at the start, "read more").
 * - **Not shown while the question itself is even slightly visible** (`bottom > scrollTop`), to avoid showing it twice.
 *   Right after a jump (`jumpScrollTop`, placed at the top edge with an 8px margin) it is not shown either, for this reason.
 * - Unlike `currentQuestionIndex`, it does not override with "the last question if at the bottom". That is for the box's numbering
 *   (the last question cannot rise to the top edge); what we want to know here is which section the top-edge row actually is in.
 *   While following a long answer pinned to the bottom (during a response), if the last question scrolls off the top, this returns the last question.
 */
export function stickyQuestionIndex(questions: readonly QuestionSpan[], box: ScrollMetrics): number {
  const line = box.scrollTop + JUMP_TOP_GAP_PX + 1
  let idx = -1
  for (let i = 0; i < questions.length; i++) {
    if (questions[i]!.top > line) break
    idx = i
  }
  if (idx < 0) return -1
  return questions[idx]!.bottom > box.scrollTop ? -1 : idx
}

/** The cap on characters handed to the sticky frame. The visual truncation (1-2 lines plus "…") is done by CSS line-clamp. */
export const STICKY_TEXT_MAX = 400

/**
 * The text of the sticky frame (TODO 355). Unlike the timeline frame (TODO 352), runs of newlines and whitespace are folded into one space.
 * A long question passes only its beginning (so the whole text is not put in the DOM). "…" is added at the end only when it was cut.
 */
export function stickyQuestionText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= STICKY_TEXT_MAX ? line : `${line.slice(0, STICKY_TEXT_MAX).trimEnd()}…`
}
