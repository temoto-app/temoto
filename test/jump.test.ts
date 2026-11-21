/**
 * Judgment for jumping between "my questions" (ARCHITECTURE.md 5.1.4, TODO 53, compatible with qlm).
 *
 * A pure function with no DOM (`thread/jump.ts`), run over the array of each question's top edge and the scroll dimensions.
 * The least obvious point: "if you are at the bottom, the last question unconditionally". Without blank space below the body,
 * the last question cannot rise to the top, and a top-edge-only rule stops at N-1 / N (checked on the real qlm).
 */
import { describe, expect, it } from 'vitest'
import {
  HIDDEN_JUMP_NAV,
  JUMP_MIN_SCROLL_PX,
  JUMP_TOP_GAP_PX,
  STICK_BOTTOM_SLACK_PX,
  currentQuestionIndex,
  isAtBottom,
  jumpNavState,
  jumpScrollTop,
  sameJumpNav,
  STICKY_TEXT_MAX,
  stickyQuestionIndex,
  stickyQuestionText,
  type QuestionSpan,
  type ScrollMetrics
} from '@renderer/thread/jump.js'

/** The body is 3000px tall and viewed in a 600px window. There are five questions. */
const TOPS = [12, 700, 1400, 2100, 2800]
function box(scrollTop: number, over: Partial<ScrollMetrics> = {}): ScrollMetrics {
  return { scrollTop, clientHeight: 600, scrollHeight: 3000, ...over }
}

describe('currentQuestionIndex: which question we are at now', () => {
  it('0 if there are no questions', () => {
    expect(currentQuestionIndex([], box(0))).toBe(0)
  })

  it('the top margin (not yet reaching any question) counts as the first question', () => {
    expect(currentQuestionIndex([300, 900], box(0))).toBe(1)
  })

  it('the last question that starts above the baseline', () => {
    expect(currentQuestionIndex(TOPS, box(0))).toBe(1)
    expect(currentQuestionIndex(TOPS, box(690))).toBe(1)
    expect(currentQuestionIndex(TOPS, box(692))).toBe(2)
    expect(currentQuestionIndex(TOPS, box(1000))).toBe(2)
    expect(currentQuestionIndex(TOPS, box(1500))).toBe(3)
  })

  it('right after placing at the top (scrollTop = top - GAP) counts as being at that question (1px tolerance)', () => {
    expect(currentQuestionIndex(TOPS, box(jumpScrollTop(1400)))).toBe(3)
    // At 2px before the point the margin allows, it is still the previous question.
    expect(currentQuestionIndex(TOPS, box(1400 - JUMP_TOP_GAP_PX - 2))).toBe(2)
  })

  it('at the bottom, it is the last number even if the last question cannot rise to the top', () => {
    // The scrollTop limit is 2400. The last question (2800) cannot reach the top edge.
    expect(currentQuestionIndex(TOPS, box(2400))).toBe(5)
    // Inside the slack, the same holds.
    expect(currentQuestionIndex(TOPS, box(2400 - STICK_BOTTOM_SLACK_PX + 1))).toBe(5)
    // Outside the slack, it falls back to the top-edge rule (2100 is at the top edge → question 4).
    expect(currentQuestionIndex(TOPS, box(2400 - STICK_BOTTOM_SLACK_PX))).toBe(4)
  })
})

describe('isAtBottom / jumpScrollTop', () => {
  it("the bottom tolerance is the same as ThreadPane's pinned (< 80px)", () => {
    expect(STICK_BOTTOM_SLACK_PX).toBe(80)
    expect(isAtBottom(box(2400))).toBe(true)
    expect(isAtBottom(box(2321))).toBe(true)
    expect(isAtBottom(box(2320))).toBe(false)
  })

  it('when dimensions cannot be taken (NaN) it counts as the bottom', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: Number.NaN, scrollHeight: 0 })).toBe(true)
  })

  it('the jump target is the margin above, but never below 0', () => {
    expect(jumpScrollTop(100)).toBe(100 - JUMP_TOP_GAP_PX)
    expect(jumpScrollTop(3)).toBe(0)
  })
})

describe('jumpNavState: showing / hiding the box and the 4 enabled states', () => {
  it('not shown for a conversation with no questions or that needs no scrolling', () => {
    expect(jumpNavState([], box(0))).toBe(HIDDEN_JUMP_NAV)
    expect(jumpNavState([12], box(0, { scrollHeight: 600 + JUMP_MIN_SCROLL_PX - 1 }))).toBe(HIDDEN_JUMP_NAV)
    expect(jumpNavState([12], box(0, { scrollHeight: 600 + JUMP_MIN_SCROLL_PX })).visible).toBe(true)
  })

  it('at the top: first / previous cannot be pressed, and next / last can', () => {
    expect(jumpNavState(TOPS, box(0))).toEqual({
      visible: true,
      index: 1,
      count: 5,
      canFirst: false,
      canPrev: false,
      canNext: true,
      canLast: true
    })
  })

  it('「最初へ」 can be pressed only when below the position where the first question is placed at the top (not by the margin alone)', () => {
    expect(jumpNavState(TOPS, box(jumpScrollTop(12))).canFirst).toBe(false)
    expect(jumpNavState(TOPS, box(jumpScrollTop(12) + 1)).canFirst).toBe(true)
  })

  it('in the middle: all four can be pressed', () => {
    const nav = jumpNavState(TOPS, box(1500))
    expect(nav.index).toBe(3)
    expect([nav.canFirst, nav.canPrev, nav.canNext, nav.canLast]).toEqual([true, true, true, true])
  })

  it('at the bottom: next / last cannot be pressed', () => {
    const nav = jumpNavState(TOPS, box(2400))
    expect(nav.index).toBe(5)
    expect([nav.canFirst, nav.canPrev, nav.canNext, nav.canLast]).toEqual([true, true, false, false])
  })

  it('with only one question, previous / next can never be pressed', () => {
    expect(jumpNavState([12], box(500)).canPrev).toBe(false)
    expect(jumpNavState([12], box(500)).canNext).toBe(false)
  })
})

describe('sameJumpNav: does not replace the state if unchanged', () => {
  it('the same content is the same, and differing by even one item is different', () => {
    const a = jumpNavState(TOPS, box(1500))
    expect(sameJumpNav(a, jumpNavState(TOPS, box(1501)))).toBe(true)
    expect(sameJumpNav(a, jumpNavState(TOPS, box(2400)))).toBe(false)
    expect(sameJumpNav(HIDDEN_JUMP_NAV, a)).toBe(false)
  })
})

describe('stickyQuestionIndex: top row to the question of its section (TODO 355)', () => {
  /** Each question in TOPS is 60px tall (the box for a one- or two-line message). */
  const SPANS: readonly QuestionSpan[] = TOPS.map((top) => ({ top, bottom: top + 60 }))

  it('not shown if there are no questions', () => {
    expect(stickyQuestionIndex([], box(500))).toBe(-1)
  })

  it('not shown if the top is above the first question (the top margin)', () => {
    expect(stickyQuestionIndex([{ top: 300, bottom: 360 }], box(0))).toBe(-1)
    expect(stickyQuestionIndex([{ top: 300, bottom: 360 }], box(300 - JUMP_TOP_GAP_PX - 2))).toBe(-1)
  })

  it('not shown while that question is even slightly visible (not shown twice)', () => {
    expect(stickyQuestionIndex(SPANS, box(0))).toBe(-1)
    // Mid-way through question 2 (700-760) is at the top edge → still visible.
    expect(stickyQuestionIndex(SPANS, box(759))).toBe(-1)
    // Right after a jump (placed at the top edge with the margin) it is still visible.
    expect(stickyQuestionIndex(SPANS, box(jumpScrollTop(700)))).toBe(-1)
  })

  it('once the question scrolls off upward, the question of the section the top row belongs to', () => {
    expect(stickyQuestionIndex(SPANS, box(72))).toBe(0)
    expect(stickyQuestionIndex(SPANS, box(690))).toBe(0)
    expect(stickyQuestionIndex(SPANS, box(760))).toBe(1)
    expect(stickyQuestionIndex(SPANS, box(1390))).toBe(1)
    expect(stickyQuestionIndex(SPANS, box(1500))).toBe(2)
  })

  it("switches when entering the next question's section (it disappears for a moment while that question is visible)", () => {
    expect(stickyQuestionIndex(SPANS, box(1390))).toBe(1)
    // From the position where the next question is placed at the top edge with the margin (= right after the jump), do not show it while that question is visible.
    expect(stickyQuestionIndex(SPANS, box(jumpScrollTop(1400)))).toBe(-1)
    expect(stickyQuestionIndex(SPANS, box(1459))).toBe(-1)
    expect(stickyQuestionIndex(SPANS, box(1460))).toBe(2)
  })

  it('not overridden at the bottom either: if the last question cannot rise to the top, the section of the top row (the previous question)', () => {
    // scrollTop limit 2400. The top-edge line is in the span of question 4 (from 2100), and question 4 has scrolled out.
    expect(stickyQuestionIndex(SPANS, box(2400))).toBe(3)
    // The box's number at the bottom is the last one (question 5); the two judgments are different.
    expect(currentQuestionIndex(TOPS, box(2400))).toBe(5)
  })

  it('while following a long answer at the bottom, when the last question scrolls out, the last question', () => {
    const spans: readonly QuestionSpan[] = [
      { top: 12, bottom: 72 },
      { top: 400, bottom: 460 }
    ]
    expect(stickyQuestionIndex(spans, { scrollTop: 2400, clientHeight: 600, scrollHeight: 3000 })).toBe(1)
  })

  it('a question taller than the screen is not shown until its bottom edge passes above', () => {
    const spans: readonly QuestionSpan[] = [{ top: 12, bottom: 1012 }]
    expect(stickyQuestionIndex(spans, box(900))).toBe(-1)
    expect(stickyQuestionIndex(spans, box(1012))).toBe(0)
  })
})

describe('stickyQuestionText: folded into one line in the sticky frame (TODO 355 / 352)', () => {
  it('runs of newlines and whitespace become one space, and the ends are trimmed', () => {
    expect(stickyQuestionText('  1 行目\n\n2 行目\t\tおわり \n')).toBe('1 行目 2 行目 おわり')
  })

  it('past the limit, passes only the head followed by 「…」', () => {
    const long = 'あ'.repeat(STICKY_TEXT_MAX + 50)
    const out = stickyQuestionText(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(STICKY_TEXT_MAX + 1)
    expect(stickyQuestionText('短い')).toBe('短い')
  })
})
