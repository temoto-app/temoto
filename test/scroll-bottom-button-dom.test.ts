// @vitest-environment jsdom
/**
 * TODO 552 (wave 27 bundle D): the round "↓ to the bottom" button (`ScrollBottomButton`). It shows only when away from the very bottom,
 * and when pressed it calls `jumpLast` (places it at the bottom and re-establishes `pinned`). If the highlight of in-conversation search remains, it is cleared first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScrollBottomButton } from '../src/renderer/src/components/ScrollBottomButton.js'
import { useJumpNav } from '../src/renderer/src/components/JumpNav.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  useLocale.setState({ resolved: 'ja' })
  useThreads.setState({ highlightEventId: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ScrollBottomButton', () => {
  it('shows nothing when visible is false', () => {
    act(() => root.render(createElement(ScrollBottomButton, { visible: false, onJump: () => {} })))
    expect(host.querySelector('.scroll-bottom-button')).toBeNull()
  })

  it('when shown it is a round button with an aria-label. Pressing it calls onJump and clears the search highlight', () => {
    const onJump = vi.fn()
    useThreads.setState({ highlightEventId: 'e1' })
    act(() => root.render(createElement(ScrollBottomButton, { visible: true, onJump })))
    const button = host.querySelector<HTMLButtonElement>('button.scroll-bottom-button')!
    expect(button.getAttribute('aria-label')).toBe('一番下へ')
    // The OS title is not used (items 320 / 354, the speech bubble).
    expect(button.hasAttribute('title')).toBe(false)
    act(() => button.click())
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(useThreads.getState().highlightEventId).toBeNull()
  })

  it('connected to jumpLast of useJumpNav, it moves to the bottom and re-establishes pinned (resumes following during an answer)', () => {
    const pinnedLog: boolean[] = []
    let box: HTMLDivElement | null = null
    function Harness(): React.JSX.Element {
      const ref = useRef<HTMLDivElement | null>(null)
      const [pinned, setPinned] = useState(false)
      const jump = useJumpNav(ref, [], null, (atBottom) => {
        pinnedLog.push(atBottom)
        setPinned(atBottom)
      })
      return createElement(
        'div',
        null,
        createElement('div', {
          className: 'thread-body',
          ref: (el: HTMLDivElement | null) => {
            ref.current = el
            if (el !== null && box === null) {
              box = el
              Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 5000 })
              Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 })
            }
          }
        }),
        createElement(ScrollBottomButton, { visible: !pinned, onJump: jump.jumpLast })
      )
    }
    act(() => root.render(createElement(Harness)))
    box!.scrollTop = 100
    const button = host.querySelector<HTMLButtonElement>('button.scroll-bottom-button')!
    act(() => button.click())
    expect(box!.scrollTop).toBe(5000)
    expect(pinnedLog).toEqual([true])
    // It is back at the bottom, so it disappears.
    expect(host.querySelector('.scroll-bottom-button')).toBeNull()
  })
})

describe('placement (source)', () => {
  it('ThreadPane shows it right after JumpNav (outside .thread-body) when !pinned', () => {
    const pane = readFileSync(join(__dirname, '..', 'src/renderer/src/components/ThreadPane.tsx'), 'utf8')
    expect(pane).toContain('<ScrollBottomButton visible={!pinned} onJump={jump.jumpLast} />')
    expect(pane.indexOf('<JumpNav handle={jump} />')).toBeLessThan(pane.indexOf('<ScrollBottomButton'))
  })
})
