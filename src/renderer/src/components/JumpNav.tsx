/**
 * The jump box between "my questions" (ARCHITECTURE.md 5.1.4, TODO 53; qlm compatible).
 *
 * - **It is not placed inside `.thread-body`.** The children of that container are looked up by `ev-${id}`
 *   (the jump of in-conversation search, `highlightEventId`). Mixing in would break those assumptions, so it is inserted
 *   right after `.thread-body` as a **zero-height sibling** (`.jump-nav`), and the box inside is placed
 *   at the bottom right with absolute. Even if the approval frame or Composer below grows, the box stays right above it.
 * - The decision is the pure function in `thread/jump.ts`. This only reads dimensions from the DOM and passes them.
 * - Re-measuring rides on ThreadPane's `onScroll`, timeline changes (every delta
 *   during a response), and size changes of `.thread-body` (ResizeObserver, pane split). If nothing
 *   changed, the state is not replaced.
 * - **The sticky pinning at the top (TODO 355, `StickyQuestion.tsx`) also rides on the same measurement.** The same `sync`
 *   measures each question's top and bottom, and `stickyQuestionIndex` gives "the question of the section the top row belongs to".
 *   No additional scroll listener. The landing when pressed is the same `jumpTo` (top with a margin, `highlighted`).
 * - The landing point gets `highlighted` (the same look as the in-conversation search jump) for only 1.6 seconds.
 *   `highlightEventId` is not used: it comes with `scrollIntoView({ block: 'center' })` and
 *   suppression of auto-scroll, which gets in the way here where we want the top with a margin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { TimelineItem } from '../thread/timeline.js'
import {
  HIDDEN_JUMP_NAV,
  isAtBottom,
  jumpNavState,
  jumpScrollTop,
  sameJumpNav,
  stickyQuestionIndex,
  type JumpNavState
} from '../thread/jump.js'
import { JumpFirstIcon } from '../icons/JumpFirstIcon.js'
import { JumpPrevIcon } from '../icons/JumpPrevIcon.js'
import { JumpNextIcon } from '../icons/JumpNextIcon.js'
import { JumpLastIcon } from '../icons/JumpLastIcon.js'
import { useT } from '../i18n/index.js'

/** How long it stays lit (ms). The same as qlm's `flashNode`. */
const FLASH_MS = 1600

export interface JumpNavHandle {
  readonly nav: JumpNavState
  /** The id of the message currently lit (the landing point). ThreadPane applies `highlighted`. */
  readonly flashId: string | null
  /** The id of the question shown pinned to the top (TODO 355). null if none is shown. */
  readonly stickyId: string | null
  /** Re-measures. Called from ThreadPane's `onScroll`. */
  readonly sync: () => void
  readonly jumpFirst: () => void
  readonly jumpPrev: () => void
  readonly jumpNext: () => void
  readonly jumpLast: () => void
  /** Jumps to that question (when the pinned frame is pressed, TODO 355). The landing is the same as the jump box. */
  readonly jumpToQuestion: (id: string) => void
}

/**
 * Measures each question's top in **coordinates inside the container** (= the equivalent of `offsetTop` when the container is
 * `position: relative`). `offsetTop` itself depends on the offsetParent and would force
 * other rules to follow a CSS change that makes `.thread-body` positioned, so
 * we compute it from the difference of getBoundingClientRect.
 */
interface QuestionPos {
  readonly id: string
  readonly top: number
  /** The bottom of a message row (`ev-<id>`). Used only by the pinning decision (TODO 355). */
  readonly bottom: number
}

function questionTops(box: HTMLElement, ids: readonly string[]): QuestionPos[] {
  const base = box.getBoundingClientRect().top - box.scrollTop
  const out: QuestionPos[] = []
  for (const id of ids) {
    const el = document.getElementById(`ev-${id}`)
    if (el === null) continue
    const rect = el.getBoundingClientRect()
    out.push({ id, top: rect.top - base, bottom: rect.bottom - base })
  }
  return out
}

export function useJumpNav(
  scrollRef: RefObject<HTMLDivElement | null>,
  items: readonly TimelineItem[],
  /** A value that triggers re-measuring whenever it changes (such as the body during a response. The contents are not inspected). */
  version: unknown,
  /** Right after scrollTop was moved by us, returns the result of re-measuring the stick-to-bottom decision. */
  onJumped: (atBottom: boolean) => void,
  /** TODO 1137: the element to observe. It appears later (mounted in an empty pane -> a thread is chosen), so re-attach when it appears. */
  observed?: HTMLElement | null
): JumpNavHandle {
  const [nav, setNav] = useState<JumpNavState>(HIDDEN_JUMP_NAV)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [stickyId, setStickyId] = useState<string | null>(null)
  const questionIds = useMemo(
    () => items.filter((item) => item.kind === 'user').map((item) => item.id),
    [items]
  )
  // A ref for reading the latest question list at the moment of pressing, without a re-render in between.
  const idsRef = useRef(questionIds)
  idsRef.current = questionIds

  const sync = useCallback(() => {
    const box = scrollRef.current
    const qs = box === null ? [] : questionTops(box, idsRef.current)
    const next = box === null ? HIDDEN_JUMP_NAV : jumpNavState(qs.map((q) => q.top), box)
    setNav((prev) => (sameJumpNav(prev, next) ? prev : next))
    // Pinning (TODO 355). If the value is the same, React does not redraw (a string / null comparison).
    const sticky = box === null ? -1 : stickyQuestionIndex(qs, box)
    setStickyId(sticky < 0 ? null : qs[sticky]!.id)
  }, [scrollRef])

  // Re-measure when the timeline changes (confirmation, delta, collapsing).
  useEffect(() => {
    sync()
  }, [sync, questionIds, version])

  // Re-measure when the container's size changes (pane split, window resize).
  useEffect(() => {
    const box = observed ?? scrollRef.current
    if (box === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => sync())
    observer.observe(box)
    return () => observer.disconnect()
  }, [scrollRef, sync, observed])

  // Light up only one place at a time. The next jump clears the previous one.
  useEffect(() => {
    if (flashId === null) return
    const timer = setTimeout(() => setFlashId(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashId])

  /**
   * Moves that question to the top. The scroll event does not arrive until the next frame, so we **re-measure** the stick-to-bottom decision
   * here and return it: if the response's increments arrived with the stale decision (true), we would be
   * pulled back to the bottom right after jumping (a form actually hit in qlm).
   */
  const jumpTo = useCallback(
    (which: (qs: QuestionPos[], index: number) => QuestionPos | undefined) => {
      const box = scrollRef.current
      if (box === null) return
      const qs = questionTops(box, idsRef.current)
      if (qs.length === 0) return
      const target = which(qs, jumpNavState(qs.map((q) => q.top), box).index)
      if (target === undefined) return
      box.scrollTop = jumpScrollTop(target.top)
      onJumped(isAtBottom(box))
      setFlashId(target.id)
      sync()
    },
    [scrollRef, onJumped, sync]
  )

  const jumpFirst = useCallback(() => jumpTo((qs) => qs[0]), [jumpTo])
  const jumpPrev = useCallback(() => jumpTo((qs, index) => (index >= 2 ? qs[index - 2] : undefined)), [jumpTo])
  const jumpNext = useCallback(
    () => jumpTo((qs, index) => (index >= 1 && index < qs.length ? qs[index] : undefined)),
    [jumpTo]
  )
  /** To the end. Re-sticks (= follows later increments again). There is no message to light up. */
  const jumpLast = useCallback(() => {
    const box = scrollRef.current
    if (box === null) return
    box.scrollTop = box.scrollHeight
    onJumped(true)
    sync()
  }, [scrollRef, onJumped, sync])

  const jumpToQuestion = useCallback((id: string) => jumpTo((qs) => qs.find((q) => q.id === id)), [jumpTo])

  return { nav, flashId, stickyId, sync, jumpFirst, jumpPrev, jumpNext, jumpLast, jumpToQuestion }
}

export function JumpNav({ handle }: { handle: JumpNavHandle }): React.JSX.Element | null {
  const { nav } = handle
  const t = useT()
  if (!nav.visible) return null
  return (
    <div className="jump-nav">
      <div className="jump-box">
        {/* Which question this is (e.g. `3 / 12`). The denominator is the number of questions. */}
        <span className="jump-pos">
          {nav.index} / {nav.count}
        </span>
        <button
          type="button"
          className="jump-btn"
          aria-label={t('jumpNav.first')}
          title={t('jumpNav.first')}
          disabled={!nav.canFirst}
          onClick={handle.jumpFirst}
        >
          <JumpFirstIcon />
        </button>
        <button
          type="button"
          className="jump-btn"
          aria-label={t('jumpNav.prev')}
          title={t('jumpNav.prev')}
          disabled={!nav.canPrev}
          onClick={handle.jumpPrev}
        >
          <JumpPrevIcon />
        </button>
        <button
          type="button"
          className="jump-btn"
          aria-label={t('jumpNav.next')}
          title={t('jumpNav.next')}
          disabled={!nav.canNext}
          onClick={handle.jumpNext}
        >
          <JumpNextIcon />
        </button>
        <button
          type="button"
          className="jump-btn"
          aria-label={t('jumpNav.last')}
          title={t('jumpNav.last')}
          disabled={!nav.canLast}
          onClick={handle.jumpLast}
        >
          <JumpLastIcon />
        </button>
      </div>
    </div>
  )
}
