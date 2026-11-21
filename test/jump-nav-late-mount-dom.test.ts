// @vitest-environment jsdom
/**
 * TODO 1137: .thread-body is not drawn in an empty pane and appears later. A ResizeObserver must be attached to that element
 * (without it, the scroll-to-bottom after answering a question or plan, and JumpNav's re-measuring, do not work).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useJumpNav } from '../src/renderer/src/components/JumpNav.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const observed: Element[] = []
class FakeRO {
  observe(el: Element): void {
    observed.push(el)
  }
  disconnect(): void {}
  unobserve(): void {}
}

let root: Root
let host: HTMLDivElement
let showBody: (v: boolean) => void = () => undefined

function Harness() {
  const [shown, setShown] = useState(false)
  showBody = setShown
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  useJumpNav(ref, [], null, () => undefined, el)
  return shown
    ? createElement('div', {
        id: 'body',
        ref: (e: HTMLDivElement | null) => {
          ref.current = e
          setEl(e)
        }
      })
    : null
}

beforeEach(() => {
  observed.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useJumpNav ResizeObserver (TODO 1137)', () => {
  it('mounts empty, and observes the element when it appears later', () => {
    act(() => root.render(createElement(Harness)))
    expect(observed).toHaveLength(0)
    act(() => showBody(true))
    expect(observed.map((e) => e.id)).toEqual(['body'])
  })
})
