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

describe('currentQuestionIndex — いま何問目か', () => {
  it('質問が無ければ 0', () => {
    expect(currentQuestionIndex([], box(0))).toBe(0)
  })

  it('冒頭の余白 (どの質問にも達していない) は 1 問目扱い', () => {
    expect(currentQuestionIndex([300, 900], box(0))).toBe(1)
  })

  it('基準線より上で始まる最後の質問', () => {
    expect(currentQuestionIndex(TOPS, box(0))).toBe(1)
    expect(currentQuestionIndex(TOPS, box(690))).toBe(1)
    expect(currentQuestionIndex(TOPS, box(692))).toBe(2)
    expect(currentQuestionIndex(TOPS, box(1000))).toBe(2)
    expect(currentQuestionIndex(TOPS, box(1500))).toBe(3)
  })

  it('上端に置いた直後 (scrollTop = top - GAP) はその質問に居ると数える (1px の緩み)', () => {
    expect(currentQuestionIndex(TOPS, box(jumpScrollTop(1400)))).toBe(3)
    // At 2px before the point the margin allows, it is still the previous question.
    expect(currentQuestionIndex(TOPS, box(1400 - JUMP_TOP_GAP_PX - 2))).toBe(2)
  })

  it('下端に居るなら、最後の質問が上端まで上がれなくても最後の番号', () => {
    // The scrollTop limit is 2400. The last question (2800) cannot reach the top edge.
    expect(currentQuestionIndex(TOPS, box(2400))).toBe(5)
    // Inside the slack, the same holds.
    expect(currentQuestionIndex(TOPS, box(2400 - STICK_BOTTOM_SLACK_PX + 1))).toBe(5)
    // Outside the slack, it falls back to the top-edge rule (2100 is at the top edge → question 4).
    expect(currentQuestionIndex(TOPS, box(2400 - STICK_BOTTOM_SLACK_PX))).toBe(4)
  })
})

describe('isAtBottom / jumpScrollTop', () => {
  it('下端の緩みは ThreadPane の pinned (< 80px) と同じ', () => {
    expect(STICK_BOTTOM_SLACK_PX).toBe(80)
    expect(isAtBottom(box(2400))).toBe(true)
    expect(isAtBottom(box(2321))).toBe(true)
    expect(isAtBottom(box(2320))).toBe(false)
  })

  it('寸法が取れない (NaN) ときは下端扱い', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: Number.NaN, scrollHeight: 0 })).toBe(true)
  })

  it('飛び先は余白ぶん上、ただし 0 未満にはしない', () => {
    expect(jumpScrollTop(100)).toBe(100 - JUMP_TOP_GAP_PX)
    expect(jumpScrollTop(3)).toBe(0)
  })
})

describe('jumpNavState — 箱の出し入れと 4 つの可否', () => {
  it('質問が無い / スクロールが要らない会話では出さない', () => {
    expect(jumpNavState([], box(0))).toBe(HIDDEN_JUMP_NAV)
    expect(jumpNavState([12], box(0, { scrollHeight: 600 + JUMP_MIN_SCROLL_PX - 1 }))).toBe(HIDDEN_JUMP_NAV)
    expect(jumpNavState([12], box(0, { scrollHeight: 600 + JUMP_MIN_SCROLL_PX })).visible).toBe(true)
  })

  it('冒頭: 最初へ / 前へ は押せず、次へ / 最後へ は押せる', () => {
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

  it('「最初へ」は最初の質問を上端に置いた位置より下に居るときだけ (余白ぶんでは押せない)', () => {
    expect(jumpNavState(TOPS, box(jumpScrollTop(12))).canFirst).toBe(false)
    expect(jumpNavState(TOPS, box(jumpScrollTop(12) + 1)).canFirst).toBe(true)
  })

  it('途中: 4 つとも押せる', () => {
    const nav = jumpNavState(TOPS, box(1500))
    expect(nav.index).toBe(3)
    expect([nav.canFirst, nav.canPrev, nav.canNext, nav.canLast]).toEqual([true, true, true, true])
  })

  it('下端: 次へ / 最後へ は押せない', () => {
    const nav = jumpNavState(TOPS, box(2400))
    expect(nav.index).toBe(5)
    expect([nav.canFirst, nav.canPrev, nav.canNext, nav.canLast]).toEqual([true, true, false, false])
  })

  it('質問が 1 つだけなら 前へ / 次へ は常に押せない', () => {
    expect(jumpNavState([12], box(500)).canPrev).toBe(false)
    expect(jumpNavState([12], box(500)).canNext).toBe(false)
  })
})

describe('sameJumpNav — 変わっていなければ state を差し替えない', () => {
  it('同じ中身は同じ、1 項目でも違えば違う', () => {
    const a = jumpNavState(TOPS, box(1500))
    expect(sameJumpNav(a, jumpNavState(TOPS, box(1501)))).toBe(true)
    expect(sameJumpNav(a, jumpNavState(TOPS, box(2400)))).toBe(false)
    expect(sameJumpNav(HIDDEN_JUMP_NAV, a)).toBe(false)
  })
})

describe('stickyQuestionIndex — 上端の行 → 区間の質問 (TODO 355)', () => {
  /** Each question in TOPS is 60px tall (the box for a one- or two-line message). */
  const SPANS: readonly QuestionSpan[] = TOPS.map((top) => ({ top, bottom: top + 60 }))

  it('質問が無ければ出さない', () => {
    expect(stickyQuestionIndex([], box(500))).toBe(-1)
  })

  it('上端が最初の質問より上 (冒頭の余白) なら出さない', () => {
    expect(stickyQuestionIndex([{ top: 300, bottom: 360 }], box(0))).toBe(-1)
    expect(stickyQuestionIndex([{ top: 300, bottom: 360 }], box(300 - JUMP_TOP_GAP_PX - 2))).toBe(-1)
  })

  it('その質問が少しでも見えている間は出さない (二重に見せない)', () => {
    expect(stickyQuestionIndex(SPANS, box(0))).toBe(-1)
    // Mid-way through question 2 (700-760) is at the top edge → still visible.
    expect(stickyQuestionIndex(SPANS, box(759))).toBe(-1)
    // Right after a jump (placed at the top edge with the margin) it is still visible.
    expect(stickyQuestionIndex(SPANS, box(jumpScrollTop(700)))).toBe(-1)
  })

  it('質問が上へ流れ出たら、上端の行が属する区間の質問', () => {
    expect(stickyQuestionIndex(SPANS, box(72))).toBe(0)
    expect(stickyQuestionIndex(SPANS, box(690))).toBe(0)
    expect(stickyQuestionIndex(SPANS, box(760))).toBe(1)
    expect(stickyQuestionIndex(SPANS, box(1390))).toBe(1)
    expect(stickyQuestionIndex(SPANS, box(1500))).toBe(2)
  })

  it('次の質問の区間に入ったら替わる (その質問が見えている間は一旦消える)', () => {
    expect(stickyQuestionIndex(SPANS, box(1390))).toBe(1)
    // From the position where the next question is placed at the top edge with the margin (= right after the jump), do not show it while that question is visible.
    expect(stickyQuestionIndex(SPANS, box(jumpScrollTop(1400)))).toBe(-1)
    expect(stickyQuestionIndex(SPANS, box(1459))).toBe(-1)
    expect(stickyQuestionIndex(SPANS, box(1460))).toBe(2)
  })

  it('下端でも上書きしない: 最後の質問が上端まで上がれなければ、上端の行の区間 (前の質問)', () => {
    // scrollTop limit 2400. The top-edge line is in the span of question 4 (from 2100), and question 4 has scrolled out.
    expect(stickyQuestionIndex(SPANS, box(2400))).toBe(3)
    // The box's number at the bottom is the last one (question 5); the two judgments are different.
    expect(currentQuestionIndex(TOPS, box(2400))).toBe(5)
  })

  it('長い回答を下端で追っている間に最後の質問が流れ出たら、最後の質問', () => {
    const spans: readonly QuestionSpan[] = [
      { top: 12, bottom: 72 },
      { top: 400, bottom: 460 }
    ]
    expect(stickyQuestionIndex(spans, { scrollTop: 2400, clientHeight: 600, scrollHeight: 3000 })).toBe(1)
  })

  it('画面より背の高い質問は、下端が上へ抜けるまで出さない', () => {
    const spans: readonly QuestionSpan[] = [{ top: 12, bottom: 1012 }]
    expect(stickyQuestionIndex(spans, box(900))).toBe(-1)
    expect(stickyQuestionIndex(spans, box(1012))).toBe(0)
  })
})

describe('stickyQuestionText — 貼り付けの枠では 1 行に畳む (TODO 355 / 352)', () => {
  it('改行と空白の連続は 1 つの空白、前後は落とす', () => {
    expect(stickyQuestionText('  1 行目\n\n2 行目\t\tおわり \n')).toBe('1 行目 2 行目 おわり')
  })

  it('上限を超えたら先頭だけ渡して「…」', () => {
    const long = 'あ'.repeat(STICKY_TEXT_MAX + 50)
    const out = stickyQuestionText(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(STICKY_TEXT_MAX + 1)
    expect(stickyQuestionText('短い')).toBe('短い')
  })
})
