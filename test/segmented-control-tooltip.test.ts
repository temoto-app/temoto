// @vitest-environment jsdom
/**
 * TODO 354 (wave 19 bundle B): the choices with `icon` in `SegmentedControl` (sorting of the thread list,
 * item 152) still had the OS `title`, which was a missed move to the common speech bubble for icon-only buttons (`Tooltip`,
 * item 320). Choices with an icon do not write `title` and are wrapped in `Tooltip`; text choices (Model / Thinking in Composer) keep the OS `title` (the line drawn in item 320).
 *
 * Since it does not have the `icon-button` / `activity-item` / `menu-button` classes, it is not covered by the mechanical check in `test/icon-button-tooltip.test.ts`
 * (only individual buttons such as `.icon-button.thread-new` have a class, and the `<button role="radio">` of `SegmentedControl` has no class at all). So here there is a component-level regression check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SegmentedControl, type SegmentedOption } from '../src/renderer/src/components/SegmentedControl.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SegmentedControl options with icons use a Tooltip, not title (item 354)', () => {
  it('an option with an icon has no title and only an aria-label', async () => {
    const options: SegmentedOption<'recent' | 'unread'>[] = [
      { value: 'recent', label: '最近の順', icon: createElement('span', null, '🕐') },
      { value: 'unread', label: '未読を先に', icon: createElement('span', null, '●') }
    ]
    await act(async () => {
      root.render(
        createElement(SegmentedControl, { label: '並べ替え', options, value: 'recent', onChange: () => {} })
      )
    })
    const buttons = Array.from(host.querySelectorAll('button'))
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.hasAttribute('title')).toBe(false)
    }
    expect(buttons[0]!.getAttribute('aria-label')).toBe('最近の順')
    expect(buttons[1]!.getAttribute('aria-label')).toBe('未読を先に')
  })

  it('a text-only option (no icon) can still have a title as before', async () => {
    const options: SegmentedOption<'a' | 'b'>[] = [
      { value: 'a', label: 'A', title: 'モデル: A' },
      { value: 'b', label: 'B' }
    ]
    await act(async () => {
      root.render(createElement(SegmentedControl, { label: 'モデル', options, value: 'a', onChange: () => {} }))
    })
    const buttons = Array.from(host.querySelectorAll('button'))
    expect(buttons[0]!.getAttribute('title')).toBe('モデル: A')
    expect(buttons[1]!.hasAttribute('title')).toBe(false)
  })
})
