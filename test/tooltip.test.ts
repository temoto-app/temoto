// @vitest-environment jsdom
/**
 * Item 290 / 286 (wave 16 bundle A): renders the shared tooltip (`components/Tooltip.tsx`) and the display of tool arguments (`ToolInput`) in jsdom. Hover delay, Esc and click to dismiss, appears on keyboard focus, `aria-describedby`, not shown with `when`, and placement (the direction flips at the edge of the window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip, TOOLTIP_DELAY_MS, placeTooltip } from '../src/renderer/src/components/Tooltip.js'
import { ToolInput } from '../src/renderer/src/components/ToolInput.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function renderTip(props: Partial<Parameters<typeof Tooltip>[0]> = {}): HTMLButtonElement {
  act(() =>
    root.render(
      createElement(
        Tooltip,
        { content: 'hello tip', ...props, children: createElement<React.ButtonHTMLAttributes<HTMLElement>>('button', { type: 'button' }, 'anchor') }
      )
    )
  )
  return host.querySelector('button')!
}

const tip = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="tooltip"]')

function hover(el: Element): void {
  // React's onMouseEnter is synthesized from mouseover / mouseout.
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
  })
}

function leave(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
}

describe('Tooltip (item 290 / 286)', () => {
  it('appears after hovering and waiting a bit, aria-describedby points at the bubble id, and it disappears on leaving', () => {
    const button = renderTip()
    hover(button)
    expect(tip()).toBeNull()
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 50))
    expect(tip()).toBeNull()
    act(() => vi.advanceTimersByTime(60))
    const el = tip()
    expect(el?.textContent).toBe('hello tip')
    expect(button.getAttribute('aria-describedby')).toBe(el?.id)
    // It is portaled into body (so it is not cut by a frame with `overflow: hidden`).
    expect(el?.parentElement).toBe(document.body)
    leave(button)
    act(() => vi.advanceTimersByTime(200))
    expect(tip()).toBeNull()
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  it('does not appear if left before the wait', () => {
    const button = renderTip()
    hover(button)
    act(() => vi.advanceTimersByTime(100))
    leave(button)
    act(() => vi.advanceTimersByTime(1000))
    expect(tip()).toBeNull()
  })

  it('disappears with Esc', () => {
    const button = renderTip()
    hover(button)
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    expect(tip()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(tip()).toBeNull()
  })

  it('disappears on press, and is not shown again by focus from a click', () => {
    const button = renderTip()
    hover(button)
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      button.focus()
    })
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    expect(tip()).toBeNull()
  })

  it('appears on keyboard focus and disappears on blur', () => {
    const button = renderTip()
    act(() => button.focus())
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    expect(tip()).not.toBeNull()
    act(() => button.blur())
    expect(tip()).toBeNull()
  })

  it('not shown when when is false, and a function content is called only when shown', () => {
    const content = vi.fn(() => 'lazy')
    const button = renderTip({ content, when: () => false })
    hover(button)
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    expect(tip()).toBeNull()
    expect(content).not.toHaveBeenCalled()
  })

  it('does not disappear when moving into the bubble (long content can be scrolled)', () => {
    const button = renderTip()
    hover(button)
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10))
    leave(button)
    hover(tip()!)
    act(() => vi.advanceTimersByTime(500))
    expect(tip()).not.toBeNull()
  })
})

describe('placeTooltip (changes direction at the window edge)', () => {
  const viewport = { width: 800, height: 600 }
  const size = { width: 200, height: 100 }
  it("right: right if it fits on the right, and vertically aligned to the anchor's center (activity bar, item 320)", () => {
    expect(
      placeTooltip({ top: 100, bottom: 124, left: 10, right: 34 }, size, viewport, 'right')
    ).toEqual({ top: 62, left: 40, side: 'right' })
  })
  it('right: to the left if it does not fit on the right', () => {
    expect(
      placeTooltip({ top: 100, bottom: 124, left: 700, right: 724 }, size, viewport, 'right')
    ).toMatchObject({ side: 'left', left: 494 })
  })
  it('right: vertically kept inside the window', () => {
    expect(
      placeTooltip({ top: -40, bottom: -16, left: 10, right: 34 }, { width: 200, height: 500 }, viewport, 'right')
    ).toMatchObject({ top: 8 })
  })
  it('the default is below, and above if it does not fit below', () => {
    expect(placeTooltip({ top: 100, bottom: 120, left: 50 }, size, viewport, 'bottom')).toEqual({
      top: 126,
      left: 50,
      side: 'bottom'
    })
    expect(placeTooltip({ top: 560, bottom: 580, left: 50 }, size, viewport, 'bottom')).toMatchObject({
      top: 454,
      side: 'top'
    })
  })
  it('even when above is preferred, below if it does not fit above', () => {
    expect(placeTooltip({ top: 20, bottom: 40, left: 50 }, size, viewport, 'top').side).toBe('bottom')
    expect(placeTooltip({ top: 500, bottom: 520, left: 50 }, size, viewport, 'top').side).toBe('top')
  })
  it('left and right are pulled inside the window', () => {
    expect(placeTooltip({ top: 100, bottom: 120, left: 750 }, size, viewport, 'bottom').left).toBe(592)
    expect(placeTooltip({ top: 100, bottom: 120, left: -30 }, size, viewport, 'bottom').left).toBe(8)
  })
})

describe('ToolInput (item 286)', () => {
  it('command is code + a copy button, description below, and the rest as JSON', () => {
    act(() =>
      root.render(
        createElement(ToolInput, {
          input: { command: 'grep -v "a\\|b" x', description: 'Filter', timeout: 5 },
          className: 'tool-input'
        })
      )
    )
    expect(host.querySelector('.tool-command-code')?.textContent).toBe('grep -v "a\\|b" x')
    expect(host.querySelector('.tool-command .code-copy')).not.toBeNull()
    expect(host.querySelector('.tool-command-description')?.textContent).toBe('Filter')
    expect(JSON.parse(host.querySelector('.tool-input-rest')?.textContent ?? 'null')).toEqual({ timeout: 5 })
  })

  it('input not in the table stays a JSON pre as before', () => {
    act(() => root.render(createElement(ToolInput, { input: { foo: 'bar' }, className: 'approval-input' })))
    const pre = host.querySelector('pre.approval-input')
    expect(pre?.textContent).toBe(JSON.stringify({ foo: 'bar' }, null, 2))
  })
})
