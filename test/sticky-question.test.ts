// @vitest-environment jsdom
/**
 * TODO 355 (wave 19 bundle A): pins the user's own question that a response answers to the top edge of ThreadPane.
 *
 * - `StickyQuestion` only draws `stickyId` from `useJumpNav` (folds it into one line; pressing it calls `jumpToQuestion`).
 * - `useJumpNav` measures the top and bottom edge of each question in the same `sync` and picks with `stickyQuestionIndex`. jsdom has no layout, so `getBoundingClientRect` is replaced with a fake that returns values from `data-top` / `data-height`.
 * - The placement (the sibling right before `.thread-body`) is checked against the source of ThreadPane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'
import { StickyQuestion } from '../src/renderer/src/components/StickyQuestion.js'
import { useJumpNav, type JumpNavHandle } from '../src/renderer/src/components/JumpNav.js'
import { HIDDEN_JUMP_NAV } from '../src/renderer/src/thread/jump.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const user = (id: string, text: string): TimelineItem => ({ kind: 'user', id, ts: 0, text })
const answer = (id: string, text: string): TimelineItem => ({ kind: 'assistant', id, ts: 0, text, actor: 'main' })

function fakeHandle(stickyId: string | null, jumpToQuestion = vi.fn()): JumpNavHandle {
  const noop = (): void => {}
  return {
    nav: HIDDEN_JUMP_NAV,
    flashId: null,
    stickyId,
    sync: noop,
    jumpFirst: noop,
    jumpPrev: noop,
    jumpNext: noop,
    jumpLast: noop,
    jumpToQuestion
  }
}

describe('StickyQuestion (TODO 355)', () => {
  const items = [user('q1', '1 行目\n2 行目\n\n  3 行目'), answer('a1', '長い回答'), user('q2', '次の質問')]

  it('draws nothing if stickyId is null', () => {
    act(() => root.render(createElement(StickyQuestion, { handle: fakeHandle(null), items })))
    expect(host.innerHTML).toBe('')
  })

  it('folds the question text into one line and shows only one (newlines become spaces)', () => {
    act(() => root.render(createElement(StickyQuestion, { handle: fakeHandle('q1'), items })))
    const buttons = host.querySelectorAll('.sticky-question')
    expect(buttons).toHaveLength(1)
    expect(host.querySelector('.sticky-question-text')?.textContent).toBe('1 行目 2 行目 3 行目')
  })

  it('pressing it jumps to that question', () => {
    const jump = vi.fn()
    act(() => root.render(createElement(StickyQuestion, { handle: fakeHandle('q2', jump), items })))
    act(() => host.querySelector<HTMLButtonElement>('.sticky-question')!.click())
    expect(jump).toHaveBeenCalledWith('q2')
  })

  it('draws nothing if the id is not a question (kind: user) or is not found', () => {
    act(() => root.render(createElement(StickyQuestion, { handle: fakeHandle('a1'), items })))
    expect(host.innerHTML).toBe('')
    act(() => root.render(createElement(StickyQuestion, { handle: fakeHandle('gone'), items })))
    expect(host.innerHTML).toBe('')
  })
})

/**
 * jsdom has no layout. The container standing in for `.thread-body` has its top edge at 0 (screen coordinates), and each row is treated as being at `data-top` (content coordinates) minus scrollTop when `getBoundingClientRect` is returned.
 */
function installFakeLayout(box: () => HTMLElement | null): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement
    const scroller = box()
    if (el === scroller) return { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    const top = Number(el.dataset['top'] ?? '0') - (scroller?.scrollTop ?? 0)
    const height = Number(el.dataset['height'] ?? '0')
    return { top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
}

describe("stickyId of useJumpNav (TODO 355, riding on JumpNav's sync)", () => {
  const items = [user('q1', '最初の質問'), answer('a1', '回答 1'), user('q2', '二つ目の質問'), answer('a2', '回答 2')]
  // Question q1 spans 12-72, q2 spans 1400-1460. The body is 3000px.
  const layout: Record<string, [number, number]> = { q1: [12, 60], a1: [80, 1300], q2: [1400, 60], a2: [1470, 1500] }

  let handle: JumpNavHandle | null = null
  let scroller: HTMLDivElement | null = null

  function Harness(): React.JSX.Element {
    const ref = useRef<HTMLDivElement | null>(null)
    handle = useJumpNav(ref, items, items, () => {})
    return createElement(
      'div',
      { className: 'thread-body', ref: (el: HTMLDivElement | null) => { ref.current = el; scroller = el } },
      items.map((item) =>
        createElement('div', {
          key: item.id,
          id: `ev-${item.id}`,
          'data-top': layout[item.id]![0],
          'data-height': layout[item.id]![1]
        })
      )
    )
  }

  function scrollTo(top: number): void {
    const el = scroller!
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 3000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 600 })
    el.scrollTop = top
    act(() => handle!.sync())
  }

  it('shows the question of the section the top row belongs to, and does not show it while that question is visible', () => {
    installFakeLayout(() => scroller)
    act(() => root.render(createElement(Harness)))
    scrollTo(0)
    expect(handle!.stickyId).toBeNull()
    scrollTo(500) // In the middle of response 1. q1 has scrolled up out of view.
    expect(handle!.stickyId).toBe('q1')
    scrollTo(1420) // q2 is visible.
    expect(handle!.stickyId).toBeNull()
    scrollTo(2000) // In the middle of response 2.
    expect(handle!.stickyId).toBe('q2')
  })

  it('jumpToQuestion places it at the top with margin and highlights the landing point (same as the jump box)', () => {
    installFakeLayout(() => scroller)
    act(() => root.render(createElement(Harness)))
    scrollTo(500)
    act(() => handle!.jumpToQuestion('q1'))
    expect(scroller!.scrollTop).toBe(4)
    expect(handle!.flashId).toBe('q1')
    expect(handle!.stickyId).toBeNull()
  })
})

describe('placement (TODO 355)', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/ThreadPane.tsx'), 'utf8')

  it('placed as the immediately preceding sibling of .thread-body (not mixed inside)', () => {
    const sticky = src.indexOf('<StickyQuestion handle={jump}')
    const body = src.indexOf('className="thread-body"')
    expect(sticky).toBeGreaterThan(0)
    expect(sticky).toBeLessThan(body)
    // No opening tag of another element between them (the immediately preceding sibling).
    const between = src.slice(sticky, body).replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(between.match(/<[A-Za-z]/g)).toEqual(['<S', '<d'])
  })

  it("CSS: overlaid with absolute on a zero-height container, and the width is the timeline's upper limit", () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`)
      expect(start, selector).toBeGreaterThanOrEqual(0)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(rule('.sticky-question-host')).toContain('height: 0')
    const box = rule('.sticky-question')
    expect(box).toContain('position: absolute')
    expect(box).toContain('max-width: var(--timeline-max-width)')
    expect(box).not.toMatch(/margin:\s*0 auto/)
    expect(rule('.sticky-question-text')).toContain('-webkit-line-clamp: 2')
  })
})
